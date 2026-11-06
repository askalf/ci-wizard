import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allSteps, category, categoryOf, concurrencyGroupOf, parseWorkflow, programWords, pushBranchesOf, shellCommands, stepCommands, triggersOf, withParseCache, workflowFacts } from '../src/workflow.mjs';

const WF = `name: CI
on:
  push:
    branches: [main, 'feat/*']
  pull_request:
  workflow_dispatch:
concurrency:
  group: ci-\${{ github.event.number || github.sha }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: |
          echo preparing
          npm install --ignore-scripts
      - run: npm test
`;

test('category: by name, with "Post " steps counted as what they post for', () => {
  assert.equal(category('Set up job'), 'overhead');
  assert.equal(category('Run actions/checkout@v4'), 'checkout');
  assert.equal(category('Post Run actions/checkout@v4'), 'checkout');
  assert.equal(category('Run actions/setup-node@v4'), 'toolchain');
  assert.equal(category('npm ci'), 'deps');
  assert.equal(category('Restore cache'), 'cache');
  assert.equal(category('Run actions/upload-artifact@v4'), 'artifacts');
  assert.equal(category('Build docker image'), 'docker');
  assert.equal(category('Run tests'), 'work');
});

test('stepCommands names unnamed steps the way GitHub does', () => {
  const m = stepCommands(parseWorkflow(WF));
  assert.equal(m.get('Run actions/checkout@v4'), 'actions/checkout@v4');
  assert.equal(m.get('Run npm test'), 'npm test');
  assert.match(m.get('Install'), /npm install/);
});

test('categoryOf: a multi-line run that installs dependencies on any line counts as dependencies', () => {
  const m = stepCommands(parseWorkflow(WF));
  assert.equal(categoryOf('Install', m), 'deps');
  assert.equal(categoryOf('Run npm test', m), 'work');
  assert.equal(categoryOf('Install', new Map()), 'work');
});

