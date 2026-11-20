// Every rule against a synthetic pattern it must catch, and a near miss it must leave alone, so a
// mutant of the rule (a dropped condition, a moved threshold) fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, rerunSeconds, THRESHOLDS } from '../src/analyse.mjs';
import { data, find, job, run, runs, t } from './helpers.mjs';

const NODE_STEPS = (install) => [['Set up job', 1], ['Run actions/checkout@v4', 2], ['Run actions/setup-node@v4', 3], ['Install', install], ['Run tests', 40], ['Complete job', 0]];
const file = (setupWith = '', extra = '') => `name: CI
on:
  push:
    branches: [main]
  pull_request:
${extra}jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
${setupWith}      - name: Install
        run: npm install --ignore-scripts
      - name: Run tests
        run: npm test
`;
const audit = (workflows, o = {}) => analyse('owner/repo', data({ workflows, ...o }));

test('cache dependencies: installs over the per-job threshold with no cache in the file are confirmed, with a saving', () => {
  const a = audit([{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: NODE_STEPS(30) })]], file: file() }]);
  const [f] = find(a, 'cache dependencies');
  assert.ok(f, JSON.stringify(a.findings));
  assert.equal(f.confidence, 'confirmed');
  assert.match(f.evidence, /30 s per job/);
  assert.equal(f.saving_min_week, 6); // 0.6 x 30 s x 20 runs / 60
  assert.match(f.fix, /keyed on package\.json \(the repository commits no lockfile/);
});

test('cache dependencies: the fix names the lockfile the repository commits', () => {
  const a = audit([{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: NODE_STEPS(30) })]], file: file() }], { lockfiles: ['package-lock.json'] });
  assert.match(find(a, 'cache dependencies')[0].fix, /keyed on package-lock\.json/);
});

test('a cache inside setup-node counts as a cache: no "cache dependencies" finding', () => {
  const a = audit([{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: NODE_STEPS(30) })]], file: file('        with:\n          cache: npm\n') }]);
  assert.equal(find(a, 'cache dependencies').length, 0);
  assert.equal(a.workflows[0].has_cache, true);
});

test('dependency installs dominate: with a cache but no lockfile, npm install is explained and the fixes keep fresh dependencies', () => {
  const a = audit([{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: NODE_STEPS(30) })]], file: file('        with:\n          cache: npm\n          cache-dependency-path: package.json\n') }]);
  const [f] = find(a, 'dependency installs dominate');
  assert.ok(f, JSON.stringify(a.findings));
  assert.equal(f.confidence, 'confirmed');
  assert.match(f.evidence, /with no lockfile, `npm install` resolves the whole tree/);
  assert.match(f.fix, /--prefer-offline --no-audit --no-fund/);
});

test('dependency installs dominate: with a lockfile the generic cache check is suggested instead', () => {
  const a = audit([{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: NODE_STEPS(30) })]], file: file('        with:\n          cache: npm\n') }], { lockfiles: ['package-lock.json'] });
  const [f] = find(a, 'dependency installs dominate');
  assert.match(f.evidence, /with a cache configured/);
  assert.match(f.fix, /cache hit rate/);
});

test('dependency installs dominate: a cached install under 25% of the time and under 45 s a job is left alone', () => {
  const steps = [['Set up job', 1], ['Install', 10], ['Run tests', 120], ['Complete job', 0]];
  const a = audit([{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps })]], file: file('        with:\n          cache: npm\n') }]);
  assert.equal(find(a, 'dependency installs dominate').length, 0);
});

test('a step is classified by the command the workflow file gives it, not only by its name', () => {
  const withFile = audit([{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: NODE_STEPS(30) })]], file: file() }]);
  assert.ok(withFile.workflows[0].cats_secs_per_run.deps >= 30);
  const noFile = audit([{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: NODE_STEPS(30) })]] }]);
  assert.equal(noFile.workflows[0].cats_secs_per_run.deps, undefined, 'a step named "Install" alone says nothing');
  assert.equal(find(noFile, 'cache dependencies').length, 0);
});

