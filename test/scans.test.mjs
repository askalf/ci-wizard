// Security scans of every workflow file: actions pinned to something that can move, untrusted event
// text in a script, and a job token wider than the job. Each with its near misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { envNameFor, parseUses, scanFindings, scanWorkflow, untrustedExpressions } from '../src/scans.mjs';
import { analyse } from '../src/analyse.mjs';
import { collect } from '../src/collect.mjs';
import { createClient } from '../src/github.mjs';
import { report } from '../src/report.mjs';
import { data, fakeFetch, job, runs, t } from './helpers.mjs';

const SHA = 'a'.repeat(40);

test('parseUses: a commit SHA is pinned; a tag or branch is not; local actions and images are not references', () => {
  assert.equal(parseUses(`actions/checkout@${SHA}`).pinned, true);
  assert.equal(parseUses('actions/checkout@v4').pinned, false);
  assert.equal(parseUses('actions/checkout@v4').firstParty, true);
  assert.equal(parseUses('someone/tool@main').firstParty, false);
  assert.equal(parseUses('owner/repo/.github/workflows/build.yml@v1').pinned, false);
  assert.equal(parseUses(`owner/repo/path/to/action@${SHA.slice(0, 12)}`).pinned, false); // a short SHA is not a pin
  assert.equal(parseUses('./.github/actions/local'), null);
  assert.equal(parseUses('docker://alpine:3.20'), null);
  assert.equal(parseUses(''), null);
});

test('untrustedExpressions: titles, bodies, branch names and commit text; not numbers or repository names', () => {
  const hits = (s) => untrustedExpressions(s).map((x) => x.field);
  assert.deepEqual(hits('echo "${{ github.event.pull_request.title }}"'), ['github.event.pull_request.title']);
  assert.deepEqual(hits('git checkout ${{ github.head_ref }}'), ['github.head_ref']);
  assert.deepEqual(hits('echo ${{ github.event.issue.body }} ${{ github.event.comment.body }}'), ['github.event.issue.body', 'github.event.comment.body']);
  assert.deepEqual(hits('echo ${{ github.event.commits[0].message }}'), ['github.event.commits[0].message']);
  assert.deepEqual(hits('echo ${{ github.event.pull_request.head.ref }}'), ['github.event.pull_request.head.ref']);
  assert.deepEqual(hits('echo ${{ github.event.pull_request.number }} ${{ github.repository }} ${{ github.sha }}'), []);
  assert.deepEqual(hits('echo "$PR_TITLE"'), []);
});

