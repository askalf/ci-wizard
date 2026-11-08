// The two rules that would remove a step: the same test step twice, and an artifact of a file
// another step already published. The file picks the candidates and must leave alone everything
// it can tell apart (every case the review of ci-wizard#33 raised, issue #34); the newest sampled
// run's record confirms them: the steps' logs list the same tests, the artifact holds the one
// file. Without that record neither rule says anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../src/analyse.mjs';
import { artifactNameOf, duplicateUploads, onlyCommand, repeatedTests, sameTests, signaturesOf, stepSections, survivesFailure, testSignature } from '../src/trim.mjs';
import { parseWorkflow } from '../src/workflow.mjs';
import { data, find, job, runs } from './helpers.mjs';
import { parse as parseYaml } from 'yaml';

const audit = (workflows, o = {}) => analyse('owner/repo', data({ workflows, ...o }));
const doc = (text) => parseWorkflow(text);
const brief = (r) => [r.scope, r.jobs, r.steps];

// A job log as the API serves it: a timestamp before every line, colour codes in the runner's
// own lines, a `##[group]Run <header>` line opening each step.
const STAMP = '2026-11-08T04:50:39.0374953Z ';
const tap = (names) => [...names.map((n, i) => `${STAMP}ok ${i + 1} - ${n}`), `${STAMP}# tests ${names.length}`, `${STAMP}# pass ${names.length}`, `${STAMP}# fail 0`].join('\n');
const log = (sections) => sections.map(([header, body]) => `${STAMP}##[group]Run ${header}\n${STAMP}\u001b[36;1m${header}\u001b[0m\n${STAMP}##[endgroup]\n${body}`).join('\n');
const A = ['the client records the limit', 'a stop near the limit names the budget', 'collect reads the pages together'];
const B = ['the client records the limit', 'a stop near the limit names the budget', 'another test entirely'];

test('stepSections: a log splits at the runner\'s step headers, timestamps and colour stripped; a uses step opens a section too', () => {
  const s = stepSections(log([['actions/checkout@v4', `${STAMP}Syncing repository`], ['npm test', tap(A)]]));
  assert.deepEqual(s.map((x) => x.header), ['actions/checkout@v4', 'npm test']);
  assert.match(s[0].text, /Syncing repository/);
  assert.ok(!/\u001b|2026-11-08T/.test(s[1].text), 'no colour code and no timestamp survives');
  assert.deepEqual(stepSections('no header at all\njust lines'), []);
});

test('testSignature: the tests by name where the runner lists them (TAP, go -v, pytest -v, a tick), else the last summary count, else null', () => {
  assert.deepEqual(testSignature(stepSections(log([['npm test', tap(A)]]))[0].text), { names: A, count: 3 });
  assert.deepEqual(testSignature('ok 1 - kept\nok 2 - skipped one # SKIP no database\nnot ok 3 - failing'), { names: ['kept', 'skipped one', 'failing'], count: 3 });
  assert.deepEqual(testSignature('=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\nok  \tpkg\t0.1s'), { names: ['TestA', 'TestB'], count: 2 });
  assert.deepEqual(testSignature('tests/test_a.py::test_one PASSED\ntests/test_a.py::test_two FAILED\n===== 1 passed, 1 failed in 0.3s ====='), { names: ['tests/test_a.py::test_one', 'tests/test_a.py::test_two'], count: 2 });
  assert.deepEqual(testSignature('  ✓ adds (3 ms)\n  ✓ subtracts\nTests:       2 passed, 2 total'), { names: ['adds', 'subtracts'], count: 2 });
  // Counts alone, from the last summary line: pytest, jest, vitest, mocha, cargo (passed and failed), maven's total, phpunit, rspec, dotnet.
  assert.deepEqual(testSignature('............\n===== 12 passed in 0.3s ====='), { names: null, count: 12 });
  assert.deepEqual(testSignature('Tests:       1 failed, 11 passed, 12 total'), { names: null, count: 12 });
  assert.deepEqual(testSignature(' Tests  12 passed (12)'), { names: null, count: 12 });
  assert.deepEqual(testSignature('  12 passing (40ms)'), { names: null, count: 12 });
  // cargo prints one summary per test binary and one for the doctests, no total: they add up, so two
  // sections that differ in an earlier binary and share the last line differ.
  assert.deepEqual(testSignature('test result: ok. 10 passed; 0 failed; 0 ignored\ntest result: ok. 5 passed; 1 failed; 0 ignored\ntest result: ok. 1 passed; 0 failed; 0 ignored'), { names: null, count: 17 });
  assert.deepEqual(sameTests(testSignature('test result: ok. 10 passed; 0 failed\ntest result: ok. 1 passed; 0 failed'), testSignature('test result: ok. 20 passed; 0 failed\ntest result: ok. 1 passed; 0 failed')), { same: false, by: 'count', count: 11 });
  assert.deepEqual(testSignature('[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in com.Foo\n[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0'), { names: null, count: 12 });
  assert.deepEqual(testSignature('===== 1 passed, 1 failed, 2 skipped, 3 warnings in 0.3s ====='), { names: null, count: 4 });
  // Two totals in one section are two suites, and a total beside per-unit lines is no one count: unknown.
  assert.equal(testSignature('Tests:       2 passed, 2 total\nTests:       3 passed, 3 total'), null);
  assert.equal(testSignature('# tests 4\ntest result: ok. 2 passed; 0 failed'), null);
  assert.deepEqual(testSignature('OK (12 tests, 30 assertions)'), { names: null, count: 12 });
  assert.deepEqual(testSignature('12 examples, 0 failures'), { names: null, count: 12 });
  assert.deepEqual(testSignature('Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12, Duration: 1 s'), { names: null, count: 12 });
  assert.equal(testSignature('npm ci\nadded 2 packages\n> build\nesbuild done'), null);
  assert.equal(testSignature('===== 0 passed in 0.1s ====='), null, 'a run of nothing establishes nothing');
});

test('sameTests: by name when both list names, in any order; by count when both only count; null when either shows neither', () => {
  assert.deepEqual(sameTests({ names: A, count: 3 }, { names: [...A].reverse(), count: 3 }), { same: true, by: 'name', count: 3 });
  assert.deepEqual(sameTests({ names: A, count: 3 }, { names: B, count: 3 }), { same: false, by: 'name', count: 3 });
  assert.deepEqual(sameTests({ names: A, count: 3 }, { names: [...A, A[0]], count: 4 }), { same: false, by: 'name', count: 3 }, 'a name listed twice is one more test');
  assert.deepEqual(sameTests({ names: null, count: 12 }, { names: null, count: 12 }), { same: true, by: 'count', count: 12 });
  assert.deepEqual(sameTests({ names: A, count: 3 }, { names: null, count: 3 }), { same: true, by: 'count', count: 3 }, 'one side without names compares by count');
  assert.equal(sameTests({ names: null, count: 12 }, null), null);
});