test('thresholds are per job: a big matrix with short installs is not a dependency finding', () => {
  const jobs = Array.from({ length: 17 }, () => job({ steps: [['Set up job', 1], ['Install', 10], ['Run tests', 40], ['Complete job', 0]] }));
  const a = audit([{ name: 'CI', runs: runs(20), jobsPerRun: [jobs], file: file() }]);
  assert.ok(a.workflows[0].cats_secs_per_run.deps >= 170, 'per run it is large');
  assert.equal(find(a, 'cache dependencies').length, 0);
});

const dupRuns = (n, branch = 'feat/x') => Array.from({ length: n }, (_, i) => [
  run({ event: 'push', sha: `d${i}`, branch, at: i * 3600 }),
  run({ event: 'pull_request', sha: `d${i}`, branch, at: i * 3600 + 5 }),
]).flat();
const dupFile = (branches, group) => `name: CI
on:
  push:
    branches: [${branches}]
  pull_request:
concurrency:
  group: ${group}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

test('the same commit runs twice: push patterns and a number-keyed concurrency group are named as the cause', () => {
  const a = audit([{ name: 'CI', runs: dupRuns(5), file: dupFile("main, 'feat/*', 'fix/*'", '${{ github.workflow }}-${{ github.event.number || github.sha }}') }]);
  const [f] = find(a, 'the same commit runs twice');
  assert.ok(f, JSON.stringify(a.findings));
  assert.equal(f.confidence, 'confirmed');
  assert.match(f.evidence, /^5 commits a week/);
  assert.match(f.evidence, /also matches feat\/\*, fix\/\*/);
  assert.match(f.evidence, /keys pull requests by number and pushes by commit/);
  assert.match(f.fix, /drop those patterns/);
});

test('the same commit runs twice: with push on the default branch only it is measured, with the generic fix', () => {
  const a = audit([{ name: 'CI', runs: dupRuns(4), file: dupFile('main', '${{ github.workflow }}-${{ github.ref }}') }]);
  const [f] = find(a, 'the same commit runs twice');
  assert.equal(f.confidence, 'measured');
  assert.match(f.fix, /run on push only for the default branch/);
  assert.doesNotMatch(f.evidence, /keys pull requests by number/);
});

test('the same commit runs twice: the cheaper of the two runs is the saving, so a pull request run that skips the tests is priced as the short run it is', () => {
  const rs = dupRuns(10);
  const push = rs.find((r) => r.event === 'push');
  const pr = rs.find((r) => r.event === 'pull_request');
  // The push run tests for 600 s; the pull request run of the same commit skips the tests and runs one 60 s job.
  const jobsPerRun = [
    [job({ runId: push.id, steps: [['Run tests', 600]], wait: 0, head: 0, tail: 0 })],
    [job({ runId: pr.id, steps: [['Publish preview', 60]], wait: 0, head: 0, tail: 0 })],
  ];
  const a = audit([{ name: 'CI', runs: rs, jobsPerRun, file: dupFile("main, 'feat/*'", '${{ github.workflow }}-${{ github.event.number || github.sha }}') }]);
  const [f] = find(a, 'the same commit runs twice');
  assert.ok(f, JSON.stringify(a.findings));
  assert.equal(f.saving_min_week, 10); // 10 duplicate commits x the 1-minute pull request run, not the 5.5-minute mean
  assert.match(f.evidence, /the cheaper of the two is the pull request run, 60 s of job time \(the mean of 1 timed pull request run\)/);
  // The other way round: a push run cheaper than its pull request run prices the duplicate.
  const flipped = [
    [job({ runId: push.id, steps: [['Lint', 120]], wait: 0, head: 0, tail: 0 })],
    [job({ runId: pr.id, steps: [['Run tests', 600]], wait: 0, head: 0, tail: 0 })],
  ];
  const [g] = find(audit([{ name: 'CI', runs: rs, jobsPerRun: flipped, file: dupFile("main, 'feat/*'", 'x') }]), 'the same commit runs twice');
  assert.equal(g.saving_min_week, 20);
  assert.match(g.evidence, /the cheaper of the two is the push run/);
  // A pull request from a fork has no push run of its commit: its full test run does not price the duplicate.
  const fork = run({ event: 'pull_request', sha: 'fork1', branch: 'patch-1' });
  const withFork = [...jobsPerRun, [job({ runId: fork.id, steps: [['Run tests', 600]], wait: 0, head: 0, tail: 0 })]];
  const [h] = find(audit([{ name: 'CI', runs: [...rs, fork], jobsPerRun: withFork, file: dupFile("main, 'feat/*'", 'x') }]), 'the same commit runs twice');
  assert.equal(h.saving_min_week, 10);
});

test('the same commit runs twice: a sampled pull request run whose jobs were all skipped costs nothing, and prices the duplicate at zero', () => {
  const rs = dupRuns(10);
  const push = rs.find((r) => r.event === 'push');
  const pr = rs.find((r) => r.event === 'pull_request');
  // collect drops skipped jobs, so the pull request run's job list is empty; its run id comes with the sample.
  const jobsPerRun = [[job({ steps: [['Run tests', 600]], wait: 0, head: 0, tail: 0 })], []];
  const a = audit([{ name: 'CI', runs: rs, jobsPerRun, runIds: [push.id, pr.id], file: dupFile("main, 'feat/*'", 'x') }]);
  const [f] = find(a, 'the same commit runs twice');
  assert.ok(!f || f.saving_min_week === 0, JSON.stringify(f));
  const all = analyse('owner/repo', data({ workflows: [{ name: 'CI', runs: rs, jobsPerRun, runIds: [push.id, pr.id], file: dupFile("main, 'feat/*'", 'x') }] }));
  assert.deepEqual(all.workflows[0].run_minutes_by_kind.pull_request, { minutes: 0, sampled: 1 });
});

test('the same commit runs twice: without a timed run of both kinds the mean prices it, and the evidence says so', () => {
  const rs = dupRuns(5);
  const push = rs.find((r) => r.event === 'push');
  const a = audit([{ name: 'CI', runs: rs, jobsPerRun: [[job({ runId: push.id })]], file: dupFile("main, 'feat/*'", 'x') }]);
  const [f] = find(a, 'the same commit runs twice');
  assert.match(f.evidence, /no pull request run of a duplicated commit was timed in the sample, so each duplicate is priced at the workflow's mean run/);
  // Neither kind timed (a sampled job that names no run): both are named as missing.
  const [g] = find(audit([{ name: 'CI', runs: rs, file: dupFile("main, 'feat/*'", 'x') }]), 'the same commit runs twice');
  assert.match(g.evidence, /no push or pull request run of a duplicated commit was timed/);
});

test('the same commit runs twice: runs collect timed for the rule alone price the duplicate when the newest successes hold none', () => {
  const rs = dupRuns(10);
  const push = rs.find((r) => r.event === 'push');
  const pr = rs.find((r) => r.event === 'pull_request');
  // The newest successes are of no duplicated commit (a job naming no run); the extra runs are.
  const dup = [
    { id: push.id, jobs: [job({ steps: [['Run tests', 600]], wait: 0, head: 0, tail: 0 })] },
    { id: pr.id, jobs: [job({ steps: [['Publish preview', 60]], wait: 0, head: 0, tail: 0 })] },
  ];
  const a = audit([{ name: 'CI', runs: rs, dupRuns: dup, file: dupFile("main, 'feat/*'", 'x') }]);
  const [f] = find(a, 'the same commit runs twice');
  assert.ok(f, JSON.stringify(a.findings));
  assert.equal(f.saving_min_week, 10);
  assert.match(f.evidence, /the cheaper of the two is the pull request run, 60 s of job time \(the mean of 1 timed pull request run\)/);
  // An extra run of a commit that did not run on both events does not price it.
  const lone = run({ event: 'pull_request', sha: 'lone', branch: 'patch-1' });
  const [g] = find(audit([{ name: 'CI', runs: [...rs, lone], dupRuns: [dup[0], { id: lone.id, jobs: dup[1].jobs }], file: dupFile("main, 'feat/*'", 'x') }]), 'the same commit runs twice');
  assert.match(g.evidence, /no pull request run of a duplicated commit was timed/);
});

test('the same commit runs twice: under the weekly threshold is left alone', () => {
  const a = audit([{ name: 'CI', runs: dupRuns(THRESHOLDS.duplicateCommitsWeek - 1), file: dupFile("main, 'feat/*'", 'x') }]);
  assert.equal(find(a, 'the same commit runs twice').length, 0);
});

const prRuns = (n, conclusion = 'success') => Array.from({ length: n }, (_, i) => run({ event: 'pull_request', sha: `p${i}`, branch: 'fix/a', at: i * 300, wall: 600, conclusion: i === n - 1 ? 'success' : conclusion }));
const prFile = (cancel) => `on: pull_request\n${cancel ? 'concurrency:\n  group: x\n  cancel-in-progress: true\n' : ''}jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;

