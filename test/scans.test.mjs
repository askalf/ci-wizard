// Security scans of every workflow file: actions pinned to something that can move, untrusted event
// text in a script, and a job token wider than the job. Each with its near misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { envNameFor, parseUses, scanFindings, scanWorkflow, untrustedExpressions } from '../src/scans.mjs';
import { expressionSpans, valueOf } from '../src/expr.mjs';
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
  // An object filter selects whichever object the event has: github.event.*.title is the title.
  assert.deepEqual(hits("echo ${{ join(github.event.*.title, '') }}"), ['github.event.*.title']);
  assert.deepEqual(hits('echo ${{ toJSON(github.event.*) }}'), ['github.event.*']);
  assert.deepEqual(hits('echo ${{ github.*.issue.body }}'), ['github.*.issue.body']);
  // A filter of an object's own values holds its text fields too.
  assert.deepEqual(hits('echo ${{ toJSON(github.event.issue.*) }}'), ['github.event.issue.*']);
  assert.deepEqual(hits("echo ${{ join(github.event.head_commit.author.*, ' ') }}"), ['github.event.head_commit.author.*']);
  assert.deepEqual(hits("echo ${{ join(github.event.commits.*.author.*, ' ') }}"), ['github.event.commits.*.author.*']);
  assert.deepEqual(hits("echo ${{ join(github.*.*.title, '') }}"), ['github.*.*.title']);
  assert.deepEqual(hits("echo ${{ join(github.event.*.number, ',') }} ${{ join(github.event.*.id, ',') }}"), []);
  assert.deepEqual(hits('echo ${{ toJSON(github.event.issue.user.*) }} ${{ toJSON(github.event.repository.*) }}'), []);
  assert.deepEqual(hits('echo ${{ github.event.issue.title.foo }}'), []); // a property of a string is null
  // A numeric string is an index, as GitHub reads it; it is no index into an object.
  assert.deepEqual(hits("echo ${{ github.event.commits['0'].message }}"), ["github.event.commits.0.message"]);
  assert.deepEqual(hits("echo ${{ github.event.pages['12'].page_name }}"), ["github.event.pages.12.page_name"]);
  assert.deepEqual(hits("echo ${{ github.event.commits[format('{0}', 1)].author.name }}"), ['github.event.commits.1.author.name']);
  assert.deepEqual(hits("echo ${{ github.event.commits['0'].id }} ${{ github.event.commits['0'].timestamp }} ${{ github.event.issue['0'] }}"), []);
  // }} inside a quoted string does not end the expression, as GitHub reads it.
  assert.deepEqual(hits("echo \"${{ format('}}{0}', github.event.issue.title) }}\""), ['github.event.issue.title']);
  assert.deepEqual(hits("echo ${{ format('it''s }}{0}', github.event.issue.body) }}"), ['github.event.issue.body']);
  assert.deepEqual(hits("echo ${{ format('}}{0}', github.event.issue.number) }}"), []);
  // A computed key: one built from constants is resolved; one that reads the run counts where the
  // object can hold untrusted text.
  assert.deepEqual(hits("echo ${{ github.event.issue[format('tit{0}', 'le')] }}"), ['github.event.issue.title']);
  assert.deepEqual(hits("echo ${{ github.event.issue[format('num{0}', 'ber')] }}"), []);
  assert.deepEqual(hits('echo ${{ github.event.issue[inputs.field] }}'), ['github.event.issue']);
  assert.deepEqual(hits('echo ${{ github.event.commits[inputs.i].message }}'), ['github.event.commits']);
  assert.deepEqual(hits('echo ${{ github.event.repository[inputs.field] }}'), []); // holds no untrusted text
  assert.deepEqual(hits('echo ${{ github.event.*[inputs.field] }}'), ['github.event.*']);
  // A property of a computed value carries what the value carries.
  assert.deepEqual(hits('echo "${{ fromJSON(toJSON(github.event)).issue.title }}"'), ['github.event']);
  assert.deepEqual(hits("echo ${{ fromJSON(toJSON(github.event))['issue']['body'] }}"), ['github.event']);
  assert.deepEqual(hits("echo ${{ fromJSON('{\"a\":1}').a }} ${{ fromJSON(toJSON(github.event.issue.number)) }}"), []);
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

