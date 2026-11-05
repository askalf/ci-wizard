// pitlane's method, measured for anyone who runs self-hosted runners: a fork's pull request never
// reaches a self-hosted runner, and no two jobs share a runner (an ephemeral runner registers anew
// for every job). Each has its near misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { analyse, runnerReuseFinding } from '../src/analyse.mjs';
import { forkReachableSelfHosted, parseWorkflow, runsOnSelfHosted } from '../src/workflow.mjs';
import { forkGuardExample } from '../src/advice.mjs';
import { report, savingText, summary } from '../src/report.mjs';
import { data, find, job, runs } from './helpers.mjs';

const wf = (on, runsOn, extra = '') => `on: ${on}\njobs:\n  test:\n    runs-on: ${runsOn}\n${extra}    steps:\n      - run: make test\n`;
const reach = (text, repo = 'o/r') => forkReachableSelfHosted(parseWorkflow(text), repo).map((r) => `${r.job}:${r.event}:${r.certain ? 'certain' : 'possible'}`);
const FORK_TO_HOSTED = "github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-latest'";

test('runsOnSelfHosted: lists, strings, label objects and expressions', () => {
  assert.equal(runsOnSelfHosted(['self-hosted', 'linux']), true);
  assert.equal(runsOnSelfHosted('self-hosted'), true);
  assert.equal(runsOnSelfHosted({ group: 'g', labels: ['self-hosted', 'x'] }), true);
  assert.equal(runsOnSelfHosted("${{ fromJSON('[\"self-hosted\",\"x\"]') }}"), true);
  assert.equal(runsOnSelfHosted('ubuntu-latest'), false);
  assert.equal(runsOnSelfHosted({ group: 'larger-runners' }), false);
  assert.equal(runsOnSelfHosted(undefined), false);
});

test('fork exposure is evaluated: a self-hosted pull_request job with no guard is exposed', () => {
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted, app-exec]')), ['test:pull_request:certain']);
  // A check on github.repository is no guard: a fork's pull_request runs in the base repository.
  assert.deepEqual(reach(wf('[pull_request]', "${{ github.repository == 'o/r' && fromJSON('[\"self-hosted\",\"x\"]') || 'ubuntu-latest' }}")), ['test:pull_request:certain']);
});

test('fork exposure: guards are judged by what they do for a fork, not by what they mention', () => {
  // The askalf form sends forks to ubuntu-latest: safe.
  assert.deepEqual(reach(wf('[pull_request]', `\${{ ${FORK_TO_HOSTED} || fromJSON('["self-hosted","x"]') }}`)), []);
  // dario's form, with its several conditions, is safe too.
  const dario = "${{ (github.repository != 'o/r' || github.event.pull_request && (github.event.pull_request.head.repo.full_name != github.repository || github.event.pull_request.user.login == 'dependabot[bot]')) && 'ubuntu-latest' || fromJSON('[\"self-hosted\",\"dario-exec\"]') }}";
  assert.deepEqual(reach(wf('[pull_request]', dario)), []);
  // The same expression with its branches reversed sends forks to self-hosted.
  assert.deepEqual(reach(wf('[pull_request]', `\${{ github.event.pull_request.head.repo.full_name != github.repository && fromJSON('["self-hosted","x"]') || 'ubuntu-latest' }}`)), ['test:pull_request:certain']);
  // A job if that keeps forks out is a guard; one that runs only for forks is the opposite.
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: ${{ !github.event.pull_request.head.repo.fork }}\n')), []);
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: github.event.pull_request.head.repo.full_name == github.repository\n')), []);
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: ${{ github.event.pull_request.head.repo.fork }}\n')), ['test:pull_request:certain']);
});

test('fork exposure: jobs that cannot run on a pull request are not exposed', () => {
  assert.deepEqual(reach(wf('[push, pull_request]', '[self-hosted, deploy]', "    if: github.event_name == 'push'\n")), []);
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: false\n')), []);
  assert.deepEqual(reach(wf('[push]', '[self-hosted]')), []);
  assert.deepEqual(reach(wf('[pull_request]', 'ubuntu-latest')), []);
});

