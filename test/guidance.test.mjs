// Expert guidance and measurement: billed minutes as GitHub bills them, the checkout cause read
// from the file, tailored YAML for each fix, trade-offs on every finding, developer wait only where
// someone waits, the readable report, --only, and compare's billed figures. Each pattern has a near
// miss it must leave alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { analyse, measureWorkflow } from '../src/analyse.mjs';
import { CANCEL_OUTDATED, ONE_RUN_PER_COMMIT, cacheExample, checkoutAdvice, managerOf, triggerExample } from '../src/advice.mjs';
import { installersOf, parseWorkflow, workflowFacts } from '../src/workflow.mjs';
import { report, stepLabel, summary } from '../src/report.mjs';
import { html } from '../src/html.mjs';
import { compare } from '../src/compare.mjs';
import { collect } from '../src/collect.mjs';
import { createClient } from '../src/github.mjs';
import { main as cli } from '../src/cli.mjs';
import { data, fakeFetch, find, job, run, runs, t } from './helpers.mjs';
import { readFileSync } from 'node:fs';

const shortJob = (o = {}) => job({ steps: [['Set up job', 1], ['Run lint', 8], ['Complete job', 0]], ...o });
const lintFile = 'on: [pull_request]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx eslint .\n';

test('billed minutes: each GitHub-hosted job rounds up to a whole minute; self-hosted jobs bill nothing', () => {
  const sixty = job({ steps: [['Set up job', 1], ['Run tests', 57], ['Complete job', 0]], head: 1, tail: 2 }); // 61 s
  const w = measureWorkflow('CI', runs(10), [[shortJob(), shortJob(), sixty]], '', 1);
  assert.equal(w.billed_minutes_per_run, 4); // 1 + 1 + 2
  assert.equal(w.billed_minutes_week, 40);
  const self = measureWorkflow('CI', runs(10), [[shortJob({ selfHosted: true }), shortJob({ selfHosted: true })]], '', 1);
  assert.equal(self.billed_minutes_week, 0);
});

test('short hosted jobs bill a whole minute: fires on many short hosted jobs, not self-hosted or long ones', () => {
  const jobs = Array.from({ length: 4 }, () => shortJob());
  const a = analyse('o/r', data({ workflows: [{ name: 'Lint', runs: runs(100, { event: 'pull_request' }), jobsPerRun: [jobs, jobs, jobs], file: lintFile }] }));
  const [f] = find(a, 'short hosted jobs bill a whole minute');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.equal(f.unit, 'billed');
  assert.match(f.evidence, /about 400 billed minutes a week for \d+ job-minutes/);
  assert.equal(a.billed_minutes_week_sampled, 400);
  assert.ok(a.billed_saving_min_week_total > 0);
  // Near misses: the same jobs self-hosted, and long hosted jobs where rounding adds little.
  const self = Array.from({ length: 4 }, () => shortJob({ selfHosted: true }));
  assert.equal(find(analyse('o/r', data({ workflows: [{ name: 'Lint', runs: runs(100), jobsPerRun: [self, self, self], file: lintFile }] })), 'short hosted jobs bill a whole minute').length, 0);
  const long = [job({ steps: [['Set up job', 1], ['Run tests', 290], ['Complete job', 0]] })];
  assert.equal(find(analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(100), jobsPerRun: [long, long, long], file: lintFile }] })), 'short hosted jobs bill a whole minute').length, 0);
});

const checkoutSteps = [['Set up job', 1], ['Run actions/checkout@v7', 30], ['Run tests', 40], ['Complete job', 0]];
const checkoutFile = (inputs) => `on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n${inputs}      - run: npm test\n`;
const slowCheckout = (inputs) => find(analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: checkoutSteps })]], file: checkoutFile(inputs) }] })), 'slow checkout')[0];

