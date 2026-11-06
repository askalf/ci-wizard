// Measurement precision: a weekly total is a count times a mean, every outcome is costed at its own
// measured cost, and a job's timeout is judged against its own longest sampled run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { analyse, measureWorkflow } from '../src/analyse.mjs';
import { collect } from '../src/collect.mjs';
import { createClient } from '../src/github.mjs';
import { assignJobRuns, jobRunsOf, jobTimeouts, parseWorkflow } from '../src/workflow.mjs';
import { report, savingText, summary } from '../src/report.mjs';
import { data, fakeFetch, find, job, runs, t } from './helpers.mjs';

/** One job of `seconds`, named `name`. */
const timed = (seconds, name = 'test') => ({ ...job({ steps: [['Set up job', 0], ['Run tests', seconds - 3], ['Complete job', 0]], head: 1, tail: 2 }), name });

test('a weekly total is runs times the mean run, and the typical run stays the median', () => {
  const w = measureWorkflow('CI', runs(10), [[timed(60)], [timed(60)], [timed(600)]], '', 1);
  assert.equal(w.job_minutes_per_run, 1); // median 60 s
  assert.equal(w.job_minutes_per_run_mean, 4); // mean 240 s
  assert.equal(w.job_minutes_week, 40); // 10 runs x 240 s, not 10 x 60 s
});

test('every outcome is costed at its own sampled cost; an unsampled one like a success, marked', () => {
  const rs = [
    ...runs(10),
    ...runs(5, { conclusion: 'failure' }),
    ...runs(2, { conclusion: 'timed_out' }),
    ...runs(3, { conclusion: 'cancelled' }),
  ];
  const w = measureWorkflow('CI', rs, [[timed(60)]], '', 1, 'o/r', { failure: [[timed(20)], [timed(20)]], timed_out: [[timed(3600)]] });
  // 10 x 60 + 5 x 20 + 2 x 3600 + 3 x 60 (cancelled, unsampled, costed like a success)
  assert.equal(w.job_minutes_week, Math.round(((10 * 60 + 5 * 20 + 2 * 3600 + 3 * 60) / 60) * 10) / 10);
  assert.equal(w.cost_by_outcome.failure.minutes_per_run, 0.33);
  assert.equal(w.cost_by_outcome.failure.sampled, 2);
  assert.equal(w.cost_by_outcome.timed_out.minutes_per_run, 60);
  assert.equal(w.cost_by_outcome.cancelled.estimated, true);
  assert.equal(w.cost_by_outcome.success.estimated, false);
  // Billed minutes follow the same outcomes: a 20 s failure bills one minute, a timeout 60.
  assert.equal(w.billed_minutes_week, 10 * 1 + 5 * 1 + 2 * 60 + 3 * 1);
});

test('runs that ran no job cost nothing but still count as runs', () => {
  const rs = [...runs(4), ...['skipped', 'action_required', 'startup_failure', 'stale'].flatMap((c) => runs(2, { conclusion: c }))];
  const w = measureWorkflow('CI', rs, [[timed(60)]], '', 1);
  assert.equal(w.runs_week, 12);
  assert.equal(w.job_minutes_week, 4);
});

test('the report says how the weekly cost is built, and names workflows with an estimated outcome', () => {
  const d = data({ workflows: [{ name: 'CI', runs: [...runs(5), ...runs(3, { conclusion: 'cancelled' })], jobsPerRun: [[timed(60)]] }] });
  const md = report(analyse('o/r', d));
  assert.match(md, /Job-min\/run \(typical\)/);
  assert.match(md, /Weekly cost is a count times a mean, per outcome/);
  assert.match(md, /Where an outcome had no sampled run, it is costed like a success: CI\./);
});