test('outdated runs keep going: overlapping pull request runs without cancel-in-progress', () => {
  const a = audit([{ name: 'CI', runs: prRuns(4), file: prFile(false) }]);
  const [f] = find(a, 'outdated runs keep going');
  assert.ok(f, JSON.stringify(a.findings));
  assert.match(f.evidence, /^3 pull request runs a week/);
});

test('outdated runs, split by event: each event counts its runs made outdated by a newer run of the same event', () => {
  // Four pull_request runs and three pull_request_target runs on one branch, each set overlapping its own.
  const pr = prRuns(4);
  const target = Array.from({ length: 3 }, (_, i) => run({ event: 'pull_request_target', sha: `t${i}`, branch: 'fix/a', at: 5000 + i * 300, wall: 600 }));
  const file = 'on: [pull_request, pull_request_target]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  const a = audit([{ name: 'CI', runs: [...pr, ...target], file }]);
  const w = a.workflows.find((x) => x.workflow === 'CI');
  assert.deepEqual(w.superseded_week_by_event, { pull_request: 3, pull_request_target: 2 });
  assert.equal(w.superseded_week, 5, 'both events together, as before');
  // The finding still counts both, with the same evidence text as before.
  const [f] = find(a, 'outdated runs keep going');
  assert.match(f.evidence, /^5 pull request runs a week were still running when a newer push to the same branch started a new run/);
  // A workflow on pull_request alone: the split holds every run on its own event.
  const only = audit([{ name: 'CI', runs: prRuns(4), file: prFile(false) }]).workflows.find((x) => x.workflow === 'CI');
  assert.deepEqual(only.superseded_week_by_event, { pull_request: 3, pull_request_target: 0 });
});