test('slow checkout: the cause comes from the checkout step, and a default checkout is not told to use fetch-depth 1', () => {
  const full = slowCheckout('        with:\n          fetch-depth: 0\n          lfs: true\n');
  assert.equal(full.confidence, 'confirmed');
  assert.match(full.evidence, /`fetch-depth: 0` fetches the whole history; `lfs: true` downloads every LFS object/);
  assert.match(full.example, /fetch-depth: 1/);
  assert.match(full.example, /lfs: false/);
  const plain = slowCheckout('');
  assert.equal(plain.confidence, 'inferred');
  assert.match(plain.evidence, /already fetches a single commit/);
  assert.doesNotMatch(plain.fix, /fetch-depth/);
  assert.match(plain.example, /sparse-checkout/);
  // A commented-out input is not an input.
  assert.equal(slowCheckout('        # with:\n        #   fetch-depth: 0\n').confidence, 'inferred');
});

test('checkoutAdvice and workflowFacts: submodules, tags, and values that are off', () => {
  const facts = (inputs) => workflowFacts(parseWorkflow(checkoutFile(inputs))).checkout;
  const base = { inspected: true, fullHistory: false, depth: null, depthUnknown: false, lfs: false, submodules: false, tags: false };
  assert.deepEqual(facts('        with:\n          submodules: recursive\n          fetch-tags: true\n'), { ...base, submodules: true, tags: true });
  assert.deepEqual(facts("        with:\n          fetch-depth: '0'\n          lfs: false\n          submodules: false\n"), { ...base, fullHistory: true });
  assert.deepEqual(facts('        with:\n          fetch-depth: 50\n'), { ...base, depth: 50 });
  assert.deepEqual(facts('        with:\n          fetch-depth: 1\n'), base);
  assert.deepEqual(facts('        with:\n          fetch-depth: ${{ inputs.depth }}\n'), { ...base, depthUnknown: true });
  assert.equal(workflowFacts(parseWorkflow('')).checkout.inspected, false);
  assert.deepEqual(checkoutAdvice({}).causes, []);
});

test('installersOf and managerOf: the package manager the advice is for', () => {
  assert.deepEqual(installersOf('yarn test\nyarn lint'), []);
  assert.deepEqual(installersOf('pnpm install --frozen-lockfile\npnpm test'), ['pnpm']);
  assert.deepEqual(installersOf('pip install -r requirements.txt'), ['pip']);
  assert.deepEqual(installersOf('', [{ uses: 'actions/setup-go@v5' }]), ['go']);
  assert.equal(managerOf([], ['Cargo.lock']), 'cargo');
  assert.equal(managerOf([], ['bun.lockb']), 'bun');
  assert.equal(managerOf(['yarn'], ['package-lock.json']), 'yarn');
  assert.equal(managerOf([], []), 'npm');
});

test('cacheExample: the setup action input where there is one, actions/cache keyed on the lockfile otherwise', () => {
  assert.match(cacheExample('npm', ['package-lock.json']), /setup-node step\nwith:\n {2}cache: npm$/);
  assert.match(cacheExample('npm', []), /hashFiles\('\*\*\/package\.json'\)/);
  assert.match(cacheExample('pnpm', ['pnpm-lock.yaml']), /cache: pnpm/);
  assert.match(cacheExample('go', ['go.sum']), /cache-dependency-path: go\.sum/);
  assert.match(cacheExample('bundler', ['Gemfile.lock']), /bundler-cache: true/);
  assert.match(cacheExample('cargo', ['Cargo.lock']), /hashFiles\('\*\*\/Cargo\.lock'\)/);
  assert.match(cacheExample('bun', ['bun.lockb']), /bun\.lockb/);
  assert.equal(cacheExample('unknown'), '');
});

test('every example is valid YAML, and the concurrency ones say what the fix says', () => {
  const all = [CANCEL_OUTDATED, ONE_RUN_PER_COMMIT, triggerExample(['main', 'feature/**']), triggerExample(['master']),
    ...['npm', 'pnpm', 'yarn', 'uv', 'poetry', 'pipenv', 'pip', 'go', 'bundler', 'cargo', 'bun'].map((m) => cacheExample(m, [])),
    checkoutAdvice({ fullHistory: true, lfs: true, submodules: true, tags: true }).example, checkoutAdvice({}).example];
  for (const y of all) assert.doesNotThrow(() => parse(y), y);
  assert.equal(parse(CANCEL_OUTDATED).concurrency['cancel-in-progress'], true);
  assert.match(parse(CANCEL_OUTDATED).concurrency.group, /github\.head_ref \|\| github\.run_id/);
  assert.deepEqual(parse(triggerExample(['master', 'release/*'])).on.push.branches, ['master']);
});