test('signaturesOf: the k-th step with a header takes the k-th section it opens; a header count the file does not have, or a step without a header, reads nothing', () => {
  const text = log([['actions/checkout@v4', ''], ['npm test', tap(A)], ['npm test', tap(B)]]);
  const [first, second] = signaturesOf(text, ['npm test', 'npm test']);
  assert.deepEqual(first.names, A);
  assert.deepEqual(second.names, B);
  assert.equal(signaturesOf(text, ['npm test']), null, 'one step in the file, two sections in the log: a forged header or a step the file does not show');
  assert.equal(signaturesOf(text, ['npm test', 'npm test', 'npm test']), null);
  assert.equal(signaturesOf(text, ['pytest tests']), null, 'no such section');
  assert.equal(signaturesOf(text, [null]), null);
  // A step's own output that prints a header line opens a section the file does not have.
  const forged = log([['npm test', `${tap(A)}\n${STAMP}##[group]Run npm test\n${tap(A)}`]]);
  assert.equal(signaturesOf(forged, ['npm test']), null);
});

test('repeatedTests: the same one-command test step twice, in one job or in two jobs alike in every way the file shows, with each step\'s log header', () => {
  const same = doc(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Unit tests
        run: npm test
      - name: Again
        run: npm test -- --silent
`);
  assert.deepEqual(repeatedTests(same), [{ scope: 'job', jobs: ['test'], steps: ['Unit tests', 'Again'], headers: ['npm test', 'npm test -- --silent'], shared: [false, false], command: 'npm test', script: 'npm test' }]);
  const across = doc(`on: push
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: pytest tests
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: pytest -q tests
`);
  assert.deepEqual(repeatedTests(across), [{ scope: 'workflow', jobs: ['unit', 'coverage'], steps: ['Run pytest tests', 'Run pytest -q tests'], headers: ['pytest tests', 'pytest -q tests'], shared: [false, false], command: 'pytest tests', script: 'pytest tests' }]);
  // A multi-line script's header is its first line, an aside included.
  const aside = repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          set -euo pipefail\n          npm test\n      - run: npm test\n'));
  assert.deepEqual(aside.map((r) => r.headers), [['set -euo pipefail', 'npm test']]);
  assert.equal(onlyCommand('set -euo pipefail\nnpm test -- --silent', 'npm test'), true);
  assert.equal(onlyCommand('set -o pipefail\nset +x\nnpm test', 'npm test'), true);
  // `set --` assigns the positional parameters the test command reads: not an aside, and a bare `set` is not either.
  assert.equal(onlyCommand('set -- --base-url=https://staging.example\npytest "$@"', 'pytest "$@"'), false);
  assert.equal(onlyCommand('set\nnpm test', 'npm test'), false);
  // A command or process substitution runs a command of its own, wherever it sits.
  assert.equal(onlyCommand('echo "$(cp fixtures/postgres.conf backend.conf)"\nnpm test', 'npm test'), false);
  assert.equal(onlyCommand('echo `cp fixtures/postgres.conf backend.conf`\nnpm test', 'npm test'), false);
  assert.equal(onlyCommand('npm test <(cat args)', 'npm test <(cat args)'), false);
  // An expression in a step's env, directory, shell or condition reads alike on two steps and can resolve apart once the first has run.
  const seeded = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - id: first\n        run: npm test\n        env:\n          SEED: ${{ steps.first.outputs.seed || \'initial\' }}\n      - run: npm test\n        env:\n          SEED: ${{ steps.first.outputs.seed || \'initial\' }}\n';
  assert.deepEqual(repeatedTests(doc(seeded)), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n        working-directory: ${{ env.DIR }}\n      - run: npm test\n        working-directory: ${{ env.DIR }}\n')), []);
  const seedSteps = [['Set up job', 1], ['Run npm test', 30], ['Run npm test', 30], ['Complete job', 0]];
  const seedLog = log([['npm test', tap(A)], ['npm test', tap(A)]]);
  const sd = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: seedSteps }), name: 't', log_text: seedLog }]], file: seeded }]);
  assert.equal(find(sd, 'tests run twice').length, 0, 'identical listings under a seed the first run published are two results');
  // Quotes decide whether a brace, glob or tilde expands: two files against one file named test/{a,b}.mjs.
  assert.equal(onlyCommand("node --test 'test/{a,b}.mjs'", 'node --test test/{a,b}.mjs'), false);
  assert.equal(onlyCommand('node --test "test/*.mjs"', 'node --test test/*.mjs'), false);
  assert.equal(onlyCommand('node --test test/{a,b}.mjs', 'node --test test/{a,b}.mjs'), true, 'unquoted, the words are the shell\'s own');
  // A backslash escapes the brace the same way, and is gone from the words too.
  assert.equal(onlyCommand('node --test test/\\{a,b\\}.mjs', 'node --test test/{a,b}.mjs'), false);
  // Inside double quotes a backslash escapes, inside single quotes it is a character: "test/a\\b.mjs" and 'test/a\\b.mjs' are two files whose words read alike, so any backslash disqualifies the script.
  assert.equal(onlyCommand('node --test test/a\\ b.mjs', 'node --test test/a b.mjs'), false);
  assert.equal(onlyCommand('node --test "test/a\\\\b.mjs"', 'node --test test/a\\\\b.mjs'), false);
  assert.equal(onlyCommand("node --test 'test/a\\\\b.mjs'", 'node --test test/a\\\\b.mjs'), false);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test "test/a\\\\b.mjs"\n      - run: node --test \'test/a\\\\b.mjs\'\n')), []);
  const escaped = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test test/{a,b}.mjs\n      - run: node --test test/\\{a,b\\}.mjs\n';
  assert.deepEqual(repeatedTests(doc(escaped)), []);
  const eSteps = [['Set up job', 1], ['Run node --test test/{a,b}.mjs', 30], ['Run node --test test/\\{a,b\\}.mjs', 30], ['Complete job', 0]];
  const eLog = log([['node --test test/{a,b}.mjs', tap(['A', 'B'])], ['node --test test/\\{a,b\\}.mjs', tap(['A', 'B'])]]);
  const ee = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: eSteps }), name: 't', log_text: eLog }]], file: escaped }]);
  assert.equal(find(ee, 'tests run twice').length, 0);
  assert.equal(onlyCommand('node --test "test/a b.mjs"', 'node --test test/a b.mjs'), true, 'quoted without an expanding character: the boundary is the only effect, and the key keeps it');
  const braces = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test test/{a,b}.mjs\n      - run: node --test \'test/{a,b}.mjs\'\n';
  assert.deepEqual(repeatedTests(doc(braces)), []);
  const bSteps = [['Set up job', 1], ['Run node --test test/{a,b}.mjs', 30], ["Run node --test 'test/{a,b}.mjs'", 30], ['Complete job', 0]];
  const bLog = log([['node --test test/{a,b}.mjs', tap(['A', 'B'])], ["node --test 'test/{a,b}.mjs'", tap(['A', 'B'])]]);
  const bb = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: bSteps }), name: 't', log_text: bLog }]], file: braces }]);
  assert.equal(find(bb, 'tests run twice').length, 0);
  // A `$` anywhere: quotes are gone by the time the words compare, so '$FILE' (a file of that name) and "$FILE" (the file FILE names) would read alike.
  assert.equal(onlyCommand("node --test '$FILE'", "node --test $FILE"), false);
  assert.equal(onlyCommand('node --test "$FILE"', 'node --test $FILE'), false);
  const dollar = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    env:\n      FILE: other.mjs\n    steps:\n      - run: node --test \'$FILE\'\n      - run: node --test "$FILE"\n';
  assert.deepEqual(repeatedTests(doc(dollar)), []);
  const dSteps = [['Set up job', 1], ["Run node --test '$FILE'", 30], ['Run node --test "$FILE"', 30], ['Complete job', 0]];
  const dLog = log([["node --test '$FILE'", tap(['A', 'B'])], ['node --test "$FILE"', tap(['A', 'B'])]]);
  const dd = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: dSteps }), name: 't', log_text: dLog }]], file: dollar }]);
  assert.equal(find(dd, 'tests run twice').length, 0);
  // `set` options that change what the tests receive are not asides: -f turns globbing off.
  assert.equal(onlyCommand('set -f\nnode --test test/*.mjs', 'node --test test/*.mjs'), false);
  assert.equal(onlyCommand('set -o noglob\nnpm test', 'npm test'), false);
  assert.equal(onlyCommand('set -o\nnpm test', 'npm test'), false);
  assert.equal(onlyCommand('set -eu\nset -o pipefail\nset +x\nnpm test', 'npm test'), true);
  // A quoted argument keeps its boundary: one file named "test/a b.mjs" against the two files test/a and b.mjs.
  const quoted = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test "test/a b.mjs"\n      - run: node --test test/a b.mjs\n';
  assert.deepEqual(repeatedTests(doc(quoted)), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test "test/a b.mjs"\n      - run: node --test \'test/a b.mjs\'\n')).map(brief), [['job', ['t'], ['Run node --test "test/a b.mjs"', "Run node --test 'test/a b.mjs'"]]], 'the same one file, quoted either way');
  const qSteps = [['Set up job', 1], ['Run node --test "test/a b.mjs"', 30], ['Run node --test test/a b.mjs', 30], ['Complete job', 0]];
  const qLog = log([['node --test "test/a b.mjs"', tap(['A', 'B'])], ['node --test test/a b.mjs', tap(['A', 'B'])]]);
  const q = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: qSteps }), name: 't', log_text: qLog }]], file: quoted }]);
  assert.equal(find(q, 'tests run twice').length, 0, 'the same names from different files are two results');
  // The example repeats the step's script as written: the quoted file name stays one argument.
  const sameQuoted = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: A\n        run: node --test "test/a b.mjs"\n      - name: B\n        run: |\n          set -e\n          node --test "test/a b.mjs"\n';
  const sqSteps = [['Set up job', 1], ['A', 30], ['B', 30], ['Complete job', 0]];
  const sqLog = log([['node --test "test/a b.mjs"', tap(['A', 'B'])], ['set -e', tap(['A', 'B'])]]);
  const sq = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: sqSteps }), name: 't', log_text: sqLog }]], file: sameQuoted }]);
  const [sqf] = find(sq, 'tests run twice');
  assert.ok(sqf, JSON.stringify(sq.findings.map((x) => x.what)));
  assert.match(sqf.example, /\n  run: \|\n    node --test "test\/a b.mjs"$/, 'always a block scalar, the script as written');
  assert.match(sqf.evidence, /`node --test test\/a b.mjs`/, 'the label is the command as a line');
  // A multi-line script is repeated as a block.
  const multi = sameQuoted.replace('      - name: A\n        run: node --test "test/a b.mjs"\n', '      - name: A\n        run: |\n          set -e\n          node --test "test/a b.mjs"\n');
  const mLog = log([['set -e', tap(['A', 'B'])], ['set -e', tap(['A', 'B'])]]);
  const [mf] = find(audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: sqSteps }), name: 't', log_text: mLog }]], file: multi }]), 'tests run twice');
  assert.match(mf.example, /\n  run: \|\n    set -e\n    node --test "test\/a b.mjs"$/);
  // The example parses as workflow YAML and gives the script back, a colon and space in a file name included.
  const colon = multi.replace(/test\/a b\.mjs/g, 'test/a: b.mjs');
  const [cf] = find(audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: sqSteps }), name: 't', log_text: mLog }]], file: colon }]), 'tests run twice');
  assert.ok(cf, 'a colon in the file name is no obstacle to the match');
  const parsed = parseYaml(cf.example);
  assert.equal(parsed[0].run, 'set -e\nnode --test "test/a: b.mjs"\n');
  assert.equal(parsed[0].if, "github.event_name == 'push' && github.ref == 'refs/heads/<default branch>'");
  // An expansion in an aside can assign: `${BACKEND:=postgres}` sets what the tests then read, so an aside carries no `$`.
  assert.equal(onlyCommand('echo "${BACKEND:=postgres}"\nnpm test -- --backend "$BACKEND"', 'npm test -- --backend "$BACKEND"'), false);
  assert.equal(onlyCommand('echo "$HOME"\nnpm test', 'npm test'), false);
  const assigning = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo "${BACKEND:=sqlite}"\n          npm test -- --backend "$BACKEND"\n      - run: |\n          echo "${BACKEND:=postgres}"\n          npm test -- --backend "$BACKEND"\n';
  assert.deepEqual(repeatedTests(doc(assigning)), []);
  const asSteps = [['Set up job', 1], ['Run echo "${BACKEND:=sqlite}"', 30], ['Run echo "${BACKEND:=postgres}"', 30], ['Complete job', 0]];
  const asLog = log([['echo "${BACKEND:=sqlite}"', tap(A)], ['echo "${BACKEND:=postgres}"', tap(A)]]);
  const g = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: asSteps }), name: 't', log_text: asLog }]], file: assigning }]);
  assert.equal(find(g, 'tests run twice').length, 0, 'identical listings against two assigned backends are two results');
  // An input redirection of any kind feeds the tests: a here-document, a here-string, a file.
  assert.equal(onlyCommand('npm test <<EOF\nsqlite\nEOF', 'npm test'), false);
  assert.equal(onlyCommand('npm test <<< postgres', 'npm test'), false);
  assert.equal(onlyCommand('npm test < backend.conf', 'npm test'), false);
  const heredoc = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          npm test <<EOF\n          sqlite\n          EOF\n      - run: |\n          npm test <<EOF\n          postgres\n          EOF\n';
  assert.deepEqual(repeatedTests(doc(heredoc)), []);
  const hdSteps = [['Set up job', 1], ['Run npm test <<EOF', 30], ['Run npm test <<EOF', 30], ['Complete job', 0]];
  const hdLog = log([['npm test <<EOF', tap(A)], ['npm test <<EOF', tap(A)]]);
  const h = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: hdSteps }), name: 't', log_text: hdLog }]], file: heredoc }]);
  assert.equal(find(h, 'tests run twice').length, 0, 'identical listings fed two inputs are two results');
  const substituted = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo "$(cp fixtures/sqlite.conf backend.conf)"\n          npm test\n      - run: |\n          echo "$(cp fixtures/postgres.conf backend.conf)"\n          npm test\n';
  assert.deepEqual(repeatedTests(doc(substituted)), []);
  const subSteps = [['Set up job', 1], ['Run echo "$(cp fixtures/sqlite.conf backend.conf)"', 30], ['Run echo "$(cp fixtures/postgres.conf backend.conf)"', 30], ['Complete job', 0]];
  const subLog = log([['echo "$(cp fixtures/sqlite.conf backend.conf)"', tap(A)], ['echo "$(cp fixtures/postgres.conf backend.conf)"', tap(A)]]);
  const s = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: subSteps }), name: 't', log_text: subLog }]], file: substituted }]);
  assert.equal(find(s, 'tests run twice').length, 0, 'identical listings against two backends are two results');
  assert.equal(onlyCommand('set -e --\nnpm test', 'npm test'), false);
  const positional = doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          set -- --base-url=https://staging.example\n          pytest "$@"\n      - run: |\n          set -- --base-url=https://production.example\n          pytest "$@"\n');
  assert.deepEqual(repeatedTests(positional), []);
  const setSteps = [['Set up job', 1], ['Run set -- --base-url=https://staging.example', 30], ['Run set -- --base-url=https://production.example', 30], ['Complete job', 0]];
  const setLog = log([['set -- --base-url=https://staging.example', tap(A)], ['set -- --base-url=https://production.example', tap(A)]]);
  const e = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: setSteps }), name: 't', log_text: setLog }]], file: 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          set -- --base-url=https://staging.example\n          pytest "$@"\n      - run: |\n          set -- --base-url=https://production.example\n          pytest "$@"\n' }]);
  assert.equal(find(e, 'tests run twice').length, 0, 'identical listings against two endpoints are two results');
  assert.equal(onlyCommand('cd pkg\nnpm test', 'npm test'), false); // a cd moves the tests: not the same step
  assert.equal(onlyCommand('export DB_BACKEND=sqlite\nnpm test', 'npm test'), false); // an export changes their environment
  assert.equal(onlyCommand('echo postgres > backend.conf\nnpm test', 'npm test'), false); // a redirection writes a file
  assert.equal(onlyCommand('echo "starting" | tee log.txt\nnpm test', 'npm test'), false);
  assert.equal(onlyCommand('echo "starting the tests"\nnpm test', 'npm test'), true);
  assert.equal(onlyCommand('npm test\nnpm run build', 'npm test'), false);
  assert.equal(onlyCommand('npm test\npytest tests/a', 'npm test'), false); // another suite is work that stays
  assert.equal(onlyCommand('npm run build', 'npm test'), false);
});

test('repeatedTests: what the file can tell apart is no candidate: other paths, another directory, a cd, another environment, a build beside, a matrix, two platforms, a condition', () => {
  // The same runner on other paths, or after an export and a cd: two suites as far as the file can tell.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test a/*.test.mjs b/*.test.mjs\n      - run: node --test a/*.test.mjs\n')), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test a/*.test.mjs\n      - run: |\n          node tools/export.mjs out\n          cd out\n          node --test a/*.test.mjs\n')), []);
  // The same cd before the test and after it are two directories; two cds anywhere are no repeat.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          npm test\n          cd packages/backend\n      - run: |\n          cd packages/backend\n          npm test\n')), []);
  // Another environment is another result: a step env, a job env, a service.
  const envs = doc(`on: push
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        env:
          DB_BACKEND: sqlite
      - run: npm test
        env:
          DB_BACKEND: postgres
  a:
    runs-on: ubuntu-latest
    env:
      DB_BACKEND: sqlite
    steps:
      - run: npm test
  b:
    runs-on: ubuntu-latest
    env:
      DB_BACKEND: postgres
    steps:
      - run: npm test
  c:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres
    steps:
      - run: npm test
  d:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
  assert.deepEqual(repeatedTests(envs), []);
  // The environment set inside the script is an environment too; a configuration written before the tests picks what they test.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          export DB_BACKEND=sqlite\n          npm test\n      - run: |\n          export DB_BACKEND=postgres\n          npm test\n')), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo sqlite > backend.conf\n          npm test\n      - run: |\n          echo postgres > backend.conf\n          npm test\n')), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo postgres | npm test\n      - run: npm test\n')), []);
  // Two runtimes are two results, in two jobs and within one; a step between two test steps can change what the second tests.
  const runtimes = doc(`on: push
jobs:
  n20:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test
  n22:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
  same1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
  within:
    runs-on: ubuntu-latest
    steps:
      - name: A
        run: npm test
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: B
        run: npm test
      - name: C
        run: npm test
`);
  assert.deepEqual(repeatedTests(runtimes).map(brief), [['job', ['within'], ['B', 'C']], ['workflow', ['n22', 'same1'], ['Run npm test', 'Run npm test']]]);
  // Preparation that differs only in its directory, shell or inputs leads into different tests.
  const prep = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: cp backend.conf .
        working-directory: fixtures/sqlite
      - run: npm test
  b:
    runs-on: ubuntu-latest
    steps:
      - run: cp backend.conf .
        working-directory: fixtures/postgres
      - run: npm test
`);
  assert.deepEqual(repeatedTests(prep), []);
  // A build or another suite beside the tests keeps work that must stay; two scripts of one runner are two suites.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          npm test\n          npm run build:a\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          npm test\n          npm run build:b\n')), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: A\n        run: |\n          npm test\n          pytest tests\n      - name: B\n        run: npm test\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - name: C\n        run: pytest tests\n')), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run test:unit\n      - run: npm run test:e2e\n')), []);
  // One run, a matrix, two platforms.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n')), []);
  const matrix = doc(`on: push
jobs:
  t:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - run: npm test
  u:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - run: npm test
`);
  assert.deepEqual(repeatedTests(matrix), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  linux:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n  mac:\n    runs-on: macos-latest\n    steps:\n      - run: npm test\n')), []);
  // Two jobs, or two steps, that never run in the same run; under one condition they are a candidate.
  const gated = doc(`on: [push, pull_request]
jobs:
  onpush:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  onpr:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  both:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  both2:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
  assert.deepEqual(repeatedTests(gated).map((r) => r.jobs), [['both', 'both2']]);
  const gatedSteps = doc(`on: [push, pull_request]
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - name: On push
        if: github.event_name == 'push'
        run: npm test
      - name: On pull request
        if: github.event_name == 'pull_request'
        run: npm test
      - name: A
        if: github.event_name == 'push'
        run: pytest tests
      - name: B
        if: github.event_name == 'push'
        run: pytest tests
`);
  assert.deepEqual(repeatedTests(gatedSteps).map((r) => [r.steps, r.command]), [[['A', 'B'], 'pytest tests']]);
  // A monorepo: the same command in two declared directories is two suites; the same directory twice is a candidate.
  const monorepo = doc(`on: push
defaults:
  run:
    working-directory: packages
jobs:
  one:
    runs-on: ubuntu-latest
    steps:
      - name: Front
        run: npm test
        working-directory: packages/frontend
      - name: Also front
        run: npm test
        working-directory: packages/frontend
      - name: Back
        run: npm test
        working-directory: packages/backend
  two:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: packages/api
    steps:
      - run: npm test
  three:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
  assert.deepEqual(repeatedTests(monorepo).map(brief), [['job', ['one'], ['Front', 'Also front']]]);
  // Two unnamed steps with the same command share a display name and are still two runs (shared says so); a third
  // runner started twice beside them is its own candidate, and a step in one candidate is in no other.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: npm test\n')), [{ scope: 'job', jobs: ['t'], steps: ['Run npm test', 'Run npm test'], headers: ['npm test', 'npm test'], shared: [true, true], command: 'npm test', script: 'npm test' }]);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: A\n        run: npm test\n      - name: B\n        run: npm test\n      - name: C\n        run: pytest tests\n')).map(brief), [['job', ['t'], ['A', 'B']]]);
});

const twiceFile = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Unit tests
        run: npm test
      - name: Tests again
        run: npm test
`;
const TWICE = [['Set up job', 1], ['Run actions/checkout@v4', 2], ['Unit tests', 30], ['Tests again', 20], ['Complete job', 0]];
const twiceLog = (first, second) => log([['actions/checkout@v4', `${STAMP}Syncing repository`], ['npm test', first], ['npm test', second]]);
const testJob = (log_text, steps = TWICE) => ({ ...job({ steps }), name: 'test', ...(log_text === undefined ? {} : { log_text }) });

test('tests run twice: fires when the newest sampled run\'s logs list the same tests by name in both steps, measured, the shorter run the saving', () => {
  const a = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[testJob(twiceLog(tap(A), tap(A)))]], file: twiceFile }]);
  const [f] = find(a, 'tests run twice');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.equal(f.confidence, 'measured');
  assert.equal(f.saving_min_week, 10); // 20 s x 30 runs / 60
  assert.match(f.evidence, /job test runs the same test step twice, `npm test` in steps "Unit tests" and "Tests again" \(30 s and 20 s a run\); the newest sampled run's logs list the same 3 tests by name in both/);
  assert.match(f.fix, /^run the suite once/);
  assert.match(f.example, /if: github.event_name == 'push' && github.ref == 'refs\/heads\/<default branch>'/, 'the gate names the event and the branch both');
  assert.match(f.tradeoff, /flaky test/);
  assert.deepEqual(a.workflows[0].repeated_tests[0].same_tests, { same: true, by: 'name', count: 3 });
});

test('tests run twice: silent when the logs list different tests, when the log cannot be read, when the log shows no tests, and when only an older run has a log', () => {
  const differ = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[testJob(twiceLog(tap(A), tap(B)))]], file: twiceFile }]);
  assert.equal(find(differ, 'tests run twice').length, 0);
  assert.deepEqual(differ.workflows[0].repeated_tests[0].same_tests, { same: false, by: 'name', count: 3 });
  const unread = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[testJob()]], file: twiceFile }]);
  assert.equal(find(unread, 'tests run twice').length, 0);
  assert.equal(unread.workflows[0].repeated_tests[0].same_tests, null, 'the file alone is a candidate, not a finding');
  const quiet = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[testJob(twiceLog(`${STAMP}> build`, `${STAMP}> build`))]], file: twiceFile }]);
  assert.equal(find(quiet, 'tests run twice').length, 0);
  // Only the newest sampled run's log counts: an older run's is not this run's record.
  const older = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[testJob()], [testJob(twiceLog(tap(A), tap(A)))]], file: twiceFile }]);
  assert.equal(find(older, 'tests run twice').length, 0);
  // Two API jobs of one name (a job the file does not show as a matrix) are not one job's log.
  const two = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[testJob(twiceLog(tap(A), tap(A))), testJob(twiceLog(tap(A), tap(A)))]], file: twiceFile }]);
  assert.equal(find(two, 'tests run twice').length, 0);
});