test('collect samples a few failed, cancelled and timed-out runs as well as successes', async () => {
  const list = [...runs(6), ...runs(4, { conclusion: 'failure' }), ...runs(1, { conclusion: 'timed_out' }), ...runs(3, { conclusion: 'cancelled' })]
    .map((r) => ({ ...r, path: '.github/workflows/ci.yml' }));
  const asked = [];
  const fetchImpl = fakeFetch({ 'repos/o/r/actions/runs?': { workflow_runs: list }, 'repos/o/r/actions/runs/': { jobs: [timed(30)] }, 'repos/o/r/contents/': [] }, { calls: asked });
  const d = await collect(createClient({ fetchImpl }), 'o/r', { perWorkflow: 3, perOutcome: 2, now: new Date(Date.parse(t(7 * 86400))) });
  const outcomes = d.outcomeSamples.get('CI');
  assert.equal(d.samples.get('CI').length, 3);
  assert.equal(outcomes.failure.length, 2);
  assert.equal(outcomes.cancelled.length, 2);
  assert.equal(outcomes.timed_out.length, 1);
  assert.equal(asked.filter((u) => u.includes('/jobs?')).length, 3 + 2 + 2 + 1);
});

test('the per-run savings multiply by the mean run', () => {
  const file = "on:\n  push:\n    branches: [main, 'dev/**']\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps: [{run: make}]\n";
  const rs = [...runs(10, { event: 'push', branch: 'dev/a' }), ...runs(10, { event: 'pull_request', branch: 'dev/a' })].map((r, i) => ({ ...r, head_sha: `c${i % 10}` }));
  const a = analyse('o/r', data({ workflows: [{ name: 'CI', runs: rs, jobsPerRun: [[timed(60)], [timed(60)], [timed(600)]], file }] }));
  const [dup] = find(a, 'the same commit runs twice');
  assert.equal(dup.saving_min_week, 40); // 10 duplicate commits x the 4-minute mean, not the 1-minute median
});

test('jobTimeouts and jobRunsOf: the file\'s limits, and the API names that are runs of a job', () => {
  const doc = parseWorkflow([
    'on: push', 'jobs:',
    '  test:', '    runs-on: ubuntu-latest', '    steps: [{run: make}]',
    '  build:', '    name: Build app', '    timeout-minutes: 20', '    runs-on: ubuntu-latest', '    steps: [{run: make}]',
    '  quoted:', "    timeout-minutes: '15'", '    runs-on: ubuntu-latest', '    steps: [{run: make}]',
    '  dynamic:', '    timeout-minutes: ${{ inputs.t }}', '    runs-on: ubuntu-latest', '    steps: [{run: make}]',
    '  call:', '    uses: ./.github/workflows/other.yml',
  ].join('\n'));
  assert.deepEqual(jobTimeouts(doc), [
    { id: 'test', name: 'test', minutes: 360, isDefault: true },
    { id: 'build', name: 'Build app', minutes: 20, isDefault: false },
    { id: 'quoted', name: 'quoted', minutes: 15, isDefault: false },
  ]);
  const names = ['test (20)', 'test (22)', 'testing', 'Build app', 'Lint on ubuntu'];
  assert.deepEqual(jobRunsOf('test', names), ['test (20)', 'test (22)']);
  assert.deepEqual(jobRunsOf('Build app', names), ['Build app']);
  assert.deepEqual(jobRunsOf('Lint on ${{ matrix.os }}', names), ['Lint on ubuntu']);
  assert.deepEqual(jobRunsOf('${{ matrix.name }}', names), []);
});

const timeoutFile = (timeout) => `on: push\njobs:\n  test:\n${timeout === undefined ? '' : `    timeout-minutes: ${timeout}\n`}    runs-on: ubuntu-latest\n    steps: [{run: make}]\n`;
const timeoutAudit = (timeout, seconds = 240) => analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(10), jobsPerRun: [[timed(seconds, 'test (20)')], [timed(seconds / 2, 'test (22)')]], file: timeoutFile(timeout) }] }));