test('every finding carries a trade-off, and a fix with an example says it in YAML', () => {
  const steps = [['Set up job', 1], ['Run actions/checkout@v7', 20], ['Install', 30], ['Run tests', 40], ['Complete job', 0]];
  const file = "on:\n  push:\n    branches: [main, 'dev/**']\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          fetch-depth: 0\n      - name: Install\n        run: npm ci\n      - run: npm test\n";
  const rs = [...runs(10, { event: 'push', branch: 'dev/a' }), ...runs(10, { event: 'pull_request', branch: 'dev/a' })].map((r, i) => ({ ...r, head_sha: `c${i % 10}`, run_attempt: i === 0 ? 2 : 1 }));
  const a = analyse('o/r', data({ lockfiles: ['package-lock.json'], workflows: [{ name: 'CI', runs: rs, jobsPerRun: [[job({ steps })]], file }] }));
  const kinds = a.findings.map((f) => f.what);
  for (const k of ['cache dependencies', 'slow checkout', 'the same commit runs twice', 'reruns']) assert.ok(kinds.includes(k), kinds.join(', '));
  for (const f of a.findings) assert.ok(f.tradeoff && f.tradeoff.length > 10, `${f.what} has no trade-off`);
  assert.match(find(a, 'cache dependencies')[0].example, /cache: npm/);
  assert.match(find(a, 'the same commit runs twice')[0].example, /pull_request\.head\.sha \|\| github\.sha/);
  // The example reaches the markdown as a fenced block, and the HTML as escaped code.
  assert.match(report(a), /```yaml\n# on the existing actions\/setup-node step\nwith:\n {2}cache: npm\n```/);
  assert.match(html([a]), /<pre class="example"><code># on the existing actions\/setup-node step/);
});

test('developer wait: shown for push and pull request workflows, not for one that runs on a clock', () => {
  const a = analyse('o/r', data({ workflows: [
    { name: 'CI', runs: runs(10, { event: 'pull_request' }) },
    { name: 'Nightly', runs: runs(10, { event: 'schedule' }), path: '.github/workflows/nightly.yml' },
  ] }));
  const byName = Object.fromEntries(a.workflows.map((w) => [w.workflow, w]));
  assert.equal(byName.CI.waited_on, true);
  assert.equal(byName.Nightly.waited_on, false);
  const md = report(a);
  assert.match(md, /\| Nightly † ‡ \| 10 \| [\d.]+ \| \d+ \| \d+ \| - \|/);
  assert.match(md, /‡ Runs mostly from a schedule/);
  assert.match(md, /\| CI † \| 10 \| [\d.]+ \| \d+ \| \d+ \| 60 s \/ 60 s \|/);
});

test('the report explains its columns and cleans step names', () => {
  assert.equal(stepLabel('Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'), 'Run actions/checkout');
  assert.equal(stepLabel('Post Run askalf/ci/actions/fleet-status@70c0759'), 'Post Run askalf/ci/actions/fleet-status');
  assert.equal(stepLabel('Run npm test'), 'Run npm test');
  const steps = [['Set up job', 1], ['Run owner/tool@0123456789abcdef', 12], ['Quick', 0], ['Complete job', 0]];
  const md = report(analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(5), jobsPerRun: [[job({ steps })]] }] })));
  assert.match(md, /Run owner\/tool 12 s/);
  assert.doesNotMatch(md, /Quick 0 s/);
  assert.match(md, /\*head\* the wait before the first step starts; \*tail\* the time after the last step/);
  assert.match(md, /\*\*Billed minutes\*\* are what GitHub charges/);
});