test('outdated runs keep going: cancel-in-progress, or runs that were cancelled, are left alone', () => {
  assert.equal(find(audit([{ name: 'CI', runs: prRuns(4), file: prFile(true) }]), 'outdated runs keep going').length, 0);
  assert.equal(find(audit([{ name: 'CI', runs: prRuns(4, 'cancelled'), file: prFile(false) }]), 'outdated runs keep going').length, 0);
});

test('reruns: one repository-level finding across workflows', () => {
  const a = audit([
    { name: 'CI', runs: [run({ attempt: 2 }), run()] },
    { name: 'Lint', path: '.github/workflows/lint.yml', runs: [run({ attempt: 3 }), run()] },
  ]);
  const f = find(a, 'reruns');
  assert.equal(f.length, 1);
  assert.equal(f[0].workflow, 'all workflows');
  assert.match(f[0].evidence, /^2 re-attempted runs/);
});

// A run's jobs of every attempt, as the jobs API lists them with filter=all: attempt 2 lists every
// job again, the ones kept from attempt 1 with attempt 1's times.
const attempts = (keptSeconds, rerunSeconds) => {
  const a1 = [
    { ...job({ steps: [['Run tests', keptSeconds]], wait: 0, head: 0, tail: 0 }), name: 'kept', run_attempt: 1 },
    { ...job({ steps: [['Run tests', rerunSeconds]], wait: 0, head: 0, tail: 0 }), name: 'flaky', run_attempt: 1, conclusion: 'failure' },
  ];
  const again = { ...job({ steps: [['Run tests', rerunSeconds]], wait: 0, head: 0, tail: 0, at: 3600 }), name: 'flaky', run_attempt: 2 };
  return [...a1, { ...a1[0], run_attempt: 2 }, again];
};