test('fork exposure: what cannot be resolved is possible, never certain, and never dropped', () => {
  assert.deepEqual(reach(wf('[pull_request]', "${{ vars.RUNS_ON && fromJSON(vars.RUNS_ON) || fromJSON('[\"self-hosted\",\"x\"]') }}")), ['test:pull_request:possible']);
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: vars.ENABLED == \'true\'\n')), ['test:pull_request:possible']);
  assert.deepEqual(reach(wf('[pull_request]', "[self-hosted, '${{ matrix.arch }}']")), ['test:pull_request:certain']);
  // An expression that names no self-hosted runner at all is not suspected.
  assert.deepEqual(reach(wf('[pull_request]', '${{ matrix.os }}')), []);
});

test('fork exposure: pull_request_target only when a step checks out the pull request head', () => {
  const target = (withHead) => `on: [pull_request_target]\njobs:\n  t:\n    runs-on: [self-hosted]\n    steps:\n      - uses: actions/checkout@v7\n${withHead ? '        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n' : ''}      - run: make\n`;
  assert.deepEqual(reach(target(false)), []);
  assert.deepEqual(reach(target(true)), ['t:pull_request_target:certain']);
});

test('the fork guard example keeps the job\'s own runner selection, or is left out', () => {
  // A static list goes through fromJSON with every label.
  const listed = parse(forkGuardExample(['self-hosted', 'app-exec']))['runs-on'];
  assert.equal(listed, `\${{ ${FORK_TO_HOSTED} || fromJSON('["self-hosted","app-exec"]') }}`);
  // A whole expression is wrapped as it is, so an app-exec label inside it survives.
  const expr = "${{ fromJSON('[\"self-hosted\",\"app-exec\"]') }}";
  const wrapped = parse(forkGuardExample(expr))['runs-on'];
  assert.equal(wrapped, `\${{ ${FORK_TO_HOSTED} || (fromJSON('["self-hosted","app-exec"]')) }}`);
  // A list with a matrix label, or a runner group, cannot be carried over unchanged: no example.
  assert.equal(forkGuardExample(['self-hosted', '${{ matrix.arch }}']), '');
  assert.equal(forkGuardExample({ group: 'build', labels: ['self-hosted'] }), '');
  assert.equal(forkGuardExample('self-hosted'), `runs-on: \${{ ${FORK_TO_HOSTED} || 'self-hosted' }}`);
});

test('the wrapped example evaluates to hosted for a fork and to the original selection otherwise', async () => {
  const { valueOf, forkPullRequestContext } = await import('../src/expr.mjs');
  const runsOn = parse(forkGuardExample("${{ fromJSON('[\"self-hosted\",\"app-exec\"]') }}"))['runs-on'];
  assert.equal(valueOf(runsOn, forkPullRequestContext('o/r')), 'ubuntu-latest');
  const own = forkPullRequestContext('o/r');
  own.github.event.pull_request.head.repo.full_name = 'o/r';
  assert.deepEqual(valueOf(runsOn, own), ['self-hosted', 'app-exec']);
});

const exposed = (visibility) => analyse('o/r', {
  ...data({ workflows: [{ name: 'CI', runs: runs(20), jobsPerRun: [[job({ steps: [['Set up job', 1], ['Install', 40], ['Run tests', 30], ['Complete job', 0]] })]], file: `on: [pull_request]\njobs:\n  test:\n    runs-on: [self-hosted, app-exec]\n    steps:\n      - name: Install\n        run: npm ci\n      - run: npm test\n` }] }),
  visibility,
});

