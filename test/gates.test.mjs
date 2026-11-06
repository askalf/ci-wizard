// Merge gates: the checks a merge into the default branch waits for, whether pull requests are
// checked at all, and the two workflows a supply-chain review expects. Each with its near misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateFindings, isActionsCheck } from '../src/gates.mjs';
import { savingText, summary } from '../src/report.mjs';
import { collect } from '../src/collect.mjs';
import { createClient } from '../src/github.mjs';
import { fakeFetch, job, runs, t } from './helpers.mjs';

const prFile = 'on:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
const codeqlFile = 'on: [pull_request]\njobs:\n  analyze:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: github/codeql-action/init@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
const files = (...texts) => new Map(texts.map((x, i) => [`.github/workflows/w${i}.yml`, x]));
const all = (n) => ({ read: n, of: n, unreadable: [] });
const gates = (over = {}) => ({ branch: 'main', required: [], pr_runs_seen: 1, pr_runs_read: 1, pr_checks: ['test'], code_scanning_runs: true, dependency_updates: true, ...over });
const whats = (F) => F.map((f) => f.what);

test('isActionsCheck: only a check bound to GitHub Actions is known to be a workflow job', () => {
  assert.equal(isActionsCheck({ context: 'test', integrationId: 15368 }), true);
  assert.equal(isActionsCheck({ context: 'test', integrationId: null }), false); // any app may report it
  assert.equal(isActionsCheck({ context: 'codecov/patch', integrationId: 254 }), false);
});

test('merges that wait for no check: pull requests get checks, the branch requires none', () => {
  const F = gateFindings(gates({ required: [], pr_checks: ['test', 'lint'] }), { scanFiles: files(prFile), scanned: all(1) });
  const f = F.find((x) => x.what === 'merges do not wait for any check');
  assert.equal(f.unit, 'risk');
  assert.equal(f.confidence, 'confirmed');
  assert.match(f.evidence, /no ruleset or branch protection on main requires a status check, though pull requests get 2: test, lint/);
  // Near misses: required checks exist; or the rules could not be read (null), so nothing is claimed.
  assert.ok(!whats(gateFindings(gates({ required: [{ context: 'test', integrationId: null }] }), { scanFiles: files(prFile), scanned: all(1) })).includes('merges do not wait for any check'));
  assert.ok(!whats(gateFindings(gates({ required: null }), { scanFiles: files(prFile), scanned: all(1) })).includes('merges do not wait for any check'));
});

test('a required check no pull request reports: renamed, path-filtered or removed', () => {
  const g = gates({ required: [{ context: 'test (node 20)', integrationId: 15368 }, { context: 'build', integrationId: 15368 }, { context: 'codecov/patch', integrationId: 254 }, { context: 'lint', integrationId: null }], pr_checks: ['test (node 22)', 'build'], pr_runs_read: 2 });
  const f = gateFindings(g, { scanFiles: files(prFile), scanned: all(1) }).find((x) => x.what === 'required checks no pull request reports');
  assert.equal(f.unit, 'risk');
  assert.match(f.evidence, /main requires "test \(node 20\)", but the newest pull request run of each of 2 workflows/);
  assert.doesNotMatch(f.evidence, /requires[^,]*"build"/); // reported, so not missing
  assert.doesNotMatch(f.evidence, /requires[^,]*"codecov\/patch"/); // another app: not read from the runs
  assert.doesNotMatch(f.evidence, /requires[^,]*"lint"/); // bound to no app: any app may report it
  assert.match(f.evidence, /"codecov\/patch", "lint" are not bound to GitHub Actions, so another app may report them, and they were not judged/);
  // Near miss: no pull request run in the window, so nothing can be said about what they report.
  assert.ok(!whats(gateFindings({ ...g, pr_runs_read: 0, pr_runs_seen: 0, pr_checks: [] }, { scanFiles: files(prFile), scanned: all(1) })).includes('required checks no pull request reports'));
});