test('rerunSeconds: only the jobs a later attempt ran count, not the ones it kept from an earlier attempt', () => {
  assert.equal(rerunSeconds(attempts(600, 60)), 60);
  // Re-running every job counts every job.
  const all = attempts(600, 60).map((j, i) => (i === 2 ? { ...j, started_at: t(3600), completed_at: t(4200) } : j));
  assert.equal(rerunSeconds(all), 660);
  assert.equal(rerunSeconds([]), 0);
  // Two jobs of one name that a later attempt started in the same second are two jobs.
  const twin = { ...job({ steps: [['Run tests', 60]], wait: 0, head: 0, tail: 0, at: 3600 }), name: 'test', run_attempt: 2 };
  assert.equal(rerunSeconds([...attempts(600, 60), twin, { ...twin }]), 180);
  // Two kept jobs of one name and the same times are matched one for one: neither counts, and a
  // third copy in the later attempt does.
  const kept = { ...job({ steps: [['Run tests', 30]], wait: 0, head: 0, tail: 0 }), name: 'test', run_attempt: 1 };
  assert.equal(rerunSeconds([kept, { ...kept }, { ...kept, run_attempt: 2 }, { ...kept, run_attempt: 2 }]), 0);
  assert.equal(rerunSeconds([kept, { ...kept, run_attempt: 2 }, { ...kept, run_attempt: 2 }]), 30);
  // A job kept through two reruns is a copy of the attempt before each time.
  assert.equal(rerunSeconds([...attempts(600, 60), ...attempts(600, 60).filter((j) => j.run_attempt === 2).map((j) => ({ ...j, run_attempt: 3 }))]), 60);
});

test('reruns: priced at what the reruns read ran, not a whole run; a workflow with none read is priced at a whole run and said so', () => {
  const ten = () => job({ steps: [['Run tests', 600]], wait: 0, head: 0, tail: 0 });
  const a = audit([{ name: 'CI', runs: [run({ attempt: 2 }), run()], jobsPerRun: [[ten()]], rerunJobs: [attempts(600, 60)] }]);
  const [f] = find(a, 'reruns');
  assert.ok(f, JSON.stringify(a.findings));
  assert.equal(f.saving_min_week, 1); // 1 rerun x the 1 minute it re-ran, not the 10-minute run
  assert.equal(f.confidence, 'measured');
  assert.match(f.evidence, /the later attempts of 1 read ran 60 s of job time each on the mean/);
  const b = audit([
    { name: 'CI', runs: [run({ attempt: 2 }), run()], jobsPerRun: [[ten()]], rerunJobs: [attempts(600, 60)] },
    { name: 'Lint', path: '.github/workflows/lint.yml', runs: [run({ attempt: 2 }), run()], jobsPerRun: [[ten()]] },
  ]);
  const [g] = find(b, 'reruns');
  assert.equal(g.saving_min_week, 11);
  assert.equal(g.confidence, 'inferred');
  assert.match(g.evidence, /1 rerun of Lint was not read and is priced at a whole run/);
});

test('matrix size: many jobs and many job-minutes per run is an option, not a fault; a small matrix is left alone', () => {
  const jobs = (n) => Array.from({ length: n }, () => job({ steps: [['Run tests', 60]], head: 0, tail: 0 }));
  const big = audit([{ name: 'CI', runs: runs(10), jobsPerRun: [jobs(9)] }]);
  const [f] = find(big, 'matrix size');
  assert.ok(f);
  assert.equal(f.saving_min_week, 0);
  assert.match(f.fix, /^an option, not a fault/);
  assert.equal(find(audit([{ name: 'CI', runs: runs(10), jobsPerRun: [jobs(7)] }]), 'matrix size').length, 0);
});