test('jobs without a working timeout: a limit from the job\'s longest sampled run', () => {
  const [f] = find(timeoutAudit(undefined), 'jobs without a working timeout');
  assert.ok(f);
  assert.equal(f.unit, 'guard');
  assert.match(f.evidence, /job test \(no timeout-minutes, so GitHub's 360; longest of 2 sampled runs 4\.0 min\)/);
  assert.match(f.evidence, /billing every minute/);
  const y = parse(f.example);
  assert.equal(y.jobs.test['timeout-minutes'], 15); // 3 x 4 min = 12, up to 15
  assert.equal(savingText(f), 'a guard against hung jobs, not minutes');
  const lines = summary(timeoutAudit(undefined)).join('\n');
  assert.match(lines, /1 finding guards against hung jobs\./);
  // With no saving among the findings, the summary makes no claim about savings.
  assert.doesNotMatch(lines, /Savings are estimates/);
});

test('jobs without a working timeout: a loose limit fires, a working one and unmeasured jobs do not', () => {
  assert.equal(find(timeoutAudit(300), 'jobs without a working timeout').length, 1); // 300 > 10 x 4 min
  assert.equal(find(timeoutAudit(15), 'jobs without a working timeout').length, 0);
  assert.equal(find(timeoutAudit('${{ inputs.t }}'), 'jobs without a working timeout').length, 0);
  // The floor: a 20 s job still gets 10 minutes.
  const [short] = find(timeoutAudit(undefined, 20), 'jobs without a working timeout');
  assert.equal(parse(short.example).jobs.test['timeout-minutes'], 10);
  // A job the sample never ran is not judged.
  const unmeasured = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(10), jobsPerRun: [[timed(60, 'other')]], file: timeoutFile(undefined) }] }));
  assert.equal(find(unmeasured, 'jobs without a working timeout').length, 0);
});

test('job names with expressions match on every literal part, and an ambiguous run goes to no job', () => {
  const names = ['Test ubuntu unit', 'Test macos unit', 'Lint'];
  assert.deepEqual(jobRunsOf('Test ${{ matrix.os }} integration', names), []);
  assert.deepEqual(jobRunsOf('Test ${{ matrix.os }} unit', names), ['Test ubuntu unit', 'Test macos unit']);
  const assigned = assignJobRuns(['Test ${{ matrix.os }} unit', 'Test ${{ matrix.os }} integration', 'Lint'], names);
  assert.deepEqual(assigned.get('Test ${{ matrix.os }} integration'), []);
  assert.deepEqual(assigned.get('Test ${{ matrix.os }} unit'), ['Test ubuntu unit', 'Test macos unit']);
  // The more specific pattern wins; equally specific ones leave the run unassigned.
  assert.deepEqual(assignJobRuns(['${{ matrix.x }}', 'Lint'], ['Lint']).get('Lint'), ['Lint']);
  assert.deepEqual(assignJobRuns(['A ${{ matrix.x }}', '${{ matrix.y }} B'], ['A B']).get('A ${{ matrix.x }}'), []);
  // A static name keeps its matrix legs and no other job's.
  assert.deepEqual(jobRunsOf('test', ['test (20)', 'test-e2e', 'tests']), ['test (20)']);
});

test('an unmeasured job is not judged on a job that shares its prefix', () => {
  const file = 'on: push\njobs:\n  unit:\n    name: Test ${{ matrix.os }} unit\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps: [{run: make}]\n  integration:\n    name: Test ${{ matrix.os }} integration\n    runs-on: ubuntu-latest\n    steps: [{run: make}]\n';
  const a = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(10), jobsPerRun: [[timed(240, 'Test ubuntu unit')]], file }] }));
  assert.equal(find(a, 'jobs without a working timeout').length, 0);
});

test('a suggestion never reaches the limit the job already has: long jobs are left alone', () => {
  // 3 x 180 min = 540, at or above GitHub's 360: nothing to tighten.
  assert.equal(find(timeoutAudit(undefined, 180 * 60), 'jobs without a working timeout').length, 0);
  // 3 x 110 min = 330, under 360: a real guard.
  const [f] = find(timeoutAudit(undefined, 110 * 60), 'jobs without a working timeout');
  assert.equal(parse(f.example).jobs.test['timeout-minutes'], 330);
  // An explicit limit is never "fixed" upward.
  assert.equal(find(timeoutAudit(200, 100 * 60), 'jobs without a working timeout').length, 0);
});
