import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyse } from '../src/analyse.mjs';
import { cell, report } from '../src/report.mjs';
import { compare, compareData } from '../src/compare.mjs';
import { collect } from '../src/collect.mjs';
import { createClient, NotFoundError } from '../src/github.mjs';
import { parseWorkflow, workflowFacts } from '../src/workflow.mjs';
import { run as runAction } from '../src/action-run.mjs';
import { main as cli } from '../src/cli.mjs';
import { VERSION } from '../src/version.mjs';
import { data, fakeFetch, find, job, run, runs } from './helpers.mjs';

const BS = String.fromCharCode(92); // one backslash, spelled out so no tool in between can collapse it

test('cell: a backslash before a pipe stays text and the pipe stays escaped', () => {
  assert.equal(cell(`A${BS}|B`), `A${BS}${BS}${BS}|B`);
  assert.equal(cell('A|B'), `A${BS}|B`);
  assert.equal(cell('line one\nline two'), 'line one line two');
});

test('report: a workflow named with a backslash and a pipe keeps its row at eight columns', () => {
  const a = analyse('o/r', data({ workflows: [{ name: `A${BS}|B`, runs: runs(3) }] }));
  const row = report(a).split('\n').find((l) => l.startsWith(`| A${BS}`));
  assert.ok(row, 'row present');
  // Split on pipes that are not escaped: an even number of backslashes before a pipe leaves it a column break.
  const breaks = [...row.matchAll(/(\\*)\|/g)].filter((m) => m[1].length % 2 === 0).length;
  assert.equal(breaks, 9, row);
});

test('collect: a 404 on the first runs page is "not found, or the token cannot read it", not "no runs"', async () => {
  const c = createClient({ fetchImpl: fakeFetch({}) });
  await assert.rejects(collect(c, 'o/missing'), (e) => e instanceof NotFoundError && e.message === 'o/missing was not found, or the token cannot read it');
});

test('cli: a missing repository exits 1 and says it was not found or not readable', async () => {
  let err = '';
  const code = await cli(['o/missing'], { env: { GITHUB_TOKEN: 'x' }, stdout: { write() {} }, stderr: { write: (s) => (err += s) }, fetchImpl: fakeFetch({}) });
  assert.equal(code, 1);
  assert.match(err, /o\/missing was not found, or the token cannot read it/);
});

test('action: a missing repository fails the step with the same message and the permissions it needs', async () => {
  const out = [];
  const code = await runAction({ env: { INPUT_REPOSITORY: 'o/missing', RUNNER_TEMP: mkdtempSync(join(tmpdir(), 'ciw-')) }, stdout: { write: (s) => out.push(s) }, fetchImpl: fakeFetch({}) });
  assert.equal(code, 1);
  assert.match(out.join(''), /was not found, or the token cannot read it.*actions: read and contents: read/);
});

const wf = (body) => workflowFacts(parseWorkflow(`on: pull_request\n${body}`));

test('facts: cancel-in-progress as ${{ false }} does not cancel; true, ${{ true }} and a conditional do', () => {
  assert.equal(wf('concurrency:\n  group: g\n  cancel-in-progress: ${{ false }}\njobs: {}\n').cancels, false);
  assert.equal(wf('concurrency:\n  group: g\n  cancel-in-progress: false\njobs: {}\n').cancels, false);
  assert.equal(wf('concurrency:\n  group: g\n  cancel-in-progress: true\njobs: {}\n').cancels, true);
  assert.equal(wf('concurrency:\n  group: g\n  cancel-in-progress: ${{ true }}\njobs: {}\n').cancels, true);
  assert.equal(wf("concurrency:\n  group: g\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\njobs: {}\n").cancels, true);
  assert.equal(wf('concurrency: deploy\njobs: {}\n').cancels, false, 'a group name alone does not cancel');
  const jobLevel = wf('jobs:\n  t:\n    concurrency:\n      group: g\n      cancel-in-progress: true\n    steps: []\n');
  assert.equal(jobLevel.cancels, true, 'a job-level concurrency counts');
  assert.equal(jobLevel.hasConcurrency, true);
});