test('untrustedExpressions: only an expression whose value carries the text; a boolean or a literal does not', () => {
  const hits = (s) => untrustedExpressions(s).map((x) => x.field);
  // Near misses: a test of the title, a comparison, a negation, a field name in a quoted literal.
  assert.deepEqual(hits("echo ${{ contains(github.event.pull_request.title, 'release') }}"), []);
  assert.deepEqual(hits("echo ${{ startsWith(github.head_ref, 'dependabot/') }}"), []);
  assert.deepEqual(hits("echo ${{ github.event.issue.title == 'bug' }}"), []);
  assert.deepEqual(hits('echo ${{ !github.event.comment.body }}'), []);
  assert.deepEqual(hits("echo ${{ 'github.event.pull_request.title' }}"), []);
  assert.deepEqual(hits("echo ${{ hashFiles('github.event.issue.body') }}"), []);
  // The text passed on: through ||, &&, format, join, toJSON, or an object that holds it.
  assert.deepEqual(hits("echo ${{ github.event.pull_request.title || 'untitled' }}"), ['github.event.pull_request.title']);
  assert.deepEqual(hits("echo ${{ github.event_name == 'pull_request' && github.head_ref }}"), ['github.head_ref']);
  assert.deepEqual(hits("echo ${{ format('PR: {0}', github.event.pull_request.title) }}"), ['github.event.pull_request.title']);
  assert.deepEqual(hits('echo ${{ toJSON(github.event) }}'), ['github.event']);
  assert.deepEqual(hits("echo ${{ github.event['pull_request']['title'] }}"), ['github.event.pull_request.title']);
  assert.deepEqual(hits('echo ${{ github.event.pull_request.head.label }}'), ['github.event.pull_request.head.label']);
  // && and ||: a field that only picks a branch is not the result; one a branch returns is.
  assert.deepEqual(hits("echo ${{ github.event.issue.title && 'yes' || 'no' }}"), []);
  assert.deepEqual(hits("echo ${{ github.event.issue.title && 'yes' }}"), []);
  assert.deepEqual(hits("echo ${{ github.event_name == 'issues' && github.event.issue.title || 'none' }}"), ['github.event.issue.title']);
  assert.deepEqual(untrustedExpressions("echo ${{ github.event.issue.title || github.event.issue.body }}")[0].fields, ['github.event.issue.title', 'github.event.issue.body']);
  // Property names are case-insensitive: the same title, however it is spelled.
  assert.deepEqual(hits('echo "${{ github.event.issue.TITLE }}"'), ['github.event.issue.title']);
  assert.deepEqual(hits('echo "${{ GitHub.Event.Pull_Request.Head.Ref }}"'), ['github.event.pull_request.head.ref']);
  assert.deepEqual(hits("echo ${{ github.event['Issue']['Body'] }}"), ['github.event.issue.body']);
  assert.deepEqual(hits('echo ${{ toJSON(GITHUB.EVENT) }}'), ['github.event']);
  // An element of a collection carries its message, author or page name; its other leaves do not.
  assert.deepEqual(hits("echo '${{ toJSON(github.event.commits[0]) }}'"), ['github.event.commits[0]']);
  assert.deepEqual(hits("echo '${{ toJSON(github.event.commits.*) }}'"), ['github.event.commits.*']);
  assert.deepEqual(hits("echo '${{ toJSON(github.event.commits[0].author) }}'"), ['github.event.commits[0].author']);
  assert.deepEqual(hits("echo '${{ toJSON(github.event.pages[0]) }}'"), ['github.event.pages[0]']);
  assert.deepEqual(hits('echo ${{ github.event.commits[0].id }} ${{ github.event.commits[0].url }} ${{ github.event.pages[0].sha }}'), []);
  assert.deepEqual(hits('echo ${{ toJSON(github.event.commits[0].id) }}'), []);
  // An expression that does not parse falls back to the name, also in any case.
  assert.deepEqual(hits('echo ${{ github.event.issue.TITLE ) }}'), ['github.event.issue.title']);
});

test('envNameFor: a short, shell-safe name for the field', () => {
  assert.equal(envNameFor('github.event.pull_request.title'), 'PR_TITLE');
  assert.equal(envNameFor('github.head_ref'), 'HEAD_REF');
  assert.equal(envNameFor('github.event.comment.body'), 'COMMENT_BODY');
  assert.equal(envNameFor('github.event.commits[0].message'), 'COMMITS_MESSAGE');
});

const wf = (steps, top = '', jobExtra = '') => `on: [pull_request]\n${top}jobs:\n  build:\n${jobExtra}    runs-on: ubuntu-latest\n    steps:\n${steps}`;

test('scanWorkflow: script injection in run and github-script, never in env or a commented line', () => {
  const s = scanWorkflow(wf([
    '      - name: Greet',
    '        run: echo "Thanks for ${{ github.event.pull_request.title }}"',
    `      - uses: actions/github-script@${SHA}`,
    '        with:',
    '          script: console.log("${{ github.event.comment.body }}")',
    '      - name: Safe',
    '        env:',
    '          TITLE: ${{ github.event.pull_request.title }}',
    '        run: echo "$TITLE"',
    '      # - run: echo ${{ github.head_ref }}',
  ].join('\n') + '\n'));
  assert.deepEqual(s.injections.map((x) => `${x.step}:${x.field}`), ['Greet:github.event.pull_request.title', `actions/github-script@${SHA}:github.event.comment.body`]);
});