test('fork pull requests run on self-hosted runners: a confirmed risk on a public repository, ranked first', () => {
  const a = exposed('public');
  const [f] = find(a, 'fork pull requests run on self-hosted runners');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.equal(f.unit, 'risk');
  assert.equal(f.confidence, 'confirmed');
  assert.match(f.evidence, /evaluated for a pull request from a fork, job test \(runs-on \["self-hosted","app-exec"\]\) picks a self-hosted runner, so a fork's code runs on your machine/);
  assert.match(f.example, /fromJSON\('\["self-hosted","app-exec"\]'\)/);
  // It outranks a finding that saves minutes.
  assert.ok(find(a, 'cache dependencies').length);
  assert.equal(a.findings[0].what, 'fork pull requests run on self-hosted runners');
  const md = report(a);
  assert.match(md, /\*\*Start with:\*\* fork pull requests run on self-hosted runners in \*CI\*: a security and stability risk, not minutes/);
  assert.match(md, /1 finding is a security risk to fix before any saving/);
});

test('fork pull requests: inferred when visibility is unknown, absent on a private repository', () => {
  const unknown = find(exposed(null), 'fork pull requests run on self-hosted runners')[0];
  assert.equal(unknown.confidence, 'inferred');
  assert.match(unknown.evidence, /if the repository is public; its visibility could not be read/);
  assert.equal(find(exposed('private'), 'fork pull requests run on self-hosted runners').length, 0);
  assert.equal(find(exposed('internal'), 'fork pull requests run on self-hosted runners').length, 0);
});

const selfJob = (runnerId, name = `runner-${runnerId}`) => ({ ...job({ selfHosted: true }), runner_id: runnerId, runner_name: name, runner_group_name: 'Default' });

test('runners reused across jobs: a runner id that took two sampled jobs is persistent', () => {
  const samples = new Map([
    ['CI', [[selfJob(7, 'box-1')], [selfJob(7, 'box-1')], [selfJob(8)]]],
    ['Lint', [[selfJob(7, 'box-1')]]],
  ]);
  const [f] = runnerReuseFinding(samples);
  assert.ok(f);
  assert.equal(f.unit, 'risk');
  assert.equal(f.what, 'self-hosted runners reused across jobs');
  assert.match(f.evidence, /^3 of 4 sampled self-hosted jobs ran on a runner that took more than one job \(box-1 took 3\)/);
  assert.equal(f.workflow, '2 workflows: CI, Lint');
  assert.match(f.fix, /one job per registration/);
});

test('runners reused across jobs: ephemeral runners, hosted runners and missing ids never fire', () => {
  assert.deepEqual(runnerReuseFinding(new Map([['CI', [[selfJob(1)], [selfJob(2)], [selfJob(3)]]]])), []);
  const hosted = { ...job(), runner_id: 5, runner_group_name: 'GitHub Actions' };
  assert.deepEqual(runnerReuseFinding(new Map([['CI', [[hosted], [hosted]]]])), []);
  const noId = { ...job({ selfHosted: true }), runner_group_name: 'Default' };
  assert.deepEqual(runnerReuseFinding(new Map([['CI', [[noId], [noId]]]])), []);
});

test('the audit reports runner reuse from its samples, as a risk first', () => {
  const a = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(10), jobsPerRun: [[selfJob(4)], [selfJob(4)], [selfJob(4)]] }] }));
  assert.equal(a.findings[0].what, 'self-hosted runners reused across jobs');
  assert.equal(savingText(a.findings[0]), 'a security and stability risk, not minutes');
  assert.match(summary(a).join('\n'), /\*\*Start with:\*\* self-hosted runners reused across jobs/);
});

test('an ephemeral row that keeps its name but registers anew each job is not reuse', () => {
  // Seen on pitlane's ci-wizard-redline-e1: three jobs, one name, runner ids 37, 38 and 39.
  const samples = new Map([['Redline', [37, 38, 39].map((id) => [selfJob(id, 'ci-wizard-redline-e1')])]]);
  assert.deepEqual(runnerReuseFinding(samples), []);
});

test('fork context: only what every fork pull request shares is known', () => {
  // An opened-only job runs for a fork when its pull request opens: possible, not dropped.
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', "    if: github.event.action == 'opened'\n")), ['test:pull_request:possible']);
  // Branch, author, draft state and number vary from one fork pull request to the next.
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', "    if: github.head_ref == 'main'\n")), ['test:pull_request:possible']);
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: ${{ !github.event.pull_request.draft }}\n')), ['test:pull_request:possible']);
  // The fork's name is known only to differ from the base repository; against a literal it is unknown.
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', "    if: github.event.pull_request.head.repo.full_name != 'someone/r'\n")), ['test:pull_request:possible']);
});

test('status functions: failure() can run after a failed dependency; with no needs, success() holds', () => {
  const after = 'on: [pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{run: make}]\n  report:\n    needs: build\n    if: failure()\n    runs-on: [self-hosted]\n    steps: [{run: make report}]\n';
  assert.deepEqual(reach(after), ['report:pull_request:possible']);
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: success()\n')), ['test:pull_request:certain']);
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: failure()\n')), []);
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: always()\n')), ['test:pull_request:certain']);
});