test('tests run twice: by count when the runner lists no names, and the evidence says so', () => {
  const pytestFile = twiceFile.replace(/npm test/g, 'pytest tests');
  const dots = `${STAMP}............\n${STAMP}===== 12 passed in 0.3s =====`;
  const pyLog = log([['actions/checkout@v4', ''], ['pytest tests', dots], ['pytest tests', dots]]);
  const a = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[testJob(pyLog)]], file: pytestFile }]);
  const [f] = find(a, 'tests run twice');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.match(f.evidence, /report the same count, 12 tests, in both \(the runner lists no names\)/);
  const eleven = log([['actions/checkout@v4', ''], ['pytest tests', dots], ['pytest tests', `${STAMP}===== 11 passed in 0.3s =====`]]);
  assert.equal(find(audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[testJob(eleven)]], file: pytestFile }]), 'tests run twice').length, 0);
});

test('tests run twice: across two jobs, each job\'s own log and own timings; a job the sample never ran, or a step it never timed, adds nothing', () => {
  const file = `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: pytest tests
  b:
    runs-on: ubuntu-latest
    steps:
      - run: pytest tests
`;
  const section = (names) => log([['pytest tests', tap(names)]]);
  const steps = (s) => [['Set up job', 1], ['Run pytest tests', s], ['Complete job', 0]];
  const a = audit([{ name: 'CI', runs: runs(60), jobsPerRun: [[{ ...job({ steps: steps(10) }), name: 'a', log_text: section(A) }, { ...job({ steps: steps(100) }), name: 'b', log_text: section(A) }]], file }]);
  const [f] = find(a, 'tests run twice');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.equal(f.saving_min_week, 10); // the shorter, 10 s x 60 runs / 60
  assert.match(f.evidence, /jobs a and b run the same test step, `pytest tests`, on the same runner, environment and directory, after the same steps \(10 s and 100 s a run\)/);
  assert.deepEqual(a.workflows[0].repeated_tests.map((r) => [r.scope, r.jobs, r.seconds]), [['workflow', ['a', 'b'], [10, 100]]]);
  const differ = audit([{ name: 'CI', runs: runs(60), jobsPerRun: [[{ ...job({ steps: steps(10) }), name: 'a', log_text: section(A) }, { ...job({ steps: steps(100) }), name: 'b', log_text: section(B) }]], file }]);
  assert.equal(find(differ, 'tests run twice').length, 0);
  const oneLog = audit([{ name: 'CI', runs: runs(60), jobsPerRun: [[{ ...job({ steps: steps(10) }), name: 'a', log_text: section(A) }, { ...job({ steps: steps(100) }), name: 'b' }]], file }]);
  assert.equal(find(oneLog, 'tests run twice').length, 0);
  // A second step the sample never timed adds nothing to the estimate: under the floor, no finding.
  const untimed = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[testJob(twiceLog(tap(A), tap(A)), TWICE.filter(([n]) => n !== 'Tests again'))]], file: twiceFile }]);
  assert.equal(find(untimed, 'tests run twice').length, 0);
});