test('self-hosted wrap-up tail: only on self-hosted runners, and only over 4 s', () => {
  // 100 runs a week: at 10 the 4 s excess saves under a minute a week, which the report leaves out.
  const self = audit([{ name: 'CI', runs: runs(100), jobsPerRun: [[job({ selfHosted: true, tail: 6 })]] }]);
  assert.equal(find(self, 'self-hosted wrap-up tail').length, 1);
  assert.equal(find(audit([{ name: 'CI', runs: runs(100), jobsPerRun: [[job({ selfHosted: false, tail: 6 })]] }]), 'self-hosted wrap-up tail').length, 0);
  assert.equal(find(audit([{ name: 'CI', runs: runs(100), jobsPerRun: [[job({ selfHosted: true, tail: 3 })]] }]), 'self-hosted wrap-up tail').length, 0);
});

test('queue wait: a p90 over 30 s', () => {
  assert.equal(find(audit([{ name: 'CI', runs: runs(10), jobsPerRun: [[job({ wait: 45 })]] }]), 'queue wait').length, 1);
  assert.equal(find(audit([{ name: 'CI', runs: runs(10), jobsPerRun: [[job({ wait: 10 })]] }]), 'queue wait').length, 0);
});

test('many short jobs: six or more jobs averaging under a minute', () => {
  const jobs = (n) => Array.from({ length: n }, () => job({ steps: [['Set up job', 2], ['Run lint', 15]] }));
  assert.equal(find(audit([{ name: 'CI', runs: runs(10), jobsPerRun: [jobs(6)] }]), 'many short jobs').length, 1);
  assert.equal(find(audit([{ name: 'CI', runs: runs(10), jobsPerRun: [jobs(5)] }]), 'many short jobs').length, 0);
});

test('slow checkout: 12 s or more per job', () => {
  const steps = (s) => [['Run actions/checkout@v4', s], ['Run tests', 30]];
  assert.equal(find(audit([{ name: 'CI', runs: runs(10), jobsPerRun: [[job({ steps: steps(15) })]] }]), 'slow checkout').length, 1);
  assert.equal(find(audit([{ name: 'CI', runs: runs(10), jobsPerRun: [[job({ steps: steps(10) })]] }]), 'slow checkout').length, 0);
});

test('toolchain setup: inferred, and noted as including the cache restore when setup-node caches', () => {
  const steps = [['Run actions/setup-node@v4', 20], ['Run tests', 30]];
  const a = audit([{ name: 'CI', runs: runs(10), jobsPerRun: [[job({ steps })]], file: file('        with:\n          cache: npm\n') }]);
  const [f] = find(a, 'toolchain setup');
  assert.equal(f.confidence, 'inferred');
  assert.match(f.evidence, /includes restoring the dependency cache/);
  const short = audit([{ name: 'CI', runs: runs(10), jobsPerRun: [[job({ steps: [['Run actions/setup-node@v4', 10], ['Run tests', 30]] })]] }]);
  assert.equal(find(short, 'toolchain setup').length, 0);
});

test('runs far more often than code changes: a workflow_run-triggered job at 500+ runs a week; the same volume from pushes is not fan-out', () => {
  const chained = audit([{ name: 'Status', runs: runs(600, { event: 'workflow_run' }), jobsPerRun: [[job({ steps: [['Run status', 3]], head: 2, tail: 4 })]] }]);
  const [f] = find(chained, 'runs far more often than code changes');
  assert.ok(f, JSON.stringify(chained.findings));
  assert.match(f.evidence, /^600 runs a week \(workflow_run 600 in the window\)/);
  assert.equal(find(audit([{ name: 'CI', runs: runs(600, { event: 'push' }) }]), 'runs far more often than code changes').length, 0);
});