test('pull request checks merges do not wait for: tests, builds, analysis and fuzzing that are not required', () => {
  const g = gates({ required: [{ context: 'test', integrationId: null }], pr_checks: ['test', 'Fuzz (Jazzer.js)', 'analyze (actions)', 'label', 'review / redline'] });
  const f = gateFindings(g, { scanFiles: files(prFile, codeqlFile), scanned: all(2) }).find((x) => x.what === 'pull request checks merges do not wait for');
  assert.equal(f.unit, 'guard');
  assert.equal(f.confidence, 'inferred');
  assert.match(f.evidence, /pull requests get "Fuzz \(Jazzer\.js\)", "analyze \(actions\)"/);
  assert.match(f.evidence, /\(2 other unrequired checks not listed\)/); // label, review / redline
  assert.match(f.evidence, /, which look like tests, builds, analysis or fuzzing, but main does not require them/);
  assert.match(f.fix, /^add the ones that must pass/);
  // One such check is spoken of as one, and is said to guard merges, not jobs.
  const [single] = gateFindings(gates({ required: [{ context: 'test', integrationId: null }], pr_checks: ['test', 'Fuzz (Jazzer.js)'] }), { scanFiles: files(prFile, codeqlFile), scanned: all(2) }).filter((x) => x.what === 'pull request checks merges do not wait for');
  assert.match(single.evidence, /"Fuzz \(Jazzer\.js\)", which looks like a test, build, analysis or fuzzing check, but main does not require it, so a pull request can merge with it failing/);
  assert.match(single.fix, /^if it must pass, add it to the required status checks on main, by this exact name/);
  assert.equal(savingText({ ...single, saving_min_week: 0 }), 'a guard against merging a pull request whose checks fail, not minutes');
  // Near miss: everything that looks like a gate is required.
  const none = gateFindings(gates({ required: ['test', 'Fuzz (Jazzer.js)', 'analyze (actions)'].map((context) => ({ context, integrationId: null })), pr_checks: ['test', 'Fuzz (Jazzer.js)', 'analyze (actions)', 'label'] }), { scanFiles: files(prFile, codeqlFile), scanned: all(2) });
  assert.ok(!whats(none).includes('pull request checks merges do not wait for'));
});

test('no workflow checks pull requests: only when every workflow file was read and none ran on one', () => {
  const push = 'on: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n';
  const g = gates({ required: null, pr_runs_seen: 0, pr_runs_read: 0, pr_checks: [] });
  const f = gateFindings(g, { scanFiles: files(push), scanned: all(1) }).find((x) => x.what === 'no workflow checks pull requests');
  assert.equal(f.unit, 'risk');
  assert.match(f.example, /pull_request:/);
  // Near misses: a file triggers on pull_request; or the directory was not fully read.
  assert.ok(!whats(gateFindings(g, { scanFiles: files(push, prFile), scanned: all(2) })).includes('no workflow checks pull requests'));
  assert.ok(!whats(gateFindings(g, { scanFiles: files(push), scanned: { read: 1, of: 3, unreadable: [] } })).includes('no workflow checks pull requests'));
  assert.ok(!whats(gateFindings(g, { scanFiles: files(push), scanned: { read: 1, of: null, unreadable: [] } })).includes('no workflow checks pull requests'));
});

test('no code scanning: no CodeQL workflow and no default-setup run; a private repository is told it needs Advanced Security', () => {
  const g = gates({ code_scanning_runs: false });
  const pub = gateFindings(g, { scanFiles: files(prFile), scanned: all(1), visibility: 'public' }).find((x) => x.what === 'no code scanning');
  assert.equal(pub.unit, 'risk');
  assert.doesNotMatch(pub.evidence, /Advanced Security/);
  const priv = gateFindings(g, { scanFiles: files(prFile), scanned: all(1), visibility: 'private' }).find((x) => x.what === 'no code scanning');
  assert.match(priv.evidence, /GitHub Advanced Security/);
  // Near misses: a CodeQL workflow file; default setup's runs; an incomplete listing.
  assert.ok(!whats(gateFindings(g, { scanFiles: files(prFile, codeqlFile), scanned: all(2) })).includes('no code scanning'));
  assert.ok(!whats(gateFindings(gates({ code_scanning_runs: true }), { scanFiles: files(prFile), scanned: all(1) })).includes('no code scanning'));
  assert.ok(!whats(gateFindings(g, { scanFiles: files(prFile), scanned: { read: 1, of: 2, unreadable: [] } })).includes('no code scanning'));
});