test('tests run twice: two steps with one display name share a timing list and are priced at its minimum', () => {
  const file = 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: npm test\n';
  const steps = [['Set up job', 1], ['Run npm test', 30], ['Run npm test', 10], ['Complete job', 0]];
  const a = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps }), name: 'test', log_text: log([['npm test', tap(A)], ['npm test', tap(A)]]) }]], file }]);
  const [f] = find(a, 'tests run twice');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.deepEqual(a.workflows[0].repeated_tests[0].seconds, [10, 10]);
  assert.equal(f.saving_min_week, 5); // 10 s x 30 runs / 60, the lower of the two shared timings
});

test('tests run twice: two jobs in two deployment environments are two results, whatever their identical logs list', () => {
  const file = `on: push
jobs:
  staging:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: npm test
        env:
          API_URL: https://api.example/v1
  production:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: npm test
        env:
          API_URL: https://api.example/v1
  again:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: npm test
        env:
          API_URL: https://api.example/v1
`;
  assert.deepEqual(repeatedTests(doc(file)).map((r) => r.jobs), [['production', 'again']], 'the same environment twice is the candidate; staging against production is not');
  const steps = [['Set up job', 1], ['Run npm test', 30], ['Complete job', 0]];
  const twoEnvs = file.replace(/\n  again:[\s\S]*$/, '\n');
  const a = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps }), name: 'staging', log_text: log([['npm test', tap(A)]]) }, { ...job({ steps }), name: 'production', log_text: log([['npm test', tap(A)]]) }]], file: twoEnvs }]);
  assert.equal(find(a, 'tests run twice').length, 0);
});