test('scanWorkflow: the job token, from write-all, a missing block, or a scoped one', () => {
  const steps = '      - run: make\n';
  assert.deepEqual(scanWorkflow(wf(steps, 'permissions: write-all\n')).writeAll, ['(workflow)']);
  assert.deepEqual(scanWorkflow(wf(steps, '', '    permissions: write-all\n')).writeAll, ['build']);
  assert.deepEqual(scanWorkflow(wf(steps)).unscoped, ['build']);
  assert.deepEqual(scanWorkflow(wf(steps, 'permissions:\n  contents: read\n')).unscoped, []);
  assert.deepEqual(scanWorkflow(wf(steps, 'permissions: {}\n')).unscoped, []);
  assert.deepEqual(scanWorkflow(wf(steps, '', '    permissions:\n      contents: read\n')).unscoped, []);
  // A reusable-workflow call with no permissions hands the caller's default token on: the called
  // workflow may narrow it, but the audit does not read it, so the call is unscoped.
  const reusable = `on: [push]\njobs:\n  call:\n    uses: owner/repo/.github/workflows/x.yml@${SHA}\n`;
  assert.deepEqual(scanWorkflow(reusable).unscoped, ['call']);
  assert.deepEqual(scanWorkflow(reusable.replace('    uses', '    permissions:\n      contents: read\n    uses')).unscoped, []);
  assert.deepEqual(scanWorkflow(`permissions: {}\n${reusable}`).unscoped, []);
});

test('scanFindings: one finding per kind, naming the files, with YAML that parses', () => {
  const files = new Map([
    ['.github/workflows/ci.yml', wf(['      - uses: actions/checkout@v4', '      - uses: someone/setup-thing@v2', '      - name: Greet', '        run: echo "${{ github.event.pull_request.title }}"'].join('\n') + '\n')],
    ['.github/workflows/release.yml', wf(`      - uses: actions/checkout@${SHA}\n`, 'permissions: write-all\n')],
  ]);
  const F = scanFindings(files);
  const by = Object.fromEntries(F.map((f) => [f.what, f]));
  const pins = by['actions not pinned to a commit'];
  assert.equal(pins.unit, 'risk');
  assert.equal(pins.confidence, 'confirmed');
  assert.equal(pins.workflow, '.github/workflows/ci.yml');
  assert.match(pins.evidence, /2 action references are pinned to a tag or branch.*third-party: someone\/setup-thing@v2.*GitHub's own: actions\/checkout@v4/);
  assert.match(pins.example, /^- uses: someone\/setup-thing@<full 40-character commit SHA> {2}# v2$/);

  const inj = by['untrusted input in a script'];
  assert.match(inj.evidence, /\.github\/workflows\/ci\.yml job build, Greet: \$\{\{ github\.event\.pull_request\.title \}\}/);
  const step = parse(inj.example)[0];
  assert.equal(step.name, 'Greet');
  assert.equal(step.env.PR_TITLE, '${{ github.event.pull_request.title }}');
  assert.equal(step.run, 'echo "${PR_TITLE}"'); // the original command, inside its own quotes

  const tok = by['job token wider than the job'];
  assert.equal(tok.confidence, 'confirmed'); // write-all is in the file
  assert.match(tok.evidence, /write-all in \.github\/workflows\/release\.yml \(\(workflow\)\); no permissions block in \.github\/workflows\/ci\.yml/);
  assert.equal(parse(tok.example).permissions.contents, 'read');
});

test('scanFindings: clean files give nothing, and a missing block alone is inferred', () => {
  const clean = new Map([['.github/workflows/ci.yml', wf(`      - uses: actions/checkout@${SHA}\n      - run: make\n`, 'permissions:\n  contents: read\n')]]);
  assert.deepEqual(scanFindings(clean), []);
  const missing = scanFindings(new Map([['.github/workflows/ci.yml', wf(`      - uses: actions/checkout@${SHA}\n`)]]));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].confidence, 'inferred');
  // A file that does not parse yields no facts and no finding.
  assert.deepEqual(scanFindings(new Map([['.github/workflows/bad.yml', 'on: [push\n  jobs: :']])), []);
});