test('many small scheduled jobs: three or more short periodic workflows, scheduled or dispatched on a clock', () => {
  const periodic = (name, event) => ({ name, path: `.github/workflows/${name}.yml`, runs: runs(50, { event }), jobsPerRun: [[job({ steps: [['Run check', 5]] })]] });
  const three = audit([periodic('a', 'schedule'), periodic('b', 'workflow_dispatch'), periodic('c', 'schedule')]);
  const [f] = find(three, 'many small scheduled jobs');
  assert.ok(f, JSON.stringify(three.findings));
  assert.match(f.evidence, /^3 periodic workflows/);
  assert.equal(find(audit([periodic('a', 'schedule'), periodic('b', 'schedule')]), 'many small scheduled jobs').length, 0);
  const long = { name: 'c', path: '.github/workflows/c.yml', runs: runs(50, { event: 'schedule' }), jobsPerRun: [[job({ steps: [['Run check', 60]] })]] };
  assert.equal(find(audit([periodic('a', 'schedule'), periodic('b', 'schedule'), long]), 'many small scheduled jobs').length, 0, 'a job over 30 s is not small');
});

test('grouping: one finding per repeated kind, workflows listed, savings summed', () => {
  const w = (name, tail) => ({ name, path: `.github/workflows/${name}.yml`, runs: runs(100), jobsPerRun: Array.from({ length: 3 }, () => [job({ selfHosted: true, tail })]) });
  const a = audit([w('one', 8), w('two', 6)]);
  const f = find(a, 'self-hosted wrap-up tail');
  assert.equal(f.length, 1);
  assert.match(f[0].workflow, /^2 workflows: one, two$/);
  // Each workflow's own figure and saving, largest first, not the largest's alone.
  assert.equal(f[0].evidence, 'median time after the last step before a job reports done (GitHub-hosted is about 2 s), by workflow: one 8 s, about 10 job-min/week; two 6 s, about 7 job-min/week');
  // (8 - 2) s x 100 runs / 60 + (6 - 2) s x 100 runs / 60
  assert.equal(f[0].saving_min_week, 16.7);
  // A thinly sampled workflow is marked as such in the merged evidence.
  const thin = { name: 'three', path: '.github/workflows/three.yml', runs: runs(100), jobsPerRun: [[job({ selfHosted: true, tail: 7 })]] };
  const [g] = find(audit([w('one', 8), thin]), 'self-hosted wrap-up tail');
  assert.match(g.evidence, /; three 7 s, about 8 job-min\/week, timed from only 1 successful run$/);
  // Members each under a minute a week still show their saving, when together they are reported.
  const small = (name) => ({ name, path: `.github/workflows/${name}.yml`, runs: runs(6), jobsPerRun: Array.from({ length: 3 }, () => [job({ selfHosted: true, tail: 8 })]) });
  const [h] = find(audit([small('a'), small('b')]), 'self-hosted wrap-up tail');
  assert.ok(h, 'two members of 0.6 job-min/week each make a 1.2 job-min/week finding');
  assert.equal(h.evidence, 'median time after the last step before a job reports done (GitHub-hosted is about 2 s), by workflow: a 8 s, under 1 job-min/week; b 8 s, under 1 job-min/week');
  // Queue wait saves no minutes: its members are ordered by the wait, not by job minutes.
  const queued = (name, wait, seconds) => ({ name, path: `.github/workflows/${name}.yml`, runs: runs(50), jobsPerRun: Array.from({ length: 3 }, () => [job({ wait, steps: [['Run make', seconds]] })]) });
  const [q] = find(audit([queued('busy', 30, 600), queued('starved', 120, 60)]), 'queue wait');
  assert.match(q.workflow, /^2 workflows: starved, busy$/);
  assert.match(q.evidence, /^p90 wait for a runner, by workflow: starved 120 s over 3 sampled jobs; busy 30 s over 3 sampled jobs$/);
});

test('findings are ranked by estimated saving, largest first', () => {
  const a = audit([{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: NODE_STEPS(30), wait: 45 })]], file: file() }]);
  const s = a.findings.map((f) => f.saving_min_week);
  assert.deepEqual(s, [...s].sort((x, y) => y - x));
});