test('summary: a finding that saves developer wait is not reported as 0 job-minutes', () => {
  const lines = summary({ findings: [{ what: 'queue wait', workflow: 'CI', saving_min_week: 0, unit: 'wait' }], job_minutes_week_sampled: 43, billed_minutes_week_sampled: 60, saving_min_week_total: 0, workflows: [] });
  const text = lines.join('\n');
  assert.doesNotMatch(text, /about 0 of/);
  assert.match(text, /1 finding would save developer wait rather than minutes/);
  assert.match(text, /\*\*Start with:\*\* queue wait in \*CI\*: saves developer wait, not job minutes/);
  assert.match(summary({ findings: [], job_minutes_week_sampled: 10, workflows: [] }).join(''), /Nothing crossed the thresholds/);
});

test('a report saved by an older version still renders, with no undefined anywhere', () => {
  const old = JSON.parse(readFileSync(new URL('../docs/samples/askalf-dario.json', import.meta.url), 'utf8'));
  const md = report(old);
  const page = html([old]);
  for (const out of [md, page]) {
    assert.doesNotMatch(out, /undefined|NaN/);
  }
  assert.match(md, /\| Fleet status \| 1746 \| [\d.]+ \| 262 \| - \|/);
});

test('--only: the named workflows are timed (by name, ignoring case), and a name with no runs is reported', async () => {
  const list = [...runs(5, { name: 'CI', path: '.github/workflows/ci.yml' }), ...runs(9, { name: 'Lint', path: '.github/workflows/lint.yml' }), ...runs(7, { name: 'Docs', path: '.github/workflows/docs.yml' })];
  const fetchImpl = fakeFetch({ 'repos/o/r/actions/runs?': { workflow_runs: list }, 'repos/o/r/actions/runs/': { jobs: [job()] }, 'repos/o/r/contents/': [] });
  const d = await collect(createClient({ fetchImpl }), 'o/r', { only: ['ci', 'Release'], now: new Date(Date.parse(t(7 * 86400))) });
  assert.deepEqual([...d.samples.keys()], ['CI']);
  assert.deepEqual(d.onlyMissing, ['Release']);
  const a = analyse('o/r', d);
  assert.deepEqual(a.workflows.map((w) => w.workflow), ['CI']);
  const md = report(a);
  assert.match(md, /Only the workflows named with `--only` were timed: ci, Release/);
  assert.match(md, /No runs in the window for Release/);
  assert.match(md, /the 1 named workflow timed/);
});

test('cli --only takes repeated flags and comma lists', async () => {
  const list = [...runs(5, { name: 'CI', path: '.github/workflows/ci.yml' }), ...runs(9, { name: 'Lint', path: '.github/workflows/lint.yml' }), ...runs(7, { name: 'Docs', path: '.github/workflows/docs.yml' })];
  const fetchImpl = fakeFetch({ 'repos/o/r/actions/runs?': { workflow_runs: list }, 'repos/o/r/actions/runs/': { jobs: [job()] }, 'repos/o/r/contents/': [] });
  const o = { out: '', err: '' };
  const io = { stdout: { write: (s) => (o.out += s) }, stderr: { write: (s) => (o.err += s) } };
  assert.equal(await cli(['o/r', '--json', '--only', 'CI,docs', '--only', 'Lint'], { env: {}, token: 'x', ...io, fetchImpl }), 0);
  assert.deepEqual(JSON.parse(o.out).workflows.map((w) => w.workflow).sort(), ['CI', 'Docs', 'Lint']);
});