test('expressionSpans: }} inside a quoted string, and a doubled quote, do not end an expression', () => {
  const spans = (x) => expressionSpans(x).map((sp) => sp.body);
  assert.deepEqual(spans("a ${{ format('}}{0}', x) }} b ${{ y }}"), [" format('}}{0}', x) ", ' y ']);
  assert.deepEqual(spans("${{ 'it''s }}' }}"), [" 'it''s }}' "]);
  assert.deepEqual(spans('${{ x }'), []); // unterminated
});

test('valueOf: an interpolation ends each expression where GitHub does', () => {
  assert.equal(valueOf("v-${{ format('}}{0}', 'x') }}-w", {}), 'v-}x-w');
  assert.equal(valueOf("${{ 'a' }} and ${{ 'b' }}", {}), 'a and b'); // two expressions, not one
  assert.equal(valueOf("  ${{ 'a' }}  ", {}), 'a');
});

test('envNameFor: a short, shell-safe name for the field', () => {
  assert.equal(envNameFor('github.event.pull_request.title'), 'PR_TITLE');
  assert.equal(envNameFor('github.head_ref'), 'HEAD_REF');
  assert.equal(envNameFor('github.event.comment.body'), 'COMMENT_BODY');
  assert.equal(envNameFor('github.event.commits[0].message'), 'COMMITS_MESSAGE');
  assert.equal(envNameFor('github.event.commits.0.message'), 'COMMITS_MESSAGE'); // commits['0']
  assert.equal(envNameFor('github.event.pages.12.page_name'), 'PAGES_PAGE_NAME');
  assert.equal(envNameFor('github.event.*.title'), 'EVENT_TITLE');
  assert.equal(envNameFor('github.event.commits.*.author.*'), 'COMMITS_AUTHOR');
  for (const f of ['github.event.commits.0.message', 'github.event.issue.*', 'github', 'github.event.pages.12.page_name', '0.1']) {
    assert.match(envNameFor(f), /^[A-Z_][A-Z0-9_]*$/, f);
  }
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
  // The action's owner and name in any case are the same action.
  const mixed = scanWorkflow(wf(`      - uses: Actions/GitHub-Script@${SHA}\n        with:\n          script: console.log("\${{ github.event.issue.title }}")\n`));
  assert.deepEqual(mixed.injections.map((x) => x.field), ['github.event.issue.title']);
  assert.equal(mixed.injections[0].lang, 'js');
  // Another action's script input is not code the scan reads.
  assert.deepEqual(scanWorkflow(wf(`      - uses: someone/github-script-ish@${SHA}\n        with:\n          script: \${{ github.event.issue.title }}\n`)).injections, []);
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
  assert.match(step.run, /"\$PR_TITLE"/);

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

const injectionExample = (steps, runsOn = 'ubuntu-latest') => {
  const F = scanFindings(new Map([['.github/workflows/ci.yml', `on: [pull_request]\npermissions: {}\njobs:\n  build:\n    runs-on: ${runsOn}\n    steps:\n${steps}`]]));
  return F.find((f) => f.what === 'untrusted input in a script');
};

test('the injection example is the pattern, in the step\'s language, never a rewrite that could keep the injection', () => {
  // bash: env, then the variable read in double quotes; the step's own command is left to the person.
  const sh = injectionExample('      - name: Label\n        run: bash -c "gh pr edit --add-label ${{ github.head_ref }}"\n');
  const step = parse(sh.example)[0];
  assert.equal(step.name, 'Label');
  assert.deepEqual(step.env, { HEAD_REF: '${{ github.head_ref }}' });
  assert.match(sh.example, /^# the pattern, not a drop-in edit/);
  assert.match(step.run, /"\$HEAD_REF"/);
  assert.doesNotMatch(step.run, /\$\{\{/); // no untrusted expression outside env
  // PowerShell on a Windows runner, github-script for its script input.
  assert.match(parse(injectionExample('      - run: Write-Host "${{ github.head_ref }}"\n', 'windows-latest').example)[0].run, /\$env:HEAD_REF/);
  const gs = parse(injectionExample(`      - uses: actions/github-script@${SHA}\n        with:\n          script: core.info("\${{ github.event.issue.title }}")\n`).example)[0];
  assert.equal(gs.env.ISSUE_TITLE, '${{ github.event.issue.title }}');
  assert.match(gs.with.script, /process\.env\.ISSUE_TITLE/);
  // An expression with a colon and a space is quoted as a YAML value and kept whole.
  const colon = parse(injectionExample("      - run: |\n          echo \"${{ format('Title: {0}', github.event.issue.title) }}\"\n").example)[0];
  assert.equal(colon.env.ISSUE_TITLE, "${{ format('Title: {0}', github.event.issue.title) }}");
  // A numeric-string index names a valid variable, read the same way.
  const idx = parse(injectionExample("      - run: echo \"${{ github.event.commits['0'].message }}\"\n").example)[0];
  assert.deepEqual(Object.keys(idx.env), ['COMMITS_MESSAGE']);
  assert.match(idx.run, /"\$COMMITS_MESSAGE"/);
  // A step name YAML would misread (a colon, a #) is quoted, so the example still parses.
  assert.equal(parse(injectionExample('      - name: "Greet: #1"\n        run: echo ${{ github.head_ref }}\n').example)[0].name, 'Greet: #1');
  // An unknown shell (a matrix OS) gets the forms for the shells it could be, said as such.
  assert.match(injectionExample('      - run: echo ${{ github.head_ref }}\n', '${{ matrix.os }}').example, /as this step's shell does: "\$HEAD_REF" in bash, \$env:HEAD_REF in PowerShell/);
  // python reads os.environ; cmd expands %VAR% before parsing, so it gets no example and the fix says why.
  assert.match(parse(injectionExample('      - shell: python\n        run: print("${{ github.event.issue.title }}")\n').example)[0].run, /os\.environ\["ISSUE_TITLE"\]/);
  const cmd = injectionExample('      - shell: cmd\n        run: echo ${{ github.head_ref }}\n', 'windows-latest');
  assert.equal(cmd.example, '');
  assert.match(cmd.fix, /cmd expands %VAR% before it parses the line.*bash or pwsh/);
});

test('the injection fix names what the variable does not fix: a second parser, an option that runs a program, an env file, an argument', () => {
  const { fix } = injectionExample('      - run: echo "${{ github.head_ref }}"\n');
  assert.match(fix, /bash -c, eval, ssh, a github-script exec/);
  assert.match(fix, /awk, sed, jq/);
  assert.match(fix, /tar --checkpoint-action, git --upload-pack/);
  assert.match(fix, /\$GITHUB_ENV or \$GITHUB_OUTPUT.*random multiline delimiter/);
  assert.match(fix, /Never write it to \$GITHUB_PATH, which takes one path per line and has no delimiter/);
  assert.doesNotMatch(fix, /cmd expands/); // only when a step runs in cmd
  assert.match(fix, /put -- before it/);
});


test('collect reads every workflow file for the scans, up to the cap, and says how many', async () => {
  const listing = ['ci.yml', 'release.yml', 'nightly.yaml', 'README.md'].map((name) => ({ name, type: 'file' }));
  const asked = [];
  const routes = {
    'repos/o/r/actions/runs?': { workflow_runs: runs(3).map((r) => ({ ...r, path: '.github/workflows/ci.yml' })) },
    'repos/o/r/actions/runs/': { jobs: [job()] },
    'repos/o/r/contents/.github/workflows/': 'on: push\njobs: {}\n',
    'repos/o/r/contents/.github/workflows': listing,
    'repos/o/r/contents': [],
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
    'repos/o/r/contents': [],
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