test('facts: a commented-out actions/cache step is not a cache', () => {
  const f = wf('jobs:\n  t:\n    steps:\n      # - uses: actions/cache@v4\n      #   with:\n      #     path: ~/.npm\n      - run: npm install\n');
  assert.equal(f.hasCache, false);
  assert.equal(f.npmInstallNoCi, true);
});

test('cache dependencies: a workflow whose only cache step is commented out still gets the finding', () => {
  const file = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      # - uses: actions/cache@v4\n      #   with:\n      #     path: ~/.npm\n      - name: Install\n        run: npm install\n      - run: npm test\n';
  const steps = [['Set up job', 1], ['Install', 30], ['Run npm test', 40], ['Complete job', 0]];
  const a = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps })]], file }] }));
  assert.equal(a.workflows[0].has_cache, false);
  assert.equal(find(a, 'cache dependencies').length, 1, JSON.stringify(a.findings));
});

test('facts: setup actions\' cache inputs count, an off input does not, and setup-go v4+ caches by default', () => {
  const step = (uses, withBlock = '') => wf(`jobs:\n  t:\n    steps:\n      - uses: ${uses}\n${withBlock}`);
  assert.deepEqual([step('actions/setup-node@v4', '        with:\n          cache: npm\n').hasCache, step('actions/setup-node@v4', '        with:\n          cache: npm\n').setupCache], [true, true]);
  assert.equal(step('actions/setup-python@v5', '        with:\n          cache: pip\n').hasCache, true);
  assert.equal(step('actions/setup-node@v4', "        with:\n          cache: ''\n").hasCache, false);
  assert.equal(step('actions/setup-node@v4', '        with:\n          cache: ${{ false }}\n').hasCache, false);
  assert.equal(step('actions/setup-go@v5').hasCache, true);
  assert.equal(step('actions/setup-go@v5', '        with:\n          cache: false\n').hasCache, false);
  assert.equal(step('actions/setup-go@v3').hasCache, false);
  assert.equal(step('ruby/setup-ruby@v1', '        with:\n          bundler-cache: true\n').hasCache, true);
  const nm = step('actions/cache@v4', '        with:\n          path: node_modules\n          key: k\n');
  assert.deepEqual([nm.hasCache, nm.cachesNodeModules], [true, true]);
});

test('outdated runs: a workflow whose cancel-in-progress is ${{ false }} still gets the finding', () => {
  const prRuns = Array.from({ length: 4 }, (_, i) => run({ event: 'pull_request', sha: `p${i}`, branch: 'fix/a', at: i * 300, wall: 600 }));
  const file = 'on: pull_request\nconcurrency:\n  group: x\n  cancel-in-progress: ${{ false }}\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  const a = analyse('o/r', data({ workflows: [{ name: 'CI', runs: prRuns, file }] }));
  assert.equal(find(a, 'outdated runs keep going').length, 1, JSON.stringify(a.findings));
});

// Two synthetic reports of one repository: the change cut CI's job time and removed a finding.
function reportOf({ minutes, wall, tail, findings, extraWorkflow }) {
  const w = (name, m) => ({ workflow: name, runs_week: 100, job_minutes_per_run: m, job_minutes_week: 100 * m, wall_p50: wall, wall_p90: wall * 2, wait_p50: 2, wait_p90: 20, tail_p50: tail });
  return {
    repo: 'o/r', covered_days: 7, runs_total: 100,
    workflows: [w('CI', minutes), ...(extraWorkflow ? [w(extraWorkflow, 1)] : [])],
    findings, job_minutes_week_sampled: 100 * minutes,
  };
}
const cacheFinding = { what: 'cache dependencies', workflow: 'CI', evidence: 'installs take 40 s per job', saving_min_week: 40, fix: 'cache', confidence: 'confirmed' };
const tailFinding = { what: 'queue wait', workflow: 'CI', evidence: 'p90 wait for a runner 45 s', saving_min_week: 0, fix: 'capacity', confidence: 'measured' };
const before = reportOf({ minutes: 4, wall: 300, tail: 5, findings: [cacheFinding], extraWorkflow: 'Docs' });
const after = reportOf({ minutes: 3, wall: 240, tail: 5, findings: [tailFinding], extraWorkflow: 'Release' });

