// What the file shows that the measurements price: a runtime setup on a self-hosted runner that
// has the runtime, and a passing job's log the size of a test listing. Each against the pattern
// it must catch and a near miss it must leave alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../src/analyse.mjs';
import { createClient } from '../src/github.mjs';
import { savingText } from '../src/report.mjs';
import { selfHostedSetups, startsTests, stepName, testCommands } from '../src/trim.mjs';
import { parseWorkflow } from '../src/workflow.mjs';
import { data, find, job, runs } from './helpers.mjs';

const audit = (workflows, o = {}) => analyse('owner/repo', data({ workflows, ...o }));
const doc = (text) => parseWorkflow(text);

test('testCommands: test runners are found behind shell keywords and a cd, reporting flags are dropped, other commands are not tests', () => {
  assert.deepEqual(testCommands('node --test --test-reporter=dot --test-reporter-destination=stdout test/*.test.mjs'), ['node --test test/*.test.mjs']);
  assert.deepEqual(testCommands('cd "$out"\nif [ "$EV" = push ]; then\n  node --test a/*.test.mjs\nfi'), ['node --test a/*.test.mjs']);
  assert.deepEqual(testCommands('npm ci\nnpm test -- --silent\npytest -q tests\ngo test -v ./...\ncargo test --quiet'), ['npm test', 'pytest tests', 'go test ./...', 'cargo test']);
  assert.deepEqual(testCommands('npm run test:unit\nnpm run test:e2e'), ['npm run test:unit', 'npm run test:e2e']);
  assert.deepEqual(testCommands('npm run build\nnode tools/export.mjs out\nbash -n x.sh'), []);
  assert.equal(stepName({ run: 'npm test\nnpm run lint' }), 'Run npm test');
  assert.equal(stepName({ uses: 'actions/setup-node@v4' }), 'Run actions/setup-node@v4');
  assert.equal(stepName({}, 2), 'step 3');
  assert.equal(startsTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n')), true);
  assert.equal(startsTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: github/codeql-action/analyze@v3\n')), false);
});

test('selfHostedSetups: a runtime-only setup action on a self-hosted job; not on a hosted one, not with a cache or registry input, not setup-go unless cache: false', () => {
  const d = doc(`on: push
jobs:
  box:
    runs-on: [self-hosted, pitlane-exec]
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm test
  cloud:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
      - run: npm test
`);
  assert.deepEqual(selfHostedSetups(d), [{ job: 'box', step: 'Run actions/setup-node@v4', action: 'setup-node' }]);
  // A setup that restores a dependency cache or signs in to a registry does more than state a version.
  const more = doc(`on: push
jobs:
  cached:
    runs-on: [self-hosted, x]
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
  registry:
    runs-on: [self-hosted, x]
    steps:
      - uses: actions/setup-node@v4
        with:
          registry-url: https://npm.pkg.github.com
  plain:
    runs-on: [self-hosted, x]
    steps:
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
`);
  assert.deepEqual(selfHostedSetups(more).map((s) => s.job), ['plain']);
  // setup-go caches by default: only an explicit cache: false makes it runtime-only.
  const go = doc(`on: push
jobs:
  cached:
    runs-on: [self-hosted, x]
    steps:
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
  plain:
    runs-on: [self-hosted, x]
    steps:
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: false
  node:
    runs-on: [self-hosted, x]
    steps:
      - uses: actions/setup-node@v4
        with:
          cache: false
`);
  assert.deepEqual(selfHostedSetups(go).map((s) => s.job), ['plain', 'node']);
});

const setupFile = (runsOn) => `on: push
jobs:
  test:
    runs-on: ${runsOn}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Run tests
        run: npm test
`;
const SETUP = (secs) => [['Set up job', 1], ['Run actions/checkout@v4', 2], ['Run actions/setup-node@v4', secs], ['Run tests', 30], ['Complete job', 0]];

test('toolchain setup on a self-hosted runner fires at a few seconds a step, saving the whole step from its own job; the same seconds on a hosted runner do not', () => {
  const a = audit([{ name: 'CI', runs: runs(40), jobsPerRun: [[{ ...job({ steps: SETUP(3), selfHosted: true }), name: 'test' }]], file: setupFile('[self-hosted, box]') }]);
  const [f] = find(a, 'toolchain setup');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.equal(f.saving_min_week, 2); // 3 s x 40 runs / 60, the whole step
  assert.match(f.evidence, /on self-hosted runners takes 3 s a run \(setup-node in job test, 3 s\)/);
  assert.match(f.fix, /drop the setup step/);
  const hosted = audit([{ name: 'CI', runs: runs(40), jobsPerRun: [[job({ steps: SETUP(3) })]], file: setupFile('ubuntu-latest') }]);
  assert.equal(find(hosted, 'toolchain setup').length, 0);
  // A self-hosted job with no setup action in the file is the image's own setup, judged by the usual threshold.
  const plain = audit([{ name: 'CI', runs: runs(40), jobsPerRun: [[{ ...job({ steps: SETUP(3), selfHosted: true }), name: 'test' }]], file: setupFile('[self-hosted, box]').replace(/      - uses: actions\/setup-node@v4\n        with:\n          node-version: '22'\n/, '') }]);
  assert.equal(find(plain, 'toolchain setup').length, 0);
  // An API job no file job claims prices nothing.
  const unnamed = audit([{ name: 'CI', runs: runs(40), jobsPerRun: [[job({ steps: SETUP(3), selfHosted: true })]], file: setupFile('[self-hosted, box]') }]);
  assert.equal(find(unnamed, 'toolchain setup').length, 0);
  // Mixed hosting: the self-hosted step is priced from its own job (3 s); the hosted jobs' 120 s
  // setups are the general rule's, half of them, and never described as self-hosted.
  const mixedFile = `on: push
jobs:
  box:
    runs-on: [self-hosted, x]
    steps:
      - uses: actions/setup-node@v4
      - name: Run tests
        run: npm test
  cloud:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
      - name: Run tests
        run: npm test
  cloud2:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
      - name: Run tests
        run: npm test
`;
  const mixed = audit([{ name: 'CI', runs: runs(40), jobsPerRun: [[
    { ...job({ steps: SETUP(3), selfHosted: true }), name: 'box' },
    { ...job({ steps: SETUP(120) }), name: 'cloud' },
    { ...job({ steps: SETUP(120) }), name: 'cloud2' },
  ]], file: mixedFile }]);
  const ms = find(mixed, 'toolchain setup');
  assert.equal(ms.length, 1); // one grouped finding for the workflow, two members
  assert.match(ms[0].evidence, /3 s a run on self-hosted runners|on self-hosted runners takes 3 s a run \(setup-node in job box, 3 s\)/);
  assert.doesNotMatch(ms[0].evidence, /2m 3s|123 s/);
  assert.equal(ms[0].saving_min_week, 82); // 3 s x 40 / 60 = 2, plus 0.5 x 240 s x 40 / 60 = 80
});

test('test output floods the log: a passing job\'s log over the threshold, in megabytes a week; a small log is nothing', () => {
  const big = () => ({ ...job({ selfHosted: true }), log_bytes: 471642 });
  const a = audit([{ name: 'ci', runs: runs(70), jobsPerRun: [[big()], [big()], [big()]], file: 'on: push\njobs:\n  test:\n    runs-on: [self-hosted, x]\n    steps:\n      - run: node --test test/*.test.mjs\n' }]);
  const [f] = find(a, 'test output floods the log');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.equal(f.unit, 'log');
  assert.equal(f.confidence, 'measured');
  assert.match(f.evidence, /log is 461 KB \(median of 3 sampled jobs\), about 31.5 MB a week over 1 job a run and 70 runs; the workflow starts a test runner, whose line for each passing test is the likely source \(the bytes themselves were not read\)/);
  assert.match(f.fix, /lists each failed test with its assertion and stack/);
  assert.match(f.evidence, /from a self-hosted runner/);
  assert.equal(savingText(f), 'about 31.5 MB of log a week (measured), not minutes');
  assert.match(f.fix, /--test-reporter=dot/);
  // A tool's own output on a hosted runner, no test runner in the file: not the workflow's to quiet.
  const tool = audit([{ name: 'CodeQL', runs: runs(70), jobsPerRun: [[{ ...job(), log_bytes: 210 * 1024 }]], file: 'on: push\njobs:\n  analyze:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: github/codeql-action/analyze@v3\n' }]);
  assert.equal(find(tool, 'test output floods the log').length, 0);
  // The same output from a self-hosted runner is uploaded from the host, and counts.
  const box = audit([{ name: 'Build', runs: runs(70), jobsPerRun: [[{ ...job({ selfHosted: true }), log_bytes: 210 * 1024 }]], file: 'on: push\njobs:\n  build:\n    runs-on: [self-hosted, x]\n    steps:\n      - run: make\n' }]);
  assert.equal(find(box, 'test output floods the log').length, 1);
  assert.doesNotMatch(find(box, 'test output floods the log')[0].evidence, /test runner/);
  const small = audit([{ name: 'ci', runs: runs(70), jobsPerRun: [[{ ...job(), log_bytes: 50 * 1024 }]] }]);
  assert.equal(find(small, 'test output floods the log').length, 0);
  const unread = audit([{ name: 'ci', runs: runs(70), jobsPerRun: [[job()]] }]);
  assert.equal(find(unread, 'test output floods the log').length, 0);
  assert.equal(unread.workflows[0].log_bytes_p50, null);
  assert.equal(savingText({ unit: 'log' }), 'log volume, not minutes');
});

test('client.sizeOf: the redirect costs one API call, the size comes from a HEAD of the file\'s address without the token, and no redirect or no length is null', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, method: init.method || 'GET', auth: Boolean(init.headers && init.headers.Authorization), redirect: init.redirect });
    const api = { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '1767607200', 'x-ratelimit-limit': '5000' };
    if (url.endsWith('/actions/jobs/1/logs')) return new Response(null, { status: 302, headers: { ...api, location: 'https://blobs.example/logs/1' } });
    if (url === 'https://blobs.example/logs/1') return new Response(null, { status: 200, headers: { 'content-length': '471642' } });
    if (url.endsWith('/actions/jobs/3/logs')) return new Response(null, { status: 302, headers: { ...api, location: 'https://blobs.example/logs/3' } });
    if (url === 'https://blobs.example/logs/3') return new Response(null, { status: 200 }); // no Content-Length: no size, not an empty log
    if (url.endsWith('/actions/jobs/2/logs')) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: api });
    return new Response(JSON.stringify({}), { status: 200, headers: api });
  };
  const client = createClient({ token: 't', fetchImpl });
  assert.equal(await client.sizeOf('repos/o/r/actions/jobs/1/logs'), 471642);
  assert.equal(client.calls, 1);
  assert.deepEqual(seen.map((s) => [s.method, s.auth, s.redirect]), [['GET', true, 'manual'], ['HEAD', false, undefined]]);
  assert.equal(await client.sizeOf('repos/o/r/actions/jobs/2/logs'), null);
  assert.equal(await client.sizeOf('repos/o/r/actions/jobs/3/logs'), null);
  assert.equal(await client.sizeOf('repos/o/r'), null);
});