test('compare: billed minutes per workflow and in total', () => {
  const jobs = Array.from({ length: 4 }, () => shortJob());
  const before = analyse('o/r', data({ workflows: [{ name: 'Lint', runs: runs(100), jobsPerRun: [jobs], file: lintFile }] }));
  // After: one job a run and a fifth of the runs, so rounding adds too little to fire.
  const after = analyse('o/r', data({ workflows: [{ name: 'Lint', runs: runs(20), jobsPerRun: [[shortJob()]], file: lintFile }] }));
  const md = compare(before, after);
  assert.match(md, /\| Billed min\/week \| 400 \| 20 \| -380 \(-95%\) \|/);
  assert.match(md, /Billed minutes on GitHub-hosted runners: 400 a week before, 20 after: -380 \(-95%\)/);
  // The saving of a finding that is gone keeps its unit: billed minutes, not job runtime.
  assert.match(md, /Gone: \*\*short hosted jobs bill a whole minute\*\* in \*Lint\* \(was about \d+ billed-min\/week \(estimate\)\)/);
  assert.doesNotMatch(md, /short hosted jobs bill a whole minute\*\* in \*Lint\* \(was about \d+ job-min/);
  // A report without billed minutes compares with a dash, not a crash.
  const old = { ...before, billed_minutes_week_sampled: undefined, workflows: before.workflows.map((w) => ({ ...w, billed_minutes_week: undefined })) };
  assert.match(compare(old, after), /\| Billed min\/week \| - \| 20 \| - \|/);
});

test('action.yml parses, and every input the action reads is declared there', () => {
  const action = parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../src/action-run.mjs', import.meta.url), 'utf8');
  const read = [...source.matchAll(/input\(env, '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(read.includes('only'));
  for (const name of read) assert.ok(action.inputs[name], `action.yml does not declare the ${name} input`);
});

test('the action passes its only input through', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { run: runAction } = await import('../src/action-run.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ciw-only-'));
  const list = [...runs(5, { name: 'CI', path: '.github/workflows/ci.yml' }), ...runs(9, { name: 'Lint', path: '.github/workflows/lint.yml' })];
  const fetchImpl = fakeFetch({ 'repos/o/r/actions/runs?': { workflow_runs: list }, 'repos/o/r/actions/runs/': { jobs: [job()] }, 'repos/o/r/contents/': [] });
  const env = { INPUT_REPOSITORY: 'o/r', INPUT_TOKEN: 'x', INPUT_ONLY: 'CI', RUNNER_TEMP: dir };
  assert.equal(await runAction({ env, stdout: { write() {} }, fetchImpl, now: new Date(Date.parse(t(7 * 86400))) }), 0);
  const saved = JSON.parse(readFileSync(join(dir, 'ci-wizard', 'report.json'), 'utf8'));
  assert.deepEqual(saved.workflows.map((w) => w.workflow), ['CI']);
});

test('groupRuns: a run named after the pull request that added its workflow stays with that workflow', async () => {
  const { groupRuns } = await import('../src/collect.mjs');
  const fuzz = (name, i) => ({ ...run({ name, at: -i }), workflow_id: 7, path: '.github/workflows/fuzz.yml' });
  const runsList = [
    fuzz('[hold] Fuzz the workflow, run-history and report parsers with Jazzer.js', 0),
    fuzz('Fuzz', 1), fuzz('Fuzz', 2), fuzz('Fuzz', 3),
    { ...run({ name: 'CI' }), workflow_id: 1, path: '.github/workflows/ci.yml' },
  ];
  const g = groupRuns(runsList);
  assert.deepEqual([...g.keys()].sort(), ['CI', 'Fuzz']);
  assert.equal(g.get('Fuzz').length, 4);
  // Two workflows that share a name keep apart, labelled by their files.
  const twins = groupRuns([
    { ...run({ name: 'Build' }), workflow_id: 1, path: '.github/workflows/a.yml' },
    { ...run({ name: 'Build' }), workflow_id: 2, path: '.github/workflows/b.yml' },
  ]);
  assert.deepEqual([...twins.keys()].sort(), ['Build (.github/workflows/a.yml)', 'Build (.github/workflows/b.yml)']);
  // A tie between names goes to the newest run's (the API lists newest first).
  const tie = groupRuns([{ ...run({ name: 'New name' }), workflow_id: 3 }, { ...run({ name: 'Old name' }), workflow_id: 3 }]);
  assert.deepEqual([...tie.keys()], ['New name']);
});

test('noise floor: a finding that saves under a minute a week is left out; a developer-wait finding stays', () => {
  const tiny = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(10), jobsPerRun: [[job({ selfHosted: true, tail: 6 })]] }] }));
  assert.equal(find(tiny, 'self-hosted wrap-up tail').length, 0);
  const wait = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(3), jobsPerRun: [[job({ wait: 45 })]] }] }));
  const [q] = find(wait, 'queue wait');
  assert.equal(q.unit, 'wait');
  assert.match(report(wait), /\*\*Saves\*\* saves developer wait, not job minutes/);
});

