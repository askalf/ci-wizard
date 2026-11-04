// Precision and ease-of-use fixes after 0.1.1: the covered window, step classification, matrix
// step names, skipped runs, the hosted runner check, thin samples, the report summary and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyse, measureWorkflow } from '../src/analyse.mjs';
import { report } from '../src/report.mjs';
import { collect } from '../src/collect.mjs';
import { createClient } from '../src/github.mjs';
import { category, categoryOf, parseWorkflow, stepCommands } from '../src/workflow.mjs';
import { main as cli, parseRepo } from '../src/cli.mjs';
import { data, fakeFetch, job, run, runs, t } from './helpers.mjs';

const now = new Date(Date.parse(t(7 * 86400)));

test('collect: a window that holds every run is the window asked for, not oldest-run-to-now', async () => {
  // 10 runs, all in the last day of a 7-day window: they are 10 runs a week, not 70.
  const recent = Array.from({ length: 10 }, (_, i) => run({ at: 6 * 86400 + i * 600 }));
  const client = createClient({ fetchImpl: fakeFetch({ 'repos/o/r/actions/runs?': { workflow_runs: recent }, 'repos/o/r/actions/runs/': { jobs: [job()] }, 'repos/o/r/contents/': [] }) });
  const d = await collect(client, 'o/r', { days: 7, now });
  assert.equal(d.coveredDays, 7);
  assert.equal(d.truncated, false);
  assert.equal(analyse('o/r', d).workflows[0].runs_week, 10);
});

test('collect: a window cut short by the run cap covers oldest-run-to-now, and says so', async () => {
  const page = (p) => Array.from({ length: 100 }, (_, i) => run({ at: 7 * 86400 - (p * 100 + i) * 60 }));
  const fetchImpl = fakeFetch({
    'repos/o/r/actions/runs?': (path) => ({ workflow_runs: page(Number(/[?&]page=(\d+)/.exec(path)[1]) - 1) }),
    'repos/o/r/actions/runs/': { jobs: [job()] },
    'repos/o/r/contents/': [],
  });
  const progress = [];
  const d = await collect(createClient({ fetchImpl }), 'o/r', { days: 7, now, maxPages: 2, onProgress: (m) => progress.push(m) });
  assert.equal(d.truncated, true);
  assert.ok(d.coveredDays < 1, String(d.coveredDays));
  assert.ok(progress.some((m) => /^timing CI \(1\/1\)$/.test(m)), progress.join('; '));
  const a = analyse('o/r', d);
  assert.equal(a.window_truncated, true);
  assert.match(report(a), /run cap was reached/);
});

test('category: `yarn test` is work, `yarn` and `yarn install --frozen-lockfile` are installs', () => {
  assert.equal(category('yarn test'), 'work');
  assert.equal(category('Run yarn lint'), 'work');
  assert.equal(category('yarn'), 'deps');
  assert.equal(category('Run yarn --frozen-lockfile'), 'deps');
  assert.equal(category('yarn install --immutable'), 'deps');
});

test('category: a test suite named "checkout" is work; actions/checkout and Checkout steps are checkout', () => {
  assert.equal(category('Run checkout e2e tests'), 'work');
  assert.equal(category('npm run test:checkout'), 'work');
  assert.equal(category('Run actions/checkout@v4'), 'checkout');
  assert.equal(category('Post Run actions/checkout@v4'), 'checkout');
  assert.equal(category('Checkout code'), 'checkout');
  assert.equal(category('Check out repository'), 'checkout');
});

test('categoryOf: a step name with a matrix expression matches its command once expanded', () => {
  const doc = parseWorkflow('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Prepare ${{ matrix.node }} (${{ matrix.os }})\n        run: |\n          echo hi\n          pnpm install\n');
  const cmds = stepCommands(doc);
  assert.equal(categoryOf('Prepare 20 (ubuntu-latest)', cmds), 'deps');
  assert.equal(categoryOf('Post Prepare 22 (windows-latest)', cmds), 'deps');
  assert.equal(categoryOf('Prepared elsewhere', cmds), 'work');
});

test('measure: runs whose jobs were all skipped count as runs but cost no job-minutes', () => {
  const rs = [...runs(10), ...runs(10, { conclusion: 'skipped' })];
  const w = measureWorkflow('CI', rs, [[job()]], '', 1);
  assert.equal(w.runs_week, 20);
  assert.equal(w.skipped_week, 10);
  const all = measureWorkflow('CI', runs(10), [[job()]], '', 1);
  assert.equal(w.job_minutes_week, all.job_minutes_week);
});