test('no dependency updates: only when the listings show neither Dependabot nor Renovate', () => {
  const f = gateFindings(gates({ dependency_updates: false }), { scanFiles: files(prFile), scanned: all(1) }).find((x) => x.what === 'no dependency updates');
  assert.equal(f.unit, 'risk');
  assert.match(f.example, /package-ecosystem: github-actions/);
  assert.ok(!whats(gateFindings(gates({ dependency_updates: true }), { scanFiles: files(prFile), scanned: all(1) })).includes('no dependency updates'));
  assert.ok(!whats(gateFindings(gates({ dependency_updates: null }), { scanFiles: files(prFile), scanned: all(1) })).includes('no dependency updates'));
});

test('collect reads the rulesets, classic protection, .github and each workflow\'s newest pull request run once', async () => {
  const now = new Date(Date.parse(t(7 * 86400)));
  const rs = runs(6).map((r, i) => ({ ...r, path: '.github/workflows/ci.yml', event: i % 2 ? 'push' : 'pull_request' }));
  const asked = [];
  const routes = {
    'repos/o/r/actions/runs?': { workflow_runs: rs },
    'repos/o/r/actions/runs/': { jobs: [{ ...job(), name: 'test (node 22)' }, { ...job(), name: 'lint', conclusion: 'skipped' }] },
    'repos/o/r/rules/branches/main': [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test (node 20)', integration_id: 15368 }] } }, { type: 'deletion' }],
    'repos/o/r/branches/main': { name: 'main', protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', contexts: ['build'], checks: [] } } },
    'repos/o/r/contents/.github': [{ name: 'workflows', type: 'dir' }, { name: 'dependabot.yml', type: 'file' }],
    'repos/o/r/contents/.github/workflows': [{ name: 'ci.yml', type: 'file' }],
    'repos/o/r/contents/': 'on: pull_request\njobs: {}\n',
    'repos/o/r/contents': [],
    'repos/o/r': { default_branch: 'main', visibility: 'public' },
  };
  const d = await collect(createClient({ fetchImpl: fakeFetch(routes, { calls: asked }) }), 'o/r', { now });
  assert.deepEqual(d.gates.required.map((c) => c.context), ['test (node 20)', 'build']);
  assert.deepEqual(d.gates.pr_checks, ['lint', 'test (node 22)']); // a skipped job is still a check that reports
  assert.equal(d.gates.pr_runs_read, 1);
  assert.equal(d.gates.dependency_updates, true);
  // The pull request run's jobs were already read for the timing sample: not read again.
  const jobCalls = asked.filter((u) => u.includes('/jobs'));
  assert.equal(new Set(jobCalls).size, jobCalls.length);
  // Unreadable rules and protection (404) leave required unknown, never "none".
  const blind = await collect(createClient({ fetchImpl: fakeFetch({ ...routes, 'repos/o/r/rules/branches/main': { __status: 404 }, 'repos/o/r/branches/main': { __status: 404 } }) }), 'o/r', { now });
  assert.equal(blind.gates.required, null);
});

test('one unreadable source of required checks: what was seen stays required, but no absence is claimed', async () => {
  const now = new Date(Date.parse(t(7 * 86400)));
  const rs = runs(4).map((r) => ({ ...r, path: '.github/workflows/ci.yml', event: 'pull_request' }));
  const base = {
    'repos/o/r/actions/runs?': { workflow_runs: rs },
    'repos/o/r/actions/runs/': { jobs: [{ ...job(), name: 'test' }, { ...job(), name: 'build' }] },
    'repos/o/r/contents/.github/workflows': [{ name: 'ci.yml', type: 'file' }],
    'repos/o/r/contents/.github': [{ name: 'dependabot.yml', type: 'file' }],
    'repos/o/r/contents/': prFile,
    'repos/o/r/contents': [],
    'repos/o/r': { default_branch: 'main', visibility: 'public' },
  };
  // Rulesets unreadable; classic protection readable and off.
  const noRules = await collect(createClient({ fetchImpl: fakeFetch({ ...base, 'repos/o/r/rules/branches/main': { __status: 404 }, 'repos/o/r/branches/main': { name: 'main', protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } } }) }), 'o/r', { now });
  assert.equal(noRules.gates.required_complete, false);
  assert.deepEqual(noRules.gates.required, []);
  const F1 = gateFindings(noRules.gates, { scanFiles: noRules.scanFiles, scanned: noRules.scanned });
  assert.ok(!whats(F1).includes('merges do not wait for any check'), 'an unreadable ruleset may require checks');
  // Rulesets readable and requiring test; the branch summary unreadable: test stays required, but
  // build is not called unrequired.
  const noBranch = await collect(createClient({ fetchImpl: fakeFetch({ ...base, 'repos/o/r/rules/branches/main': [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }], 'repos/o/r/branches/main': { __status: 404 } }) }), 'o/r', { now });
  assert.equal(noBranch.gates.required_complete, false);
  assert.deepEqual(noBranch.gates.required.map((c) => c.context), ['test']);
  const F2 = gateFindings(noBranch.gates, { scanFiles: noBranch.scanFiles, scanned: noBranch.scanned });
  assert.ok(!whats(F2).includes('pull request checks merges do not wait for'));
});