test('savingText: units, and reports saved before units existed', async () => {
  const { savingText } = await import('../src/report.mjs');
  assert.equal(savingText({ saving_min_week: 12.4, unit: 'job' }), 'about 12 job-min/week (estimate)');
  assert.equal(savingText({ saving_min_week: 30, unit: 'billed' }), 'about 30 billed-min/week (estimate)');
  assert.equal(savingText({ saving_min_week: 0, unit: 'wait' }), 'saves developer wait, not job minutes');
  assert.equal(savingText({ saving_min_week: 0.4, unit: 'job' }), 'under 1 job-min/week (estimate)');
  assert.equal(savingText({ saving_min_week: 0 }), 'saves developer wait, not job minutes');
  const s = summary({ findings: [{ what: 'short hosted jobs bill a whole minute', workflow: 'CI', saving_min_week: 23, unit: 'billed' }], job_minutes_week_sampled: 46, billed_minutes_week_sampled: 117, workflows: [] }).join('\n');
  assert.match(s, /1 finding would save about 23 billed minutes a week/);
});

test('slow checkout: a partial depth is named, and an unreadable file or an expression leaves the cause unknown', () => {
  const fifty = slowCheckout('        with:\n          fetch-depth: 50\n');
  assert.equal(fifty.confidence, 'confirmed');
  assert.match(fifty.evidence, /`fetch-depth: 50` fetches 50 commits/);
  assert.doesNotMatch(fifty.evidence, /single commit/);
  assert.match(fifty.example, /fetch-depth: 1 {3}# or the fewest of the 50 commits the job reads/);
  const md = report(analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: checkoutSteps })]], file: checkoutFile('        with:\n          fetch-depth: 50\n') }] })));
  assert.match(md, /`fetch-depth: 50` fetches 50 commits/);
  // No workflow file to read: the cause is not claimed.
  const unread = find(analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: checkoutSteps })]] }] })), 'slow checkout')[0];
  assert.equal(unread.confidence, 'inferred');
  assert.match(unread.evidence, /shows no actions\/checkout step to read, so what it fetches is not known/);
  assert.doesNotMatch(unread.evidence, /single commit/);
  assert.equal(unread.example, '');
  const expr = slowCheckout('        with:\n          fetch-depth: ${{ inputs.depth }}\n');
  assert.equal(expr.confidence, 'inferred');
  assert.match(expr.evidence, /fetch-depth is set by an expression/);
});

test('--only matches the name GitHub shows: two workflows both named Build are both selected', async () => {
  const list = [
    ...runs(4, { name: 'Build' }).map((r) => ({ ...r, workflow_id: 1, path: '.github/workflows/a.yml' })),
    ...runs(3, { name: 'Build' }).map((r) => ({ ...r, workflow_id: 2, path: '.github/workflows/b.yml' })),
    ...runs(5, { name: 'Lint' }).map((r) => ({ ...r, workflow_id: 3, path: '.github/workflows/lint.yml' })),
  ];
  const fetchImpl = fakeFetch({ 'repos/o/r/actions/runs?': { workflow_runs: list }, 'repos/o/r/actions/runs/': { jobs: [job()] }, 'repos/o/r/contents/': [] });
  const d = await collect(createClient({ fetchImpl }), 'o/r', { only: ['build'], now: new Date(Date.parse(t(7 * 86400))) });
  assert.deepEqual([...d.samples.keys()].sort(), ['Build (.github/workflows/a.yml)', 'Build (.github/workflows/b.yml)']);
  assert.deepEqual(d.onlyMissing, []);
  // The label itself still works, for picking one of the two.
  const one = await collect(createClient({ fetchImpl }), 'o/r', { only: ['Build (.github/workflows/b.yml)'], now: new Date(Date.parse(t(7 * 86400))) });
  assert.deepEqual([...one.samples.keys()], ['Build (.github/workflows/b.yml)']);
});