const injectionExample = (steps, runsOn = 'ubuntu-latest', top = '') => {
  const s = scanWorkflow(`on: [pull_request]\n${top}jobs:\n  build:\n    runs-on: ${runsOn}\n    steps:\n${steps}`);
  assert.ok(s.injections.length, 'an injection is found');
  return s.injections[0].example;
};

test('the injection example is the step itself, command and settings kept, read as its shell reads it', () => {
  // A command other than echo, with if:, working-directory and an env it already had; the head ref
  // appears bare and in single quotes.
  const label = parse(injectionExample([
    '      - name: Label',
    "        if: github.event.action == 'opened'",
    '        env:',
    '          GH_TOKEN: ${{ github.token }}',
    "        run: gh pr edit --add-label ${{ github.head_ref }} && git push origin '${{ github.head_ref }}'",
    '        working-directory: app',
  ].join('\n') + '\n'))[0];
  assert.equal(label.name, 'Label');
  assert.equal(label.if, "github.event.action == 'opened'");
  assert.equal(label['working-directory'], 'app');
  assert.deepEqual(label.env, { GH_TOKEN: '${{ github.token }}', HEAD_REF: '${{ github.head_ref }}' });
  assert.equal(label.run, 'gh pr edit --add-label "$HEAD_REF" && git push origin "$HEAD_REF"');

  // github-script: the script reads process.env, in a plain string and in a template literal; the
  // step's other inputs stay.
  const gs = parse(injectionExample([
    `      - uses: actions/github-script@${SHA}`,
    '        with:',
    '          github-token: ${{ secrets.BOT }}',
    '          script: |',
    '            const body = "${{ github.event.comment.body }}";',
    '            core.info(`title: ${{ github.event.issue.title }}`);',
  ].join('\n') + '\n'))[0];
  assert.equal(gs.uses, `actions/github-script@${SHA}`);
  assert.equal(gs.with['github-token'], '${{ secrets.BOT }}');
  assert.equal(gs.env.COMMENT_BODY, '${{ github.event.comment.body }}');
  assert.equal(gs.with.script, 'const body = process.env.COMMENT_BODY;\ncore.info(`title: ${process.env.ISSUE_TITLE}`);\n');

  // A string with text around the expression becomes one template literal, so a method call on it
  // still applies to the whole string; a string that was only the expression becomes the variable.
  const js = (script) => parse(injectionExample(`      - uses: actions/github-script@${SHA}\n        with:\n          script: ${JSON.stringify(script)}\n`))[0].with.script;
  assert.equal(js('core.info("Title: ${{ github.event.issue.title }}".toUpperCase())'), 'core.info(`Title: ${process.env.ISSUE_TITLE}`.toUpperCase())');
  assert.equal(js("core.info('${{ github.event.issue.title }}'.trim())"), 'core.info(process.env.ISSUE_TITLE.trim())');
  assert.equal(js('const s = "cost: ${x} `q` ${{ github.head_ref }}"'), 'const s = `cost: \\${x} \\`q\\` ${process.env.HEAD_REF}`');
  assert.equal(js('const ok = "a\\"b ${{ github.head_ref }}"'), 'const ok = `a\\"b ${process.env.HEAD_REF}`');
  // In a comment the expression is still expanded before JavaScript runs, so it is replaced there too.
  assert.equal(js('// ${{ github.event.issue.body }}\ncore.info("x")'), '// process.env.ISSUE_BODY\ncore.info("x")');
  assert.equal(js('/* ${{ github.event.issue.body }} */ core.info("x")'), '/* process.env.ISSUE_BODY */ core.info("x")');
  assert.doesNotMatch(js('// see ${{ github.event.issue.body }}\n/* and ${{ github.event.comment.body }} */'), /\$\{\{/);
  // Where the template could read differently, no example.
  const none = (script) => injectionExample(`      - uses: actions/github-script@${SHA}\n        with:\n          script: ${JSON.stringify(script)}\n`);
  assert.equal(none('core.info("${{ github.sha }}: ${{ github.event.issue.title }}")'), ''); // a trusted expression in the same string
  assert.equal(none('const o = { "k ${{ github.head_ref }}": 1 }'), ''); // an object key
  assert.equal(none('core.info(`${a ? "x" : "y"} ${{ github.head_ref }}`)'), ''); // a nested template

  // PowerShell on Windows, by the runner or by the shell.
  assert.equal(parse(injectionExample('      - run: Write-Host "${{ github.head_ref }}"\n', 'windows-latest'))[0].run, 'Write-Host "${env:HEAD_REF}"');
  assert.equal(parse(injectionExample('      - shell: pwsh\n        run: Write-Host ${{ github.head_ref }}\n'))[0].run, 'Write-Host ${env:HEAD_REF}');
  assert.equal(parse(injectionExample('      - run: echo ${{ github.head_ref }}\n', 'windows-latest', 'defaults:\n  run:\n    shell: bash\n'))[0].run, 'echo "$HEAD_REF"');
});

test('the injection example is left out where the rewrite cannot be certain', () => {
  // A second parser: the outer shell would expand the variable into the inner program's text.
  assert.equal(injectionExample('      - run: bash -c "echo ${{ github.event.issue.title }}"\n'), '');
  assert.equal(injectionExample("      - run: sh -ec 'echo ${{ github.event.issue.title }}'\n"), '');
  assert.equal(injectionExample('      - run: eval "echo ${{ github.head_ref }}"\n'), '');
  assert.equal(injectionExample('      - run: ssh host "deploy ${{ github.head_ref }}"\n'), '');
  assert.equal(injectionExample("      - run: jq '.x == \"${{ github.head_ref }}\"' f.json\n"), '');
  assert.equal(injectionExample('      - run: |\n          docker run img \\\n            sh -c "echo ${{ github.head_ref }}"\n'), '');
  // A backslash continuation between the shell and its -c is the same command.
  assert.equal(injectionExample('      - run: |\n          bash \\\n            -c "echo ${{ github.event.issue.title }}"\n'), '');
  assert.equal(injectionExample('      - run: |\n          docker run img sh \\\n            -c "echo ${{ github.head_ref }}"\n'), '');
  // The shell removes a backslash-newline outright, so it can split an option or a command name.
  assert.equal(injectionExample('      - run: |\n          bash -\\\n          c "echo ${{ github.event.issue.title }}"\n'), '');
  assert.equal(injectionExample('      - run: |\n          ba\\\n          sh -c "echo ${{ github.event.issue.title }}"\n'), '');
  assert.equal(injectionExample('      - run: |\n          ev\\\n          al "echo ${{ github.head_ref }}"\n'), '');
  // A quote in a shell comment is not a quote: the next line's expression is unquoted.
  assert.equal(parse(injectionExample("      - run: |\n          # don't\n          echo ${{ github.head_ref }}\n"))[0].run, "# don't\necho \"$HEAD_REF\"\n");
  assert.equal(parse(injectionExample("      - run: |\n          # don't\n          Write-Host ${{ github.head_ref }}\n", 'windows-latest'))[0].run, "# don't\nWrite-Host ${env:HEAD_REF}\n");
  // An expression in a comment is replaced there too: GitHub expands it before the shell reads it.
  assert.doesNotMatch(parse(injectionExample('      - run: |\n          # was ${{ github.head_ref }}\n          make\n'))[0].run, /\$\{\{/);
  // A # inside a word is not a comment, and a bash -c after one still counts.
  assert.equal(injectionExample('      - run: echo a#b; bash -c "echo ${{ github.head_ref }}"\n'), '');
  // A continuation between plain arguments still allows the rewrite, and keeps the continuation.
  assert.equal(parse(injectionExample('      - run: |\n          echo \\\n            ${{ github.head_ref }}\n'))[0].run, 'echo \\\n  "$HEAD_REF"\n');
  assert.equal(injectionExample('      - run: |\n          Invoke-Expression `\n            "echo ${{ github.head_ref }}"\n', 'windows-latest'), '');
  // A quoted command string across lines is one command: bash -c on the first, the expression on the next.
  assert.equal(injectionExample('      - run: |\n          bash -c "echo\n          ${{ github.event.issue.title }}"\n'), '');
  assert.equal(injectionExample("      - run: |\n          sh -c '\n            echo ${{ github.head_ref }}\n          '\n"), '');
  assert.equal(injectionExample('      - run: |\n          out=$(bash -c "\n            echo ${{ github.head_ref }}")\n'), '');
  assert.equal(injectionExample('      - run: python -c "print(\'${{ github.head_ref }}\')"\n'), '');
  assert.equal(injectionExample('      - run: Invoke-Expression "echo ${{ github.head_ref }}"\n', 'windows-latest'), '');
  assert.equal(injectionExample(`      - uses: actions/github-script@${SHA}\n        with:\n          script: await exec.exec(\`git tag \${{ github.head_ref }}\`)\n`), '');
  // A second parser elsewhere in the script, on another line, does not block this line's rewrite.
  assert.equal(parse(injectionExample('      - run: |\n          bash -c "make all"\n          echo ${{ github.head_ref }}\n'))[0].run, 'bash -c "make all"\necho "$HEAD_REF"\n');
  // The finding still fires and its fix says what the nested case needs.
  const nested = scanFindings(new Map([['.github/workflows/ci.yml', 'on: [pull_request]\npermissions: {}\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bash -c "echo ${{ github.event.issue.title }}"\n']]));
  const f = nested.find((x) => x.what === 'untrusted input in a script');
  assert.equal(f.example, '');
  assert.match(f.fix, /Here the script hands the value to a second parser.*bash -c 'echo "\$TITLE"'.*jq --arg/);
  assert.equal(injectionExample('      - run: echo ${{ github.head_ref }}\n', '${{ matrix.os }}'), ''); // bash or pwsh?
  assert.equal(injectionExample('      - shell: cmd\n        run: echo ${{ github.head_ref }}\n', 'windows-latest'), '');
  assert.equal(injectionExample('      - shell: python\n        run: print("${{ github.head_ref }}")\n'), '');
  assert.equal(injectionExample('      - run: |\n          cat <<EOF\n          ${{ github.head_ref }}\n          EOF\n'), '');
  assert.equal(injectionExample('      - run: echo `echo ${{ github.head_ref }}`\n'), '');
  // The finding still fires, with no example rather than a wrong one.
  const F = scanFindings(new Map([['.github/workflows/ci.yml', `on: [pull_request]\npermissions: {}\njobs:\n  b:\n    runs-on: \${{ matrix.os }}\n    steps:\n      - run: echo \${{ github.head_ref }}\n`]]));
  const inj = F.find((f) => f.what === 'untrusted input in a script');
  assert.ok(inj);
  assert.equal(inj.example, '');
});

test('collect reads every workflow file for the scans, up to the cap, and says how many', async () => {
  const listing = ['ci.yml', 'release.yml', 'nightly.yaml', 'README.md'].map((name) => ({ name, type: 'file' }));
  const asked = [];
  const routes = {
    'repos/o/r/actions/runs?': { workflow_runs: runs(3).map((r) => ({ ...r, path: '.github/workflows/ci.yml' })) },
    'repos/o/r/actions/runs/': { jobs: [job()] },
    'repos/o/r/contents/.github/workflows/': 'on: push\njobs: {}\n',
    'repos/o/r/contents/.github/workflows': listing,
    'repos/o/r/contents/': [],
  };
  const now = new Date(Date.parse(t(7 * 86400)));
  const d = await collect(createClient({ fetchImpl: fakeFetch(routes, { calls: asked }) }), 'o/r', { now });
  assert.deepEqual([...d.scanFiles.keys()].sort(), ['.github/workflows/ci.yml', '.github/workflows/nightly.yaml', '.github/workflows/release.yml']);
  assert.deepEqual(d.scanned, { read: 3, of: 3, unreadable: [] });
  // ci.yml was read once, for the sample, and not again for the scan.
  assert.equal(asked.filter((u) => u.endsWith('contents/.github/workflows/ci.yml')).length, 1);
  const capped = await collect(createClient({ fetchImpl: fakeFetch(routes) }), 'o/r', { now, maxScanFiles: 2 });
  assert.deepEqual(capped.scanned, { read: 2, of: 3, unreadable: [] });
});

test('collect counts only the files it read: a missing listed file is unread, a missing listing leaves the total unknown', async () => {
  const listing = ['ci.yml', 'gone.yml'].map((name) => ({ name, type: 'file' }));
  const base = {
    'repos/o/r/actions/runs?': { workflow_runs: runs(3).map((r) => ({ ...r, path: '.github/workflows/ci.yml' })) },
    'repos/o/r/actions/runs/': { jobs: [job()] },
    'repos/o/r/contents/.github/workflows/ci.yml': 'on: push\njobs: {}\n',
    'repos/o/r/contents/': [],
  };
  const now = new Date(Date.parse(t(7 * 86400)));
  // gone.yml is listed but answers 404 (deleted between the listing and the read).
  const d = await collect(createClient({ fetchImpl: fakeFetch({ ...base, 'repos/o/r/contents/.github/workflows': (p) => (p.endsWith('workflows') ? listing : { __status: 404 }) }) }), 'o/r', { now });
  assert.deepEqual(d.scanned, { read: 1, of: 2, unreadable: ['.github/workflows/gone.yml'] });
  assert.deepEqual([...d.scanFiles.keys()], ['.github/workflows/ci.yml']);
  const a = analyse('o/r', d);
  assert.match(report(a), /read 1 of the 2 workflow files; 1 could not be read \(\.github\/workflows\/gone\.yml\)/);

  // No listing (404): only the sampled file is scanned, and the total is not claimed.
  const n = await collect(createClient({ fetchImpl: fakeFetch({ ...base, 'repos/o/r/contents/.github/workflows': { __status: 404 } }) }), 'o/r', { now });
  assert.deepEqual(n.scanned, { read: 1, of: null, unreadable: [] });
  const md = report(analyse('o/r', n));
  assert.match(md, /read 1 workflow file \(the sampled ones; the workflow directory could not be listed, so the total is unknown\)/);
  assert.doesNotMatch(md, /read all/);
});

test('the audit ranks scan risks first and says how many files it scanned', () => {
  const d = data({ workflows: [{ name: 'CI', runs: runs(10), jobsPerRun: [[job()]] }] });
  d.scanFiles = new Map([['.github/workflows/ci.yml', wf('      - uses: someone/tool@main\n')]]);
  d.scanned = { read: 1, of: 3 };
  const a = analyse('o/r', d);
  assert.equal(a.findings[0].what, 'actions not pinned to a commit');
  const md = report(a);
  assert.match(md, /Security scans \(actions pinned to a commit, untrusted input in scripts, the job token\) read 1 of the 3 workflow files/);
  // Without the collected listing there are no scans, and no claim about them.
  const plain = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(10), file: wf('      - uses: someone/tool@main\n') }] }));
  assert.equal(plain.findings.filter((f) => f.what === 'actions not pinned to a commit').length, 0);
  assert.doesNotMatch(report(plain), /Security scans/);
});