test('one unreadable pull request run: no required check is called unreported', () => {
  const g = gates({ required: [{ context: 'test', integrationId: 15368 }], required_complete: true, pr_runs_seen: 2, pr_runs_read: 1, pr_jobs_complete: false, pr_checks: ['lint'] });
  assert.ok(!whats(gateFindings(g, { scanFiles: files(prFile), scanned: all(1) })).includes('required checks no pull request reports'));
  // With every run read, the same absence is a finding.
  const full = { ...g, pr_runs_read: 2, pr_jobs_complete: true };
  assert.ok(whats(gateFindings(full, { scanFiles: files(prFile), scanned: all(1) })).includes('required checks no pull request reports'));
});

test('a run with more than 100 jobs is read page by page, so a required check on page 2 is reported', async () => {
  const now = new Date(Date.parse(t(7 * 86400)));
  const rs = runs(3).map((r) => ({ ...r, path: '.github/workflows/ci.yml', event: 'pull_request' }));
  const page = (n) => Array.from({ length: n === 1 ? 100 : 20 }, (_, i) => ({ ...job(), name: n === 2 && i === 19 ? 'all tests pass' : `leg ${n}-${i}` }));
  const routes = {
    'repos/o/r/actions/runs?': { workflow_runs: rs },
    'repos/o/r/actions/runs/': (path) => ({ total_count: 120, jobs: page(Number(/[?&]page=(\d+)/.exec(path)[1])) }),
    'repos/o/r/rules/branches/main': [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'all tests pass', integration_id: 15368 }] } }],
    'repos/o/r/branches/main': { name: 'main', protection: { enabled: false } },
    'repos/o/r/contents/.github/workflows': [{ name: 'ci.yml', type: 'file' }],
    'repos/o/r/contents/.github': [{ name: 'dependabot.yml', type: 'file' }],
    'repos/o/r/contents/': prFile,
    'repos/o/r/contents': [],
    'repos/o/r': { default_branch: 'main', visibility: 'public' },
  };
  const d = await collect(createClient({ fetchImpl: fakeFetch(routes) }), 'o/r', { now });
  assert.ok(d.gates.pr_checks.includes('all tests pass'));
  assert.equal(d.gates.pr_jobs_complete, true);
  assert.ok(!whats(gateFindings(d.gates, { scanFiles: d.scanFiles, scanned: d.scanned })).includes('required checks no pull request reports'));
  // A list longer than the 10 pages read is marked incomplete, and no absence is claimed from it.
  const huge = { ...routes, 'repos/o/r/actions/runs/': (path) => ({ total_count: 5000, jobs: page(1) }) };
  const h = await collect(createClient({ fetchImpl: fakeFetch(huge) }), 'o/r', { now });
  assert.equal(h.gates.pr_jobs_complete, false);
});