test('tests run twice: an expression in a job\'s identity reads alike in two jobs and can resolve apart, so such jobs are no cross-job candidate; one job\'s own two steps still are', () => {
  const file = `on: push
jobs:
  staging:
    runs-on: ubuntu-latest
    environment: \${{ github.job }}
    steps:
      - run: npm test
        env:
          API_URL: https://api.example/v1
  production:
    runs-on: ubuntu-latest
    environment: \${{ github.job }}
    steps:
      - run: npm test
        env:
          API_URL: https://api.example/v1
      - run: npm test
        env:
          API_URL: https://api.example/v1
`;
  assert.deepEqual(repeatedTests(doc(file)).map(brief), [['job', ['production'], ['Run npm test', 'Run npm test']]]);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  a:\n    runs-on: ${{ vars.RUNNER }}\n    steps:\n      - run: npm test\n  b:\n    runs-on: ${{ vars.RUNNER }}\n    steps:\n      - run: npm test\n')), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ github.job }} > job.txt\n      - run: npm test\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ github.job }} > job.txt\n      - run: npm test\n')), [], 'a preparation step with an expression');
  const steps = [['Set up job', 1], ['Run npm test', 30], ['Complete job', 0]];
  const twoJobs = file.replace(/\n      - run: npm test\n        env:\n          API_URL: https:\/\/api.example\/v1\n$/, '\n');
  const a = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps }), name: 'staging', log_text: log([['npm test', tap(A)]]) }, { ...job({ steps }), name: 'production', log_text: log([['npm test', tap(A)]]) }]], file: twoJobs }]);
  assert.equal(find(a, 'tests run twice').length, 0);
});

