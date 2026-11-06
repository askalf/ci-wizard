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
  // A job that calls a reusable workflow takes that workflow's permissions unless it sets its own.
  const reusable = `on: [push]\njobs:\n  call:\n    uses: owner/repo/.github/workflows/x.yml@${SHA}\n`;
  assert.deepEqual(scanWorkflow(reusable).unscoped, []);
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
  assert.deepEqual(d.scanned, { read: 3, of: 3 });
  // ci.yml was read once, for the sample, and not again for the scan.
  assert.equal(asked.filter((u) => u.endsWith('contents/.github/workflows/ci.yml')).length, 1);
  const capped = await collect(createClient({ fetchImpl: fakeFetch(routes) }), 'o/r', { now, maxScanFiles: 2 });
  assert.deepEqual(capped.scanned, { read: 2, of: 3 });
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
