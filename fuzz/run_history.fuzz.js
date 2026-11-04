// Fuzz the run-history path: workflow runs, jobs and steps as the GitHub Actions API returns them,
// through analyse() into the markdown report, the HTML page and the JSON that `compare` reads
// back. Names, branches, events and the workflow file text are free-form strings from other
// people's repositories, and timestamps arrive in any order (clock skew, reruns, a job that
// finished before it started). The input bytes are decoded into that shape with
// FuzzedDataProvider so every execution is a well-typed history, not a rejected JSON parse.
// Contracts: analyse, report and html never throw; every value in the result is defined and every
// number is finite (an undefined, NaN or Infinity would print as a nonsense figure in the
// report); the JSON round trip into `compare` does not throw, and a report compared with itself
// shows no changed findings.
import { createRequire } from 'node:module';
import { analyse } from '../src/analyse.mjs';
import { compare, compareData } from '../src/compare.mjs';
import { html } from '../src/html.mjs';
import { report } from '../src/report.mjs';

// Jazzer is installed under .clusterfuzzlite/ (kept out of the package's own dependencies), so it is
// resolved from there rather than from the repository's node_modules.
const { FuzzedDataProvider } = createRequire(new URL('../.clusterfuzzlite/package.json', import.meta.url))('@jazzer.js/core');

const BASE = Date.parse('2026-01-05T10:00:00Z');
const EVENTS = ['push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_dispatch', 'workflow_run', 'repository_dispatch'];
const CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped', null];
const STATUSES = ['completed', 'in_progress', 'queued'];
const STEP_NAMES = [
  'Set up job', 'Run actions/checkout@v4', 'Run actions/setup-node@v4', 'Run npm ci', 'Run npm test', 'Cache npm',
  'Post Run actions/cache@v4', 'Upload artifact', 'Build and push Docker image', 'Complete job',
];
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'Cargo.lock'];
const FILES = [
  '',
  'on: [push, pull_request]\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          cache: npm\n      - run: npm ci\n      - run: npm test\n',
  'on: push\nconcurrency:\n  group: ci\n  cancel-in-progress: true\njobs:\n  a:\n    steps:\n      - name: Test on ${{ matrix.node }}\n        run: npm install\n',
];

function fail(msg) {
  throw new Error(msg);
}

// An ISO timestamp within a few days of BASE, in seconds, so runs overlap, tie and invert.
function iso(p) {
  const offset = p.consumeIntegralInRange(-3600, 4 * 86400);
  return new Date(BASE + offset * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

function text(p, pool) {
  return p.consumeBoolean() ? p.pickValue(pool) : p.consumeString(p.consumeIntegralInRange(0, 40));
}

function makeStep(p) {
  const started = iso(p);
  return { name: text(p, STEP_NAMES), started_at: started, completed_at: p.consumeBoolean() ? iso(p) : started, conclusion: 'success' };
}

function makeJob(p) {
  const steps = [];
  for (let i = p.consumeIntegralInRange(0, 5); i > 0; i--) steps.push(makeStep(p));
  const job = { created_at: iso(p), started_at: iso(p), completed_at: iso(p), conclusion: 'success', labels: p.consumeBoolean() ? ['ubuntu-latest'] : ['self-hosted', 'Linux'], steps };
  if (p.consumeBoolean()) job.runner_name = p.consumeBoolean() ? 'GitHub Actions 3' : 'self-hosted-1';
  if (p.consumeBoolean()) job.runner_group_name = p.consumeBoolean() ? 'GitHub Actions' : 'Default';
  return job;
}

function makeRun(p, name, path) {
  const run = {
    id: p.consumeIntegralInRange(1, 1e6),
    name,
    path,
    event: text(p, EVENTS),
    head_sha: p.pickValue(['a', 'b', 'c', 'd']),
    head_branch: text(p, ['main', 'feature']),
    conclusion: p.pickValue(CONCLUSIONS),
    status: p.pickValue(STATUSES),
    created_at: iso(p),
    run_started_at: p.consumeBoolean() ? iso(p) : null,
    updated_at: iso(p),
  };
  if (p.consumeBoolean()) run.run_attempt = p.consumeIntegralInRange(1, 4);
  return run;
}

function finite(value, where) {
  if (value === undefined) fail(`${where} is undefined`);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${where} is ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => finite(v, `${where}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) finite(v, `${where}.${k}`);
  }
}

export function fuzz(data) {
  const p = new FuzzedDataProvider(data);
  const runs = [];
  const byWf = new Map();
  const samples = new Map();
  const files = new Map();
  for (let w = p.consumeIntegralInRange(1, 4); w > 0; w--) {
    const name = text(p, ['CI', 'Release', 'Nightly', 'Lint']);
    const path = p.consumeBoolean() ? `.github/workflows/${p.pickValue(['ci', 'release', 'nightly'])}.yml` : p.consumeString(p.consumeIntegralInRange(0, 30));
    const rs = [];
    for (let i = p.consumeIntegralInRange(1, 8); i > 0; i--) rs.push(makeRun(p, name, path));
    if (byWf.has(name)) continue;
    runs.push(...rs);
    byWf.set(name, rs);
    const sampled = [];
    for (let s = p.consumeIntegralInRange(0, 3); s > 0; s--) {
      const jobs = [];
      for (let j = p.consumeIntegralInRange(0, 3); j > 0; j--) jobs.push(makeJob(p));
      sampled.push(jobs);
    }
    samples.set(name, sampled);
    files.set(path.split('@')[0], p.consumeBoolean() ? p.pickValue(FILES) : p.consumeString(p.consumeIntegralInRange(0, 200)));
  }
  const lockfiles = p.consumeBoolean() ? [p.pickValue(LOCKFILES)] : [];
  const coveredDays = p.pickValue([0.25, 1, 7, 7.5, 14, 30]);
  const history = { runs, byWf, samples, coveredDays, truncated: p.consumeBoolean(), since: '2026-01-01T00:00:00Z', files, lockfiles };

  const a = analyse('o/r', history);
  finite(a, 'analysis');
  if (!Array.isArray(a.findings) || !Array.isArray(a.workflows)) fail('analyse returned a malformed result');

  for (const [what, out] of [['report', report(a)], ['html', html([a])]]) {
    if (typeof out !== 'string') fail(`${what} returned a non-string`);
  }

  // What `ci-wizard --save` writes and `ci-wizard compare` reads back.
  const saved = JSON.parse(JSON.stringify(a));
  if (typeof compare(saved, saved) !== 'string') fail('compare returned a non-string');
  const c = compareData(saved, saved);
  if (c.gone.length || c.appeared.length) fail('a report compared with itself shows changed findings');
}