test('duplicateUploads: an artifact a download-artifact step of the workflow names is the workflow\'s transport, never a candidate; a download with no name, a pattern or an expression may take any artifact, so none is', () => {
  const producer = `on: push
jobs:
  analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
      - uses: actions/upload-artifact@v4
        with:
          name: report
          path: results.sarif
`;
  const consumer = (withBlock) => `${producer}  triage:
    runs-on: ubuntu-latest
    needs: analysis
    steps:
      - uses: actions/download-artifact@v4
${withBlock}      - run: ./triage results.sarif
`;
  assert.equal(duplicateUploads(doc(producer)).length, 1);
  assert.deepEqual(duplicateUploads(doc(consumer('        with:\n          name: report\n'))), []);
  assert.deepEqual(duplicateUploads(doc(consumer(''))), [], 'no name downloads every artifact of the run');
  assert.deepEqual(duplicateUploads(doc(consumer('        with:\n          pattern: rep*\n          merge-multiple: true\n'))), []);
  assert.deepEqual(duplicateUploads(doc(consumer('        with:\n          name: ${{ needs.analysis.outputs.artifact }}\n'))), []);
  assert.equal(duplicateUploads(doc(consumer('        with:\n          name: coverage\n'))).length, 1, 'another artifact\'s consumer leaves this one');
  // With valid single-file evidence the consumed artifact still yields no finding.
  const steps = [['Set up job', 1], ['Run github/codeql-action/upload-sarif@v3', 3], ['Run actions/upload-artifact@v4', 4], ['Complete job', 0]];
  const a = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[{ ...job({ steps }), name: 'analysis', run_artifacts: [{ name: 'report', bytes: 16334, entries: [{ name: 'results.sarif', size: 71521 }] }] }]], file: consumer('        with:\n          name: report\n') }]);
  assert.equal(find(a, 'an artifact that duplicates another upload').length, 0);
  const b = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[{ ...job({ steps }), name: 'analysis', run_artifacts: [{ name: 'report', bytes: 16334, entries: [{ name: 'results.sarif', size: 71521 }] }] }]], file: producer }]);
  const [f] = find(b, 'an artifact that duplicates another upload');
  assert.ok(f, JSON.stringify(b.findings.map((x) => x.what)));
  assert.match(f.tradeoff, /another workflow or a script fetching it by run is not visible here/);
});