test('no code scanning: a commented-out CodeQL step or a script that mentions it is not code scanning', () => {
  const commented = 'on: [pull_request]\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      # - uses: github/codeql-action/init@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - run: echo "uses: github/codeql-action/analyze@v3"\n';
  const g = gates({ code_scanning_runs: false });
  assert.ok(whats(gateFindings(g, { scanFiles: files(commented), scanned: all(1) })).includes('no code scanning'));
  assert.ok(!whats(gateFindings(g, { scanFiles: files(codeqlFile), scanned: all(1) })).includes('no code scanning'));
});

test('absence is judged from the newest completed pull request run, not one still creating its jobs', async () => {
  const now = new Date(Date.parse(t(7 * 86400)));
  const base = runs(2).map((r) => ({ ...r, path: '.github/workflows/ci.yml', event: 'pull_request' }));
  const running = { ...base[0], id: 9001, status: 'in_progress', conclusion: null };
  const done = { ...base[1], id: 9002 };
  const routes = {
    'repos/o/r/actions/runs?': { workflow_runs: [running, done] },
    'repos/o/r/actions/runs/9001/jobs': { total_count: 1, jobs: [{ ...job(), name: 'setup' }] },
    'repos/o/r/actions/runs/9002/jobs': { total_count: 2, jobs: [{ ...job(), name: 'setup' }, { ...job(), name: 'test (node 22)' }] },
    'repos/o/r/rules/branches/main': [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test (node 22)', integration_id: 15368 }] } }],
    'repos/o/r/branches/main': { name: 'main', protection: { enabled: false } },
    'repos/o/r/contents/.github/workflows': [{ name: 'ci.yml', type: 'file' }],
    'repos/o/r/contents/.github': [{ name: 'dependabot.yml', type: 'file' }],
    'repos/o/r/contents/': prFile,
    'repos/o/r/contents': [],
    'repos/o/r': { default_branch: 'main', visibility: 'public' },
  };
  const d = await collect(createClient({ fetchImpl: fakeFetch(routes) }), 'o/r', { now });
  assert.ok(d.gates.pr_checks.includes('test (node 22)'));
  assert.ok(!whats(gateFindings(d.gates, { scanFiles: d.scanFiles, scanned: d.scanned })).includes('required checks no pull request reports'));
  // Only the unfinished run in the window: its names count as seen, but no absence is judged.
  const onlyRunning = await collect(createClient({ fetchImpl: fakeFetch({ ...routes, 'repos/o/r/actions/runs?': { workflow_runs: [running] } }) }), 'o/r', { now });
  assert.equal(onlyRunning.gates.pr_jobs_complete, false);
  assert.deepEqual(onlyRunning.gates.pr_checks, ['setup']);
  assert.ok(!whats(gateFindings(onlyRunning.gates, { scanFiles: onlyRunning.scanFiles, scanned: onlyRunning.scanned })).includes('required checks no pull request reports'));
});

test('a required context bound to no app, reported by another app, is never called unreported', async () => {
  const now = new Date(Date.parse(t(7 * 86400)));
  const rs = runs(3).map((r) => ({ ...r, path: '.github/workflows/ci.yml', event: 'pull_request' }));
  const routes = {
    'repos/o/r/actions/runs?': { workflow_runs: rs },
    'repos/o/r/actions/runs/': { total_count: 1, jobs: [{ ...job(), name: 'test' }] },
    'repos/o/r/rules/branches/main': [],
    // Classic protection requires Codecov's check by context alone (no app bound) and test.
    'repos/o/r/branches/main': { name: 'main', protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', contexts: ['codecov/patch', 'test'], checks: [] } } },
    'repos/o/r/contents/.github/workflows': [{ name: 'ci.yml', type: 'file' }],
    'repos/o/r/contents/.github': [{ name: 'dependabot.yml', type: 'file' }],
    'repos/o/r/contents/': prFile,
    'repos/o/r/contents': [],
    'repos/o/r': { default_branch: 'main', visibility: 'public' },
  };
  const d = await collect(createClient({ fetchImpl: fakeFetch(routes) }), 'o/r', { now });
  assert.equal(d.gates.pr_jobs_complete, true);
  assert.deepEqual(d.gates.required.map((c) => c.context), ['codecov/patch', 'test']);
  const F = gateFindings(d.gates, { scanFiles: d.scanFiles, scanned: d.scanned });
  assert.ok(!whats(F).includes('required checks no pull request reports'));
  // It is still required: not listed as a check merges do not wait for, and no "none required".
  assert.ok(!whats(F).includes('merges do not wait for any check'));
});

test('two rulesets requiring the same name, one from any app and one from Actions: the Actions requirement stands, in either order', async () => {
  const now = new Date(Date.parse(t(7 * 86400)));
  const rs = runs(3).map((r) => ({ ...r, path: '.github/workflows/ci.yml', event: 'pull_request' }));
  const unbound = { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } };
  const actions = { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test', integration_id: 15368 }] } };
  const routes = (rules) => ({
    'repos/o/r/actions/runs?': { workflow_runs: rs },
    'repos/o/r/actions/runs/': { total_count: 1, jobs: [{ ...job(), name: 'lint' }] },
    'repos/o/r/rules/branches/main': rules,
    'repos/o/r/branches/main': { name: 'main', protection: { enabled: false } },
    'repos/o/r/contents/.github/workflows': [{ name: 'ci.yml', type: 'file' }],
    'repos/o/r/contents/.github': [{ name: 'dependabot.yml', type: 'file' }],
    'repos/o/r/contents/': prFile,
    'repos/o/r/contents': [],
    'repos/o/r': { default_branch: 'main', visibility: 'public' },
  });
  for (const order of [[unbound, actions], [actions, unbound]]) {
    const d = await collect(createClient({ fetchImpl: fakeFetch(routes(order)) }), 'o/r', { now });
    const f = gateFindings(d.gates, { scanFiles: d.scanFiles, scanned: d.scanned }).find((x) => x.what === 'required checks no pull request reports');
    assert.ok(f, 'the Actions requirement for "test" is judged');
    assert.match(f.evidence, /main requires "test",/);
    assert.doesNotMatch(f.evidence, /not judged/); // "test" was judged through its Actions binding
  }
});

test('code scanning: Semgrep, Snyk, SonarSource scans, Bearer and a code scanner\'s SARIF upload count; a Scorecard upload or a quality gate does not', () => {
  const g = gates({ code_scanning_runs: false });
  const job = (steps, extra = '') => `on: [pull_request]\njobs:\n  scan:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;
  const counts = (text) => !whats(gateFindings(g, { scanFiles: files(text), scanned: all(1) })).includes('no code scanning');
  assert.ok(counts(job('      - uses: semgrep/semgrep-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(counts(job('      - uses: snyk/actions/node@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // Snyk's setup action installs the CLI; the scan is the command after it.
  assert.ok(counts(job('      - uses: snyk/actions/setup@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - run: snyk code test\n')));
  assert.ok(counts(job('      - uses: SonarSource/sonarqube-scan-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(counts(job('      - run: semgrep ci --sarif > out.sarif\n')));
  // After an assignment, a wrapper, a path or another command on the line, it is still a run.
  assert.ok(counts(job('      - run: SEMGREP_APP_TOKEN=x semgrep ci\n')));
  assert.ok(counts(job('      - run: cd app && npx -y snyk code test\n')));
  assert.ok(counts(job('      - run: ./bin/bearer scan .\n')));
  // Inside a conditional or a loop.
  assert.ok(counts(job('      - run: if true; then semgrep ci; fi\n')));
  // Through a wrapper whose option takes a value.
  assert.ok(counts(job('      - run: sudo -u root semgrep ci\n')));
  assert.ok(counts(job('      - run: env -u GITHUB_TOKEN semgrep ci\n')));
  // A wrapper running another program that only mentions a scanner is not a scan.
  assert.ok(!counts(job('      - run: sudo -u root echo semgrep ci\n')));
  // After a here-string, a scan command still runs.
  assert.ok(counts(job('      - run: |\n          cat <<< "hello"\n          semgrep ci\n')));
  assert.ok(counts(job('      - run: if semgrep ci; then echo ok; fi\n')));
  assert.ok(counts(job('      - run: for d in a b; do (cd $d && snyk code test); done\n')));
  assert.ok(counts(job('      - run: |\n          while false\n          do\n            bearer scan .\n          done\n')));
  assert.ok(counts(job('      - run: |\n          codeql database create db \\\n            --language=javascript\n')));
  assert.ok(counts(job('      - run: semgrep ci\n', '    container:\n      image: semgrep/semgrep\n')));
  // Bearer by its container (the image alone, and with its scan command), by command, and by action.
  assert.ok(counts(job('      - run: bearer scan . --format sarif --output b.sarif\n', '    container:\n      image: bearer/bearer:latest\n')));
  assert.ok(counts(job('      - run: make\n', '    container: bearer/bearer\n')));
  assert.ok(counts(job('      - run: bearer scan .\n')));
  assert.ok(counts(job('      - uses: bearer/bearer-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // A scanner image run as a step, and SonarSource's scanner image with a registry and a digest.
  assert.ok(counts(job('      - uses: docker://semgrep/semgrep:1.90.0\n')));
  assert.ok(counts(job('      - run: sonar-scanner\n', '    container:\n      image: docker.io/sonarsource/sonar-scanner-cli@sha256:abc\n')));
  assert.ok(counts(job('      - run: trivy fs --format sarif -o t.sarif .\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // Near misses: Scorecard's or a workflow linter's SARIF is not about the code; a script that only
  // mentions a scanner is not one.
  assert.ok(!counts(job('      - uses: ossf/scorecard-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - uses: zizmorcore/zizmor-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - run: echo "we should add semgrep someday"\n')));
  // A scanner's command is a run only where a command starts: not in an echoed message, a comment
  // or a here-document's lines.
  assert.ok(!counts(job('      - run: echo "run semgrep ci later"\n')));
  // Looking a scanner up runs nothing.
  assert.ok(!counts(job('      - run: command -v semgrep ci\n')));
  assert.ok(!counts(job("      - run: printf '%s\\n' 'bearer scan' # snyk code test\n")));
  assert.ok(!counts(job('      - run: |\n          cat > NOTES <<EOF\n          semgrep ci\n          EOF\n          make\n')));
  // A line that only looks like the delimiter (a trailing space) does not end the here-document.
  assert.ok(!counts(job("      - run: \"cat <<'EOF'\\nEOF \\nsemgrep ci\\nEOF\\n\"\n")));
  // SonarSource's quality gate only waits for an earlier scan's result; a SonarQube server image
  // is not a scan; an image whose name only contains a scanner's is another image.
  assert.ok(!counts(job('      - uses: SonarSource/sonarqube-quality-gate-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - uses: snyk/actions/setup@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - run: npm run build\n')));
  // A here-document with an empty quoted delimiter, ended by an empty line.
  assert.ok(!counts(job("      - run: \"cat <<''\\nsemgrep ci\\n\\n\"\n")));
  // A linter run from its image, as a docker:// step or as the job's container: its SARIF is about workflows.
  assert.ok(!counts(job('      - uses: docker://ghcr.io/zizmorcore/zizmor:latest\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - run: ./scripts/lint-workflows.sh\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', '    container:\n      image: rhysd/actionlint:1.7.7\n')));
  // A here-document whose quoted delimiter has punctuation in it.
  assert.ok(!counts(job("      - run: \"cat <<'END-TEXT'\\nsemgrep ci\\nEND-TEXT\\n\"\n")));
  assert.ok(!counts(job('      - run: make\n', '    container:\n      image: sonarqube:lts-community\n')));
  assert.ok(!counts(job('      - run: make\n', '    container:\n      image: example/bearer-token-tools:1\n')));
  // A workflow linter run by command, whose SARIF is about the workflows.
  assert.ok(!counts(job('      - run: actionlint -format "{{json .}}" > a.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - run: go run github.com/rhysd/actionlint/cmd/actionlint@latest -format "{{json .}}" > a.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - run: uvx zizmor --format sarif . > z.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - run: docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -format sarif > a.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - run: docker run --rm --entrypoint actionlint example/tools:1 -format sarif > a.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - run: docker run --rm node:22 actionlint -format sarif > a.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - run: pipx run --spec zizmor==1.5 zizmor --format sarif . > z.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // A linter's name as an option value, or as the scanner's own argument, is not a linter run.
  assert.ok(counts(job('      - run: docker run --name actionlint aquasec/trivy fs --format sarif . > t.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(counts(job('      - run: docker run -e TOOL=zizmor -v "$PWD:/src" aquasec/trivy fs --skip-dirs actionlint --format sarif /src > t.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // An option's value that looks like --entrypoint is a value: the actionlint image's own program runs.
  assert.ok(!counts(job("      - run: docker run --label '--entrypoint=echo' rhysd/actionlint:latest > a.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")));
  assert.ok(!counts(job("      - run: docker run -e --entrypoint rhysd/actionlint:latest > a.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")));
  // An empty --entrypoint clears the image's: echo runs, not actionlint.
  assert.ok(counts(job("      - run: docker run --entrypoint '' rhysd/actionlint:latest echo hello\n      - run: trivy fs --format sarif -o t.sarif .\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")));
  assert.ok(!counts(job("      - run: docker run --entrypoint= example/tools:1 actionlint -format sarif > a.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")));
  // Looking a linter up runs nothing.
  assert.ok(counts(job('      - run: command -v actionlint || echo missing\n      - run: trivy fs --format sarif -o t.sarif .\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // An --entrypoint replaces the image's own: echo runs on the actionlint image, not actionlint.
  assert.ok(counts(job('      - run: docker run --entrypoint echo rhysd/actionlint:latest hello\n      - run: trivy fs --format sarif -o t.sarif .\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // Global options before the subcommand, with their values.
  assert.ok(!counts(job('      - run: go -C tools run github.com/rhysd/actionlint/cmd/actionlint@latest -format sarif > a.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(!counts(job('      - run: docker --context ci run rhysd/actionlint:latest -format sarif > a.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // A linter run through uvx with a constraints file, as Home Assistant runs zizmor.
  assert.ok(!counts(job('      - run: |\n          uvx --constraints requirements.txt zizmor \\\n            --format=sarif . > zizmor.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // With --entrypoint given, the words after the image are its arguments: echo runs, not actionlint.
  assert.ok(counts(job('      - run: docker run --entrypoint echo node:22 actionlint\n      - run: trivy fs --format sarif -o t.sarif .\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // Words after the image that start with an option are the image's entrypoint's arguments.
  assert.ok(counts(job('      - run: docker run aquasec/trivy --cache-dir actionlint fs --format sarif . > t.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(counts(job('      - run: go run -tags actionlint ./cmd/scan --sarif > s.sarif\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // Installing or pulling a linter without running it leaves a code scanner's upload counted.
  assert.ok(counts(job('      - run: go install github.com/rhysd/actionlint/cmd/actionlint@latest\n      - run: trivy fs --format sarif -o t.sarif .\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  assert.ok(counts(job('      - run: docker pull rhysd/actionlint:latest && trivy fs --format sarif -o t.sarif .\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
  // A linter only mentioned does not make a code scanner's upload about workflows.
  assert.ok(counts(job('      - run: echo "actionlint runs elsewhere"; trivy fs --format sarif -o t.sarif .\n      - uses: github/codeql-action/upload-sarif@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')));
});

test('a workflow file is parsed once in an audit: the scans and the gate checks share the document', async () => {
  const { parseWorkflow, withParseCache } = await import('../src/workflow.mjs');
  const text = 'on: [push]\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n';
  withParseCache(() => assert.equal(parseWorkflow(text), parseWorkflow(text)));
});

test('the summary says what each kind of guard guards against', () => {
  const guard = (what) => ({ what, unit: 'guard', saving_min_week: 0, workflow: 'x' });
  const line = (findings) => summary({ findings, job_minutes_week_sampled: 10, workflows: [] }).join('\n');
  assert.match(line([guard('jobs without a working timeout')]), /1 finding guards against hung jobs\./);
  assert.match(line([guard('pull request checks merges do not wait for'), guard('jobs without a working timeout')]),
    /2 findings guard against merging a pull request whose checks fail and against hung jobs\./);
  // A guard the report has no wording for is still counted, without a made-up purpose.
  assert.match(line([guard('some future guard')]), /1 finding is a guard\./);
  assert.equal(savingText(guard('some future guard')), 'a guard, not minutes');
});