test('measure: the runner group decides hosted, not an ubuntu-* label on a self-hosted runner', () => {
  const selfHosted = { ...job({ selfHosted: true }), labels: ['self-hosted', 'ubuntu-22.04'], runner_group_name: 'Default' };
  const hosted = { ...job(), runner_group_name: 'GitHub Actions' };
  assert.equal(measureWorkflow('CI', runs(3), [[selfHosted]], '', 1).hosted_share, 0);
  assert.equal(measureWorkflow('CI', runs(3), [[hosted]], '', 1).hosted_share, 1);
});

test('thin samples: flagged on the workflow, in the finding evidence and in the table', () => {
  const steps = [['Set up job', 1], ['Install', 30], ['Run tests', 40], ['Complete job', 0]];
  const file = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Install\n        run: npm ci\n';
  const thin = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps })]], file }] }));
  assert.equal(thin.workflows[0].thin_sample, true);
  assert.match(thin.findings[0].evidence, /timed from only 1 successful run\)$/);
  assert.match(report(thin), /\| CI † \|/);
  const full = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps })], [job({ steps })], [job({ steps })]], file }] }));
  assert.equal(full.workflows[0].thin_sample, false);
  assert.doesNotMatch(full.findings[0].evidence, /timed from only/);
});

test('report: a summary of the estimated total against the measured total, and the next step', () => {
  const steps = [['Set up job', 1], ['Install', 30], ['Run tests', 40], ['Complete job', 0]];
  const file = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Install\n        run: npm ci\n';
  const a = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps })]], file }] }));
  const md = report(a);
  assert.match(md, /\*\*1 finding\*\*, together about \d+ of the \d+ job-minutes a week/);
  assert.match(md, /upper bound/);
  assert.match(md, /## Next step: prove the fix/);
  assert.ok(md.indexOf('**1 finding**') < md.indexOf('## What to fix first'));
});

test('parseRepo: owner/repo, URLs and remotes', () => {
  assert.equal(parseRepo('askalf/ci-wizard'), 'askalf/ci-wizard');
  assert.equal(parseRepo('https://github.com/askalf/ci-wizard'), 'askalf/ci-wizard');
  assert.equal(parseRepo('https://github.com/askalf/ci-wizard.git'), 'askalf/ci-wizard');
  assert.equal(parseRepo('https://github.com/askalf/ci-wizard/actions/workflows/ci.yml'), 'askalf/ci-wizard');
  assert.equal(parseRepo('github.com/askalf/ci-wizard'), 'askalf/ci-wizard');
  assert.equal(parseRepo('git@github.com:askalf/ci-wizard.git'), 'askalf/ci-wizard');
  assert.equal(parseRepo('ssh://git@github.com/askalf/ci-wizard.git'), 'askalf/ci-wizard');
  assert.equal(parseRepo('https://gitlab.com/askalf/ci-wizard'), null);
  assert.equal(parseRepo('nope'), null);
  assert.equal(parseRepo(''), null);
});

function cliIO() {
  const o = { out: '', err: '' };
  return { o, stdout: { write: (s) => (o.out += s) }, stderr: { write: (s) => (o.err += s) } };
}
const routes = () => fakeFetch({
  'repos/o/r/actions/runs?': { workflow_runs: runs(5) },
  'repos/o/r/actions/runs/': { jobs: [job()] },
  'repos/o/r/contents/': [],
});

test('cli: a URL works, --save keeps the JSON beside the markdown and says how to compare', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ciw-'));
  const saved = join(dir, 'before.json');
  const io = cliIO();
  assert.equal(await cli(['https://github.com/o/r', '--save', saved], { env: {}, token: 'x', ...io, fetchImpl: routes() }), 0);
  assert.match(io.o.out, /^# CI audit: o\/r/);
  assert.equal(JSON.parse(readFileSync(saved, 'utf8')).repo, 'o/r');
  assert.match(io.o.err, /ci-wizard compare .*before\.json <after>\.json/);
});

test('cli: with no token it warns about the anonymous limit, and says why a repository is not found', async () => {
  const io = cliIO();
  assert.equal(await cli(['o/missing'], { env: {}, token: '', ...io, fetchImpl: fakeFetch({}) }), 1);
  assert.match(io.o.err, /no token found/);
  assert.match(io.o.err, /only public repositories/);
});

test('cli: a bad repository argument says what it expected', async () => {
  const io = cliIO();
  assert.equal(await cli(['https://gitlab.com/o/r'], { env: {}, token: 'x', ...io }), 2);
  assert.match(io.o.err, /is not owner\/repo or a GitHub repository URL/);
});

test('compare: a report from before the window fix is called out against a newer one', async () => {
  const { compare } = await import('../src/compare.mjs');
  const a = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(5) }] }));
  const old = { ...a };
  delete old.window_truncated;
  assert.match(compare(old, a), /0\.1\.1 or earlier/);
  assert.doesNotMatch(compare(a, a), /0\.1\.1 or earlier/);
});