test('compare: per workflow, before, after and the change of each measurement', () => {
  const md = compare(before, after);
  assert.match(md, /^# CI comparison: o\/r/);
  assert.match(md, /## CI\n\n\| Measure \| Before \| After \| Change \|/);
  assert.match(md, /\| Job-min\/run \| 4\.0 \| 3\.0 \| -1\.0 \(-25%\) \|/);
  assert.match(md, /\| Job-min\/week \| 400 \| 300 \| -100 \(-25%\) \|/);
  assert.match(md, /\| Developer wait p50 \| 5\.0 min \| 4\.0 min \| -60 s \(-20%\) \|/);
  assert.match(md, /\| Tail p50 \| 5 s \| 5 s \| no change \|/);
  assert.match(md, /Sampled only before: Docs\./);
  assert.match(md, /Sampled only after: Release\./);
});

test('compare: findings that disappeared and findings that appeared', () => {
  const md = compare(before, after);
  assert.match(md, /- Gone: \*\*cache dependencies\*\* in \*CI\* \(was about 40 job-min\/week, estimate\)/);
  assert.match(md, /- New: \*\*queue wait\*\* in \*CI\*: p90 wait for a runner 45 s\./);
  const c = compareData(before, after);
  assert.deepEqual([c.gone.length, c.appeared.length, c.both.length], [1, 1, 1]);
  assert.equal(c.both[0].metrics.find((m) => m.key === 'job_minutes_per_run').delta, -1);
});

test('compare: two different repositories are called out', () => {
  assert.match(compare(before, { ...after, repo: 'o/other' }), /different repositories/);
});

test('cli compare: reads two --json reports; usage and unreadable files are errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ciw-'));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(before));
  writeFileSync(join(dir, 'a.json'), JSON.stringify(after));
  writeFileSync(join(dir, 'x.json'), '{"hello":1}');
  const io = () => { const o = { out: '', err: '' }; return { o, stdout: { write: (s) => (o.out += s) }, stderr: { write: (s) => (o.err += s) } }; };
  const ok = io();
  assert.equal(await cli(['compare', join(dir, 'b.json'), join(dir, 'a.json')], { env: {}, ...ok }), 0);
  assert.match(ok.o.out, /# CI comparison: o\/r/);
  assert.equal(await cli(['compare', join(dir, 'b.json')], { env: {}, ...io() }), 2);
  const notReport = io();
  assert.equal(await cli(['compare', join(dir, 'b.json'), join(dir, 'x.json')], { env: {}, ...notReport }), 1);
  assert.match(notReport.o.err, /is not a ci-wizard --json report/);
  const missing = io();
  assert.equal(await cli(['compare', join(dir, 'b.json'), join(dir, 'nope.json')], { env: {}, ...missing }), 1);
  assert.match(missing.o.err, /no such file/);
});

test('--version prints the package version, and the usage lists it and compare', async () => {
  let out = '';
  assert.equal(await cli(['--version'], { env: {}, stdout: { write: (s) => (out += s) }, stderr: { write() {} } }), 0);
  assert.equal(out, `${VERSION}\n`);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version, 'src/version.mjs matches package.json');
  let help = '';
  await cli(['--help'], { env: {}, stdout: { write: (s) => (help += s) }, stderr: { write() {} } });
  assert.match(help, /ci-wizard compare before\.json after\.json/);
  assert.match(help, /ci-wizard --version/);
});

test('job helper sanity: the shared fixtures still build a sampled job', () => {
  assert.ok(job().steps.length > 0);
});

test('compare: a grouped finding whose workflow list changed is the same finding, not gone and new', () => {
  const tail = (where) => ({ what: 'self-hosted wrap-up tail', workflow: where, evidence: 'median 4 s', saving_min_week: 30, fix: 'f', confidence: 'measured' });
  const b = reportOf({ minutes: 2, wall: 60, tail: 5, findings: [tail('3 workflows: A, B, C')] });
  const a = reportOf({ minutes: 2, wall: 60, tail: 5, findings: [tail('4 workflows: A, B, C, D')] });
  const c = compareData(b, a);
  assert.deepEqual([c.gone.length, c.appeared.length], [0, 0]);
  assert.match(compare(b, a), /The same findings before and after\./);
});