test('an artifact that duplicates another upload: a step between the destination and the artifact can rewrite the file, so valid artifact evidence confirms nothing there', () => {
  const file = `on: push
jobs:
  analysis:
    runs-on: ubuntu-latest
    steps:
      - name: Upload to code scanning
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
      - name: Second scanner
        run: ./second-scanner > results.sarif
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: SARIF file
          path: results.sarif
`;
  const steps = [['Set up job', 1], ['Upload to code scanning', 3], ['Second scanner', 20], ['Upload artifact', 4], ['Complete job', 0]];
  const a = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[{ ...job({ steps }), name: 'analysis', run_artifacts: [{ name: 'SARIF file', bytes: 16334, entries: [{ name: 'results.sarif', size: 71521 }] }] }]], file }]);
  assert.equal(find(a, 'an artifact that duplicates another upload').length, 0);
  assert.deepEqual(a.workflows[0].duplicate_uploads, []);
});

test('duplicateUploads: a SARIF uploaded as an artifact and to code scanning; a release asset uploaded twice; a failure-only or globbed artifact is not a candidate', () => {
  const scorecard = doc(`on: push
jobs:
  analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: ossf/scorecard-action@v2
        with:
          results_file: results.sarif
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: SARIF file
          path: results.sarif
      - name: Upload to code scanning
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
`);
  assert.deepEqual(duplicateUploads(scorecard), [{ job: 'analysis', step: 'Upload artifact', path: 'results.sarif', name: 'SARIF file', alsoTo: ['code scanning'], after: true }]);
  const release = doc(`on: release
jobs:
  r:
    runs-on: ubuntu-latest
    steps:
      - run: tar czf dist.tar.gz dist
      - uses: actions/upload-artifact@v4
        with:
          path: ./dist.tar.gz
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            dist.tar.gz
            checksums.txt
`);
  assert.deepEqual(duplicateUploads(release), [{ job: 'r', step: 'Run actions/upload-artifact@v4', path: 'dist.tar.gz', name: 'artifact', alsoTo: ['the release'], after: true }]);
  assert.equal(artifactNameOf({ with: { name: '${{ matrix.os }}-sarif' } }), null, 'a name set by an expression is not known');
  assert.equal(artifactNameOf({ with: { name: ' report ' } }), 'report');
  // A `gh release upload` in a script never counts: the shell's path to it and its directory are not the file's to establish.
  const shell = doc(`on: release
jobs:
  r:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: dist.tar.gz
      - run: gh release upload "$TAG" dist.tar.gz --clobber
      - run: test "$GITHUB_REF_TYPE" = tag || exit 0; gh release upload "$TAG" dist.tar.gz
      - run: gh release upload v1 dist.tar.gz
        working-directory: package
`);
  assert.deepEqual(duplicateUploads(shell), []);
  // A release upload only on a tag leaves the artifact the only copy on every other run.
  const tagOnly = doc(`on: push
jobs:
  r:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: dist.tar.gz
      - uses: softprops/action-gh-release@v2
        if: startsWith(github.ref, 'refs/tags/')
        with:
          files: dist.tar.gz
`);
  assert.deepEqual(duplicateUploads(tagOnly), []);
  // A directory given to upload-sarif sends its SARIF files; the artifact keeps everything in it.
  const directory = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: reports
      - uses: actions/upload-artifact@v4
        with:
          path: reports
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: reports/
      - uses: actions/upload-artifact@v4
        with:
          path: reports/
`);
  assert.deepEqual(duplicateUploads(directory), []);
  // The same condition on both steps is not one path through the run: the same text can hold on
  // one step and turn on the next (`steps.saved.outputs.artifact-id == ''` once the artifact step
  // has published), so a conditioned artifact step is no candidate, whatever the destination says.
  const bothOnTag = doc(`on: push
jobs:
  r:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: startsWith(github.ref, 'refs/tags/')
        with:
          path: dist.tar.gz
      - uses: softprops/action-gh-release@v2
        if: startsWith(github.ref, 'refs/tags/')
        with:
          files: dist.tar.gz
`);
  assert.equal(duplicateUploads(bothOnTag).length, 0);
  const turning = `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: saved
        uses: actions/upload-artifact@v4
        if: steps.saved.outputs.artifact-id == ''
        with:
          name: SARIF file
          path: results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: steps.saved.outputs.artifact-id == ''
        with:
          sarif_file: results.sarif
`;
  assert.deepEqual(duplicateUploads(doc(turning)), []);
  const turningSteps = [['Set up job', 1], ['Run actions/upload-artifact@v4', 4], ['Run github/codeql-action/upload-sarif@v3', 0], ['Complete job', 0]];
  const t = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[{ ...job({ steps: turningSteps }), name: 'a', run_artifacts: [{ name: 'SARIF file', bytes: 16334, entries: [{ name: 'results.sarif', size: 71521 }] }] }]], file: turning }]);
  assert.equal(find(t, 'an artifact that duplicates another upload').length, 0, 'valid single-file evidence under a condition that turned confirms nothing');
  // A conditioned destination beside an unconditioned artifact step does not count either, unless it is exactly always() or !cancelled().
  const conditionedDestination = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        if: github.event_name == 'push'
        with:
          sarif_file: results.sarif
      - uses: actions/upload-artifact@v4
        with:
          path: results.sarif
`);
  assert.deepEqual(duplicateUploads(conditionedDestination), []);
  // An artifact kept after a failure beside a destination that runs on success alone: the artifact
  // is the only copy of a failed run's file. Under always() on both, the destination can fail and
  // the artifact still goes up: no candidate either.
  const afterFailure = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          path: results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          path: results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
`);
  assert.deepEqual(duplicateUploads(afterFailure), []);
  // A destination with no condition after the artifact counts only when it comes next: a step
  // between them that fails skips it, and the artifact is the only copy of that run's file. With
  // the destination first, a failure after it skips the artifact, never the destination.
  const between = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: results.sarif
      - run: exit 1
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
      - run: exit 1
      - uses: actions/upload-artifact@v4
        with:
          path: results.sarif
`);
  // In b the destination went first, but a step between them can rewrite the file (a second scanner
  // writing the same results.sarif): the artifact would then be the only copy of that report, so a
  // destination counts only next to the artifact in that direction too.
  assert.deepEqual(duplicateUploads(between), []);
  const overwritten = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
      - run: ./second-scanner > results.sarif
      - uses: actions/upload-artifact@v4
        with:
          path: results.sarif
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
      - uses: actions/upload-artifact@v4
        with:
          path: results.sarif