test('comparisons coerce as GitHub does when types differ', async () => {
  const { evaluate, parseExpr, completeContext } = await import('../src/expr.mjs');
  const ev = (e) => evaluate(parseExpr(e), completeContext({}));
  assert.equal(ev('true == 1'), true);
  assert.equal(ev("'1' == 1"), true);
  assert.equal(ev('null == 0'), true);
  assert.equal(ev("'' == 0"), true);
  assert.equal(ev("'abc' == 0"), false);
  assert.equal(ev("'abc' != 0"), true);
  assert.equal(ev("'ABC' == 'abc'"), true);
  // A fork's flag compared to 1 runs the job for a fork.
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: github.event.pull_request.head.repo.fork == 1\n')), ['test:pull_request:certain']);
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', '    if: github.event.pull_request.head.repo.fork != 1\n')), []);
});

test('label objects: their labels are evaluated before they are classified', () => {
  const obj = (labels) => `on: [pull_request]\njobs:\n  test:\n    runs-on:\n      group: build\n      labels: "${labels}"\n    steps: [{run: make}]\n`;
  assert.deepEqual(reach(obj("${{ github.event.pull_request.head.repo.fork && 'ubuntu-latest' || 'self-hosted' }}")), []);
  assert.deepEqual(reach(obj("${{ github.event.pull_request.head.repo.fork && 'self-hosted' || 'ubuntu-latest' }}")), ['test:pull_request:certain']);
  assert.deepEqual(reach(obj('${{ vars.LABEL }}-self-hosted')), ['test:pull_request:possible']);
});

test('the guard example leaves push, schedule and dispatch runs on their own runners', async () => {
  const { valueOf, completeContext, forkPullRequestContext } = await import('../src/expr.mjs');
  const runsOn = parse(forkGuardExample(['self-hosted', 'app-exec']))['runs-on'];
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    assert.deepEqual(valueOf(runsOn, completeContext({ repository: 'o/r', event_name: event, event: {} })), ['self-hosted', 'app-exec'], event);
  }
  const own = completeContext({ repository: 'o/r', event_name: 'pull_request', event: { pull_request: { head: { repo: { full_name: 'o/r' } } } } });
  assert.deepEqual(valueOf(runsOn, own), ['self-hosted', 'app-exec']);
  assert.equal(valueOf(runsOn, forkPullRequestContext('o/r')), 'ubuntu-latest');
});

test('pull_request_target: a head checkout counts only when its own if lets it run for a fork', () => {
  const target = (stepIf) => `on: [pull_request_target]\njobs:\n  t:\n    runs-on: [self-hosted]\n    steps:\n      - uses: actions/checkout@v7\n${stepIf ? `        if: ${stepIf}\n` : ''}        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: make\n`;
  assert.deepEqual(reach(target('')), ['t:pull_request_target:certain']);
  assert.deepEqual(reach(target('false')), []);
  assert.deepEqual(reach(target('github.event.pull_request.head.repo.full_name == github.repository')), []);
  assert.deepEqual(reach(target("contains(github.event.pull_request.labels.*.name, 'safe')")), ['t:pull_request_target:possible']);
});

test('a head checkout behind if: failure() runs after a failing step: possible, even with no needs', () => {
  const wfText = 'on: [pull_request_target]\njobs:\n  t:\n    runs-on: [self-hosted]\n    steps:\n      - run: exit 1\n      - uses: actions/checkout@v7\n        if: failure()\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n      - run: make\n';
  assert.deepEqual(reach(wfText), ['t:pull_request_target:possible']);
});

test('functions of a partly known value are unknown: toJSON of a fork pull request', async () => {
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', "    if: contains(toJSON(github.event.pull_request), 'trusted-user')\n")), ['test:pull_request:possible']);
  assert.deepEqual(reach(wf('[pull_request]', '[self-hosted]', "    if: contains(format('{0}', github.event.pull_request.head.repo.full_name), 'trusted')\n")), ['test:pull_request:possible']);
  // A value parsed from JSON is fully known, so its functions still compute.
  const { evaluate, parseExpr, completeContext } = await import('../src/expr.mjs');
  assert.equal(evaluate(parseExpr(`contains(toJSON(fromJSON('{"a":"trusted"}')), 'trusted')`), completeContext({})), true);
  assert.equal(evaluate(parseExpr(`contains(fromJSON('["self-hosted","x"]'), 'x')`), completeContext({})), true);
});