test('triggers, push branches and the concurrency group', () => {
  const d = parseWorkflow(WF);
  assert.deepEqual(triggersOf(d), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(pushBranchesOf(d), ['main', 'feat/*']);
  assert.equal(concurrencyGroupOf(d), 'ci-${{ github.event.number || github.sha }}');
  assert.deepEqual(triggersOf(parseWorkflow('on: [push, pull_request]\n')), ['pull_request', 'push']);
  assert.deepEqual(triggersOf(parseWorkflow('on: push\n')), ['push']);
  assert.equal(concurrencyGroupOf(parseWorkflow('concurrency: deploy\n')), 'deploy');
});

test('a file that does not parse yields no facts, never an error', () => {
  const d = parseWorkflow('on: [push\njobs: {');
  assert.deepEqual(d, {});
  assert.deepEqual(triggersOf(d), []);
  assert.equal(stepCommands(d).size, 0);
});

test('a job whose steps are not a list has no steps, and does not stop the rest of the file', () => {
  const doc = parseWorkflow(['jobs:', '  odd:', '    steps:', '      a: 1', '  count:', '    steps: 3', '  fine:', '    steps:', '      - run: npm ci', ''].join(String.fromCharCode(10)));
  assert.deepEqual([...stepCommands(doc).values()], ['npm ci']);
  assert.equal(workflowFacts(doc).npmInstallNoCi, false);
  assert.equal(allSteps(doc).length, 1);
});

test('a file whose top level is a list or a scalar is not a workflow, and yields no facts', () => {
  for (const text of ['[]', '- a\n- b', 'just text', '3']) assert.deepEqual(parseWorkflow(text), {}, text);
});

test('an audit parses each distinct file once, however many, and keeps nothing after it', () => {
  const texts = Array.from({ length: 600 }, (_, i) => `on: push\njobs:\n  j${i}:\n    runs-on: ubuntu-latest\n`);
  withParseCache(() => {
    const first = texts.map((t) => parseWorkflow(t));
    const again = texts.map((t) => parseWorkflow(t));
    assert.ok(first.every((d, i) => d === again[i]), 'every file is parsed once in the audit, past 512 files');
    assert.equal(withParseCache(() => parseWorkflow(texts[0])), first[0], 'a nested audit shares the cache');
  });
  assert.notEqual(parseWorkflow(texts[0]), parseWorkflow(texts[0]), 'outside an audit nothing is kept');
});

test('shell commands: split outside quotes, without comments or here-document bodies', () => {
  assert.deepEqual(shellCommands('echo "a; b" && make test | tee log # make deploy\nnpm ci'), [['echo', 'a; b'], ['make', 'test'], ['tee', 'log'], ['npm', 'ci']]);
  assert.deepEqual(shellCommands("cat <<-'EOF' > f\n\tsemgrep ci\n\tEOF\nmake"), [['cat', '>', 'f'], ['make']]);
  assert.deepEqual(shellCommands('codeql database create \\\n  db'), [['codeql', 'database', 'create', 'db']]);
  assert.deepEqual(shellCommands('x=$(semgrep scan)'), [['x=$'], ['semgrep', 'scan']]);
  assert.deepEqual(shellCommands('echo "unterminated'), [['echo', 'unterminated']]);
  assert.deepEqual(programWords(['FOO=1', 'sudo', '-E', '/usr/bin/semgrep', 'ci']), ['semgrep', 'ci']);
  assert.deepEqual(programWords(['make', '-j4']), ['make', '-j4']);
  assert.deepEqual(programWords(['A=1']), []);
  // Reserved words that open a compound command are not the program.
  assert.deepEqual(shellCommands('if true; then semgrep ci; fi').map(programWords), [['true'], ['semgrep', 'ci'], ['fi']]);
  assert.deepEqual(programWords(['!', 'grep', '-q', 'x']), ['grep', '-q', 'x']);
  // A here-document ends only at its exact delimiter: trailing space does not end it, and only
  // <<- strips leading tabs.
  assert.deepEqual(shellCommands("cat <<'EOF'\nEOF \nsemgrep ci\nEOF\nmake"), [['cat'], ['make']]);
  assert.deepEqual(shellCommands('cat <<EOF\n\tEOF\nsemgrep ci\nEOF\nmake'), [['cat'], ['make']]);
  assert.deepEqual(shellCommands('cat <<-EOF\n\tEOF\nmake'), [['cat'], ['make']]);
  // The delimiter is the whole shell word, quoted punctuation and escapes included.
  assert.deepEqual(shellCommands("cat <<'END-TEXT'\nsemgrep ci\nEND-TEXT\nmake"), [['cat'], ['make']]);
  assert.deepEqual(shellCommands('cat <<"a b"\nsemgrep ci\na b\nmake'), [['cat'], ['make']]);
  assert.deepEqual(shellCommands('cat << E\\OF > f\nsemgrep ci\nEOF\nmake'), [['cat', '>', 'f'], ['make']]);
  assert.deepEqual(shellCommands('cat <<END.txt\nsemgrep ci\nEND.txt\nmake'), [['cat'], ['make']]);
  // An empty quoted delimiter: the first empty line ends the here-document.
  assert.deepEqual(shellCommands("cat <<''\nsemgrep ci\n\nmake"), [['cat'], ['make']]);
  // A here-string is not a here-document: the next line is a command.
  assert.deepEqual(shellCommands('cat <<< "hello"\nsemgrep ci'), [['cat', 'hello'], ['semgrep', 'ci']]);
  // A shift in arithmetic is not a here-document either.
  assert.deepEqual(shellCommands('x=$((1 << 2))\nsemgrep ci'), [['x=$((1 << 2))'], ['semgrep', 'ci']]);
  assert.deepEqual(shellCommands('(( n << 1 ))\nsemgrep ci'), [['(( n << 1 ))'], ['semgrep', 'ci']]);
});