`);
  assert.deepEqual(duplicateUploads(overwritten).map((u) => [u.job, u.after]), [['b', false]]);
  // Matching conditions still carry the implicit success(), so a failure between them skips the
  // later destination; always() on both lets the destination fail with the artifact already up.
  const betweenGuarded = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: startsWith(github.ref, 'refs/tags/')
        with:
          path: results.sarif
      - run: exit 1
      - uses: github/codeql-action/upload-sarif@v3
        if: startsWith(github.ref, 'refs/tags/')
        with:
          sarif_file: results.sarif
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          path: results.sarif
      - run: exit 1
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
  c:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          path: results.sarif
  d:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: always() && success()
        with:
          path: results.sarif
      - run: exit 1
      - uses: github/codeql-action/upload-sarif@v3
        if: always() && success()
        with:
          sarif_file: results.sarif
  e:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        continue-on-error: true
        with:
          sarif_file: results.sarif
      - uses: actions/upload-artifact@v4
        with:
          path: results.sarif
`);
  assert.deepEqual(duplicateUploads(betweenGuarded), []);
  assert.equal(survivesFailure('always()'), true);
  assert.equal(survivesFailure('${{ !cancelled() }}'), true);
  assert.equal(survivesFailure('always() && success()'), false);
  assert.equal(survivesFailure(''), false);
});

const scorecardFile = (destinationFirst = false) => {
  const artifact = `      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: SARIF file
          path: results.sarif
`;
  const destination = `      - name: Upload to code scanning
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
`;
  return `on: push
jobs:
  analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run analysis
        run: ./scan > results.sarif
${destinationFirst ? destination + artifact : artifact + destination}`;
};
const SCORECARD = [['Set up job', 1], ['Run actions/checkout@v4', 2], ['Run analysis', 30], ['Upload artifact', 4], ['Upload to code scanning', 3], ['Complete job', 0]];
const analysisJob = (run_artifacts) => ({ ...job({ steps: SCORECARD }), name: 'analysis', ...(run_artifacts === undefined ? {} : { run_artifacts }) });
const sarif = (entries = [{ name: 'results.sarif', size: 71521 }], name = 'SARIF file') => [{ name, bytes: 16334, entries }];

test('an artifact that duplicates another upload: fires when the newest sampled run\'s artifact holds that one file, measured, the artifact step\'s time the saving, at any size', () => {
  const a = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[analysisJob(sarif())]], file: scorecardFile() }]);
  const [f] = find(a, 'an artifact that duplicates another upload');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.equal(f.confidence, 'measured');
  assert.equal(f.saving_min_week, 2); // 4 s x 30 runs / 60
  assert.match(f.evidence, /job analysis uploads results.sarif as the artifact "SARIF file" in "Upload artifact" \(4 s a run\) and sends the same file to code scanning, in a later step; the newest sampled run's artifact holds that one file \(16 KB zipped\)/);
  // The destination comes after the artifact and can fail after it went up: the fix is the order and failure(), not a deletion.
  assert.match(f.fix, /^move the artifact step after the upload it duplicates and give it `if: failure\(\)`/);
  assert.match(f.example, /if: failure\(\)/);
  assert.deepEqual(a.workflows[0].duplicate_uploads[0].artifact, { bytes: 16334, entries: 1, one_file: true });
  // At one run a week the saving is under the noise floor; a duplicate upload stays all the same.
  const rare = audit([{ name: 'Scorecard', runs: runs(1), jobsPerRun: [[analysisJob(sarif())]], file: scorecardFile() }]);
  assert.equal(find(rare, 'an artifact that duplicates another upload').length, 1);
  // The destination first: the artifact step is dropped.
  const b = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[analysisJob(sarif())]], file: scorecardFile(true) }]);
  const [g] = find(b, 'an artifact that duplicates another upload');
  assert.ok(g, JSON.stringify(b.findings.map((x) => x.what)));
  assert.match(g.fix, /^drop the artifact step/);
  assert.match(g.example, /# remove/);
  assert.ok(!/in a later step/.test(g.evidence));
  // Both examples parse as YAML and give the step name and path back, a colon and space in either included.
  const colonFile = (destinationFirst) => scorecardFile(destinationFirst).replace(/name: Upload artifact/, "name: 'Upload: report'").replace(/(path|sarif_file): results\.sarif/g, "$1: 'report: final.sarif'");
  const colonSteps = SCORECARD.map(([n, s]) => [n === 'Upload artifact' ? 'Upload: report' : n, s]);
  const colonArtifacts = [{ name: 'SARIF file', bytes: 16334, entries: [{ name: 'report: final.sarif', size: 71521 }] }];
  for (const destinationFirst of [false, true]) {
    const c = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[{ ...job({ steps: colonSteps }), name: 'analysis', run_artifacts: colonArtifacts }]], file: colonFile(destinationFirst) }]);
    const [h] = find(c, 'an artifact that duplicates another upload');
    assert.ok(h, `destination ${destinationFirst ? 'first' : 'after'}: ${JSON.stringify(c.findings.map((x) => x.what))}`);
    const parsed = parseYaml(h.example);
    assert.equal(parsed[0].name, 'Upload: report');
    assert.equal(parsed[0].with.path, 'report: final.sarif');
    assert.equal(parsed[0].if, destinationFirst ? undefined : 'failure()');
  }
});

test('an artifact that duplicates another upload: silent without the run\'s artifact, with an artifact of another name, with more than the one file, or with a directory the zip could not be read', () => {
  const file = scorecardFile();
  const none = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[analysisJob()]], file }]);
  assert.equal(find(none, 'an artifact that duplicates another upload').length, 0);
  assert.equal(none.workflows[0].duplicate_uploads[0].artifact, null, 'the file alone is a candidate, not a finding');
  const other = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[analysisJob(sarif(undefined, 'coverage'))]], file }]);
  assert.equal(find(other, 'an artifact that duplicates another upload').length, 0);
  // A directory's worth of files: upload-sarif sent its SARIF files, the artifact keeps everything.
  const many = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[analysisJob(sarif([{ name: 'results.sarif', size: 1 }, { name: 'notes.txt', size: 2 }]))]], file }]);
  assert.equal(find(many, 'an artifact that duplicates another upload').length, 0);
  assert.equal(many.workflows[0].duplicate_uploads[0].artifact.one_file, false);
  const folder = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[analysisJob(sarif([{ name: 'results.sarif/', size: 0 }]))]], file }]);
  assert.equal(find(folder, 'an artifact that duplicates another upload').length, 0);
  const otherFile = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[analysisJob(sarif([{ name: 'summary.sarif', size: 9 }]))]], file }]);
  assert.equal(find(otherFile, 'an artifact that duplicates another upload').length, 0);
  const unread = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[analysisJob(sarif(null))]], file }]);
  assert.equal(find(unread, 'an artifact that duplicates another upload').length, 0);
  // Two artifacts of one name in the run (two jobs uploading alike) are not one step's.
  const twice = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[analysisJob([...sarif(), ...sarif()])]], file }]);
  assert.equal(find(twice, 'an artifact that duplicates another upload').length, 0);
  // Only the newest sampled run's artifact counts.
  const older = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[analysisJob()], [analysisJob(sarif())]], file }]);
  assert.equal(find(older, 'an artifact that duplicates another upload').length, 0);
});
