// The report, the HTML page, the action and the CLI, all against synthetic data and a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyse } from '../src/analyse.mjs';
import { report } from '../src/report.mjs';
import { html } from '../src/html.mjs';
import { run as runAction, input } from '../src/action-run.mjs';
import { main as cli } from '../src/cli.mjs';
import { data, fakeFetch, job, run, runs, t } from './helpers.mjs';

const steps = [['Set up job', 1], ['Install', 30], ['Run tests', 40], ['Complete job', 0]];
const wfFile = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Install\n        run: npm install\n      - name: Run tests\n        run: npm test\n';
const sample = () => analyse('owner/repo', data({ workflows: [{ name: 'CI <main>', runs: runs(20), jobsPerRun: [[job({ steps })]], file: wfFile }] }));

test('report: findings first, every saving called an estimate, and how it was measured', () => {
  const md = report(sample());
  assert.match(md, /^# CI audit: owner\/repo/);
  assert.ok(md.indexOf('## What to fix first') < md.indexOf('## Where the time goes'));
  assert.match(md, /### 1\. cache dependencies\n\n\*\*Where:\*\* CI <main>/);
  assert.match(md, /\*\*Confidence\*\* confirmed by the workflow file/);
  assert.match(md, /about \d+ job-min\/week \(estimate\)/);
  assert.match(md, /## How it was measured/);
  const saves = md.split('\n').filter((l) => l.startsWith('**Saves**'));
  assert.ok(saves.length >= 1);
  for (const line of saves) assert.match(line, /\(estimate\)|developer wait/);
});

test('report: a pipe in a workflow name cannot break the table', () => {
  const a = analyse('o/r', data({ workflows: [{ name: 'A | B', runs: runs(3) }] }));
  assert.match(report(a), /\| A \\\| B( †)? \|/);
});

test('html: workflow and step names are escaped', () => {
  const a = sample();
  a.api_calls = 7;
  const page = html([a]);
  assert.match(page, /^<!DOCTYPE html>/);
  assert.ok(page.includes('CI &lt;main&gt;'));
  assert.ok(!page.includes('CI <main>'));
  assert.match(page, /7 read-only API calls/);
});

function routes(runList, extra = {}) {
  return fakeFetch({
    'repos/o/r/actions/runs?': { workflow_runs: runList },
    'repos/o/r/actions/runs/': { jobs: [job({ steps })] },
    'repos/o/r/contents/.github/workflows/ci.yml': wfFile,
    'repos/o/r/contents': [{ name: 'package.json' }],
    ...extra,
  });
}
const now = new Date(Date.parse(t(7 * 86400)));
const ciRuns = () => Array.from({ length: 20 }, (_, i) => ({ ...run({ name: 'CI', at: i * 600 }), path: '.github/workflows/ci.yml' }));

test('action: inputs as the runner passes them', () => {
  assert.equal(input({ 'INPUT_PER-WORKFLOW': ' 3 ' }, 'per-workflow', '5'), '3');
  assert.equal(input({}, 'days', '7'), '7');
});

test('action: writes the report to the job summary and a file, and sets both outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ciw-'));
  const env = { INPUT_REPOSITORY: 'o/r', INPUT_TOKEN: 'x', RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), GITHUB_OUTPUT: join(dir, 'out.txt') };
  const out = [];
  const code = await runAction({ env, stdout: { write: (s) => out.push(s) }, fetchImpl: routes(ciRuns()), now });
  assert.equal(code, 0, out.join(''));
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /# CI audit: o\/r/);
  const outputs = readFileSync(env.GITHUB_OUTPUT, 'utf8');
  assert.match(outputs, /report-path=.*report\.md/);
  assert.match(outputs, /findings=\d+/);
  assert.ok(existsSync(join(dir, 'ci-wizard', 'report.json')));
});

test('action: no runs in the window is a short report, not a failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ciw-'));
  const env = { INPUT_REPOSITORY: 'o/r', RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, 's.md'), GITHUB_OUTPUT: join(dir, 'o.txt') };
  const code = await runAction({ env, stdout: { write() {} }, fetchImpl: routes([]), now });
  assert.equal(code, 0);
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /nothing to measure yet/);
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /findings=0/);
});

test('action: a bad repository input fails with an escaped error command', async () => {
  const out = [];
  const code = await runAction({ env: { INPUT_REPOSITORY: 'not a repo\n::set-output::x' }, stdout: { write: (s) => out.push(s) } });
  assert.equal(code, 1);
  assert.equal(out.length, 1);
  assert.match(out[0], /^::error::/);
  assert.ok(!out[0].slice(2).includes('\n::'), 'a newline in the input cannot start a second command');
});

test('action: no read access fails the step and says which permissions are needed', async () => {
  const out = [];
  const fetchImpl = fakeFetch({ 'repos/o/r/actions/runs': { __status: 403, json: { message: 'Resource not accessible by integration' } } });
  const code = await runAction({ env: { INPUT_REPOSITORY: 'o/r', RUNNER_TEMP: mkdtempSync(join(tmpdir(), 'ciw-')) }, stdout: { write: (s) => out.push(s) }, fetchImpl, now });
  assert.equal(code, 1);
  assert.match(out.join(''), /actions: read and contents: read/);
});

function cliIO() {
  const o = { out: '', err: '' };
  return { o, stdout: { write: (s) => (o.out += s) }, stderr: { write: (s) => (o.err += s) } };
}

test('cli: prints the markdown report, or JSON with --json', async () => {
  const io = cliIO();
  assert.equal(await cli(['o/r'], { env: { GITHUB_TOKEN: 'x' }, ...io, fetchImpl: routes(ciRuns()) }), 0);
  assert.match(io.o.out, /^# CI audit: o\/r/);
  const j = cliIO();
  assert.equal(await cli(['o/r', '--json'], { env: { GITHUB_TOKEN: 'x' }, ...j, fetchImpl: routes(ciRuns()) }), 0);
  assert.equal(JSON.parse(j.o.out).repo, 'o/r');
});

test('cli: usage errors exit 2', async () => {
  for (const args of [[], ['nope'], ['o/r', '--days', '0'], ['o/r', '--workflows', '2.5'], ['o/r', '--bogus']]) {
    const io = cliIO();
    assert.equal(await cli(args, { env: { GITHUB_TOKEN: 'x' }, ...io, cwd: tmpdir() }), 2, args.join(' '));
  }
});

test('cli: a rate-limit stop exits 3 and says so', async () => {
  const io = cliIO();
  const fetchImpl = fakeFetch({ 'repos/o/r/actions/runs': { __status: 403, headers: { 'x-ratelimit-remaining': '0' } } }, { remaining: 0 });
  assert.equal(await cli(['o/r'], { env: { GITHUB_TOKEN: 'x' }, ...io, fetchImpl }), 3);
  assert.match(io.o.err, /rate limit/);
});