test('the same commit runs twice: the push trigger names the repository\'s default branch, never a guessed main', () => {
  const file = 'on: [push, pull_request]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n';
  const rs = [...runs(10, { event: 'push', branch: 'feature' }), ...runs(10, { event: 'pull_request', branch: 'feature' })].map((r, i) => ({ ...r, head_sha: `c${i % 10}` }));
  const withDefault = (defaultBranch) => {
    const d = data({ workflows: [{ name: 'CI', runs: rs, file }] });
    return find(analyse('o/r', { ...d, defaultBranch }), 'the same commit runs twice')[0];
  };
  const dev = withDefault('develop');
  assert.deepEqual(parse(dev.example).on.push.branches, ['develop']);
  assert.doesNotMatch(dev.example, /\bmain\b/);
  // Unknown default branch and no branch in the trigger: a marked placeholder, not main.
  const unknown = withDefault(null);
  assert.match(unknown.example, /branches: \[DEFAULT-BRANCH\] {3}# replace with the repository's default branch/);
  assert.doesNotThrow(() => parse(unknown.example));
  // With develop as the default, a push trigger on develop has no extra patterns; main would be one.
  const named = (branches, defaultBranch) => {
    const f = `on:\n  push:\n    branches: [${branches.join(', ')}]\n  pull_request:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n`;
    const d = data({ workflows: [{ name: 'CI', runs: rs, file: f }] });
    return find(analyse('o/r', { ...d, defaultBranch }), 'the same commit runs twice')[0];
  };
  assert.equal(named(['develop'], 'develop').confidence, 'measured');
  assert.match(named(['develop', 'main'], 'develop').evidence, /also matches main/);
});

test('collect reads the default branch from the repository, and carries on without it', async () => {
  const base = { 'repos/o/r/actions/runs?': { workflow_runs: runs(3) }, 'repos/o/r/actions/runs/': { jobs: [job()] }, 'repos/o/r/contents/': [] };
  const now = new Date(Date.parse(t(7 * 86400)));
  const meta = (path) => (path === 'repos/o/r' ? { default_branch: 'develop' } : undefined);
  const withMeta = await collect(createClient({ fetchImpl: fakeFetch({ ...base, 'repos/o/r': meta }) }), 'o/r', { now });
  assert.equal(withMeta.defaultBranch, 'develop');
  const without = await collect(createClient({ fetchImpl: fakeFetch(base) }), 'o/r', { now });
  assert.equal(without.defaultBranch, null);
});

test('billed minutes on a public repository: free standard runners, so no billing finding and the report says why', () => {
  const jobs = Array.from({ length: 4 }, () => shortJob());
  const at = (visibility) => analyse('o/r', { ...data({ workflows: [{ name: 'Lint', runs: runs(100, { event: 'pull_request' }), jobsPerRun: [jobs, jobs, jobs], file: lintFile }] }), visibility });
  const pub = at('public');
  assert.equal(find(pub, 'short hosted jobs bill a whole minute').length, 0);
  assert.equal(pub.billed_minutes_week_sampled, 400);
  const md = report(pub);
  assert.match(md, /free on a public repository's standard runners/);
  assert.match(md, /This repository is public, so its standard GitHub-hosted runners are free/);
  assert.match(html([pub]), /free here: a public repository/);
  // Private, and unknown visibility (metadata unreadable), keep the finding.
  assert.equal(find(at('private'), 'short hosted jobs bill a whole minute').length, 1);
  assert.equal(find(at(null), 'short hosted jobs bill a whole minute').length, 1);
  assert.doesNotMatch(report(at('private')), /free on a public repository/);
});

test('collect reads visibility, from visibility or from the private flag', async () => {
  const base = { 'repos/o/r/actions/runs?': { workflow_runs: runs(3) }, 'repos/o/r/actions/runs/': { jobs: [job()] }, 'repos/o/r/contents/': [] };
  const now = new Date(Date.parse(t(7 * 86400)));
  const get = async (meta) => (await collect(createClient({ fetchImpl: fakeFetch({ ...base, 'repos/o/r': (p) => (p === 'repos/o/r' ? meta : undefined) }) }), 'o/r', { now })).visibility;
  assert.equal(await get({ visibility: 'internal', private: true }), 'internal');
  assert.equal(await get({ private: false }), 'public');
  assert.equal(await get({ private: true }), 'private');
});
