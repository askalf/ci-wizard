// Work done twice or shipped twice, and logs nobody reads: tests started twice in a job or a run,
// an artifact of a file another step already published, a runtime setup on a self-hosted runner
// that has the runtime, and a passing job's log the size of a test listing. Each against the
// pattern it must catch and a near miss it must leave alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../src/analyse.mjs';
import { createClient } from '../src/github.mjs';
import { savingText } from '../src/report.mjs';
import { duplicateUploads, repeatedTests, runnerOf, selfHostedSetups, stepName, testCommands } from '../src/trim.mjs';
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
  assert.equal(runnerOf('node --test a/*.test.mjs'), 'node --test');
  assert.equal(runnerOf('npm run test:unit'), 'npm run test');
  assert.equal(stepName({ run: 'npm test\nnpm run lint' }), 'Run npm test');
  assert.equal(stepName({ uses: 'actions/setup-node@v4' }), 'Run actions/setup-node@v4');
  assert.equal(stepName({}, 2), 'step 3');
});

test('repeatedTests: the same runner in two steps of one job, the same command or another path; two jobs with the same command on one kind of runner', () => {
  const same = doc(`on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Unit tests
        run: npm test
      - name: Again
        run: npm test -- --silent
`);
  assert.deepEqual(repeatedTests(same), [{ scope: 'job', jobs: ['test'], steps: ['Unit tests', 'Again'], command: 'npm test', same: true }]);
  const exported = doc(`on: push
jobs:
  test:
    runs-on: [self-hosted, x]
    steps:
      - name: Unit tests
        run: node --test a/*.test.mjs b/*.test.mjs
      - name: Public edition
        run: |
          node tools/export.mjs "$RUNNER_TEMP/out"
          cd "$RUNNER_TEMP/out"
          node --test a/*.test.mjs
`);
  const [r] = repeatedTests(exported);
  assert.equal(r.scope, 'job');
  assert.equal(r.same, false);
  assert.deepEqual(r.steps, ['Unit tests', 'Public edition']);
  assert.equal(r.command, 'node --test');
  const across = doc(`on: push
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: pytest tests
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: pytest -q tests
`);
  assert.deepEqual(repeatedTests(across), [{ scope: 'workflow', jobs: ['unit', 'coverage'], steps: ['Run pytest tests', 'Run pytest -q tests'], command: 'pytest tests', same: true }]);
});

test('repeatedTests: near misses stay quiet: one run, a matrix, two platforms, and two different suites', () => {
  const once = doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n');
  assert.deepEqual(repeatedTests(once), []);
  const matrix = doc(`on: push
jobs:
  t:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - run: npm test
  u:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - run: npm test
`);
  assert.deepEqual(repeatedTests(matrix), []);
  const platforms = doc('on: push\njobs:\n  linux:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n  mac:\n    runs-on: macos-latest\n    steps:\n      - run: npm test\n');
  assert.deepEqual(repeatedTests(platforms), []);
  const suites = doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run test:unit\n      - run: npm run test:e2e\n');
  // Two scripts of one runner in one job: the file cannot say they are the same tests, and the finding says so.
  assert.deepEqual(repeatedTests(suites).map((r) => [r.scope, r.same, r.command]), [['job', false, 'npm run test']]);
  // One step that starts two suites of one runner is one step, not a repeat.
  const multiline = doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Suites\n        run: |\n          pytest tests/unit\n          pytest tests/integration\n');
  assert.deepEqual(repeatedTests(multiline), []);
  // Two unnamed steps with the same command share a display name and are still two runs.
  const unnamed = doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: npm test\n');
  assert.deepEqual(repeatedTests(unnamed), [{ scope: 'job', jobs: ['t'], steps: ['Run npm test', 'Run npm test'], command: 'npm test', same: true }]);
  // Two runners in one job: the one started twice is found, the one started once is not.
  const mixed = doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: A\n        run: npm test\n      - name: B\n        run: npm test\n      - name: C\n        run: pytest tests\n');
  assert.deepEqual(repeatedTests(mixed), [{ scope: 'job', jobs: ['t'], steps: ['A', 'B'], command: 'npm test', same: true }]);
});

test('duplicateUploads: a SARIF uploaded as an artifact and to code scanning; a release asset uploaded twice; a failure-only or globbed artifact is not a duplicate', () => {
  const scorecard = doc(`on: push
jobs:
  analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: ossf/scorecard-action@v2
        with:
          results_file: results.sarif
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: SARIF file
          path: results.sarif
      - name: Upload to code scanning
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
`);
  assert.deepEqual(duplicateUploads(scorecard), [{ job: 'analysis', step: 'Upload artifact', path: 'results.sarif', alsoTo: ['code scanning'] }]);
  const release = doc(`on: release
jobs:
  r:
    runs-on: ubuntu-latest
    steps:
      - run: tar czf dist.tar.gz dist
      - uses: actions/upload-artifact@v4
        with:
          path: ./dist.tar.gz
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            dist.tar.gz
            checksums.txt
`);
  assert.deepEqual(duplicateUploads(release), [{ job: 'r', step: 'Run actions/upload-artifact@v4', path: 'dist.tar.gz', alsoTo: ['the release'] }]);
  // A `gh release upload` in a script never counts: the shell's path to it and its directory are not the file's to establish.
  const shell = doc(`on: release
jobs:
  r:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: dist.tar.gz
      - run: gh release upload "$TAG" dist.tar.gz --clobber
      - run: test "$GITHUB_REF_TYPE" = tag || exit 0; gh release upload "$TAG" dist.tar.gz
      - run: gh release upload v1 dist.tar.gz
        working-directory: package
`);
  assert.deepEqual(duplicateUploads(shell), []);
  // A release upload only on a tag leaves the artifact the only copy on every other run.
  const tagOnly = doc(`on: push
jobs:
  r:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: dist.tar.gz
      - uses: softprops/action-gh-release@v2
        if: startsWith(github.ref, 'refs/tags/')
        with:
          files: dist.tar.gz
`);
  assert.deepEqual(duplicateUploads(tagOnly), []);
  // The same condition on both steps is one path through the run: a duplicate again.
  const bothOnTag = doc(`on: push
jobs:
  r:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: startsWith(github.ref, 'refs/tags/')
        with:
          path: dist.tar.gz
      - uses: softprops/action-gh-release@v2
        if: startsWith(github.ref, 'refs/tags/')
        with:
          files: dist.tar.gz
`);
  assert.equal(duplicateUploads(bothOnTag).length, 1);
  // An artifact kept after a failure beside a destination that runs on success alone: the artifact
  // is the only copy of a failed run's file. Under one condition both are one path again.
  const afterFailure = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          path: results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          path: results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
`);
  assert.deepEqual(duplicateUploads(afterFailure).map((u) => u.job), ['b']);
  // A destination with no condition after the artifact counts only when it comes next: a step
  // between them that fails skips it, and the artifact is the only copy of that run's file.
  const between = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: results.sarif
      - run: exit 1
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
      - run: exit 1
      - uses: actions/upload-artifact@v4
        with:
          path: results.sarif
`);
  // In b the destination went first: a failure after it skips the artifact, never the destination.
  assert.deepEqual(duplicateUploads(between).map((u) => u.job), ['b']);
  // The same with matching conditions: a tag condition still carries the implicit success(), so a
  // failure between them skips the later destination; always() on the destination survives it.
  const betweenGuarded = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: startsWith(github.ref, 'refs/tags/')
        with:
          path: results.sarif
      - run: exit 1
      - uses: github/codeql-action/upload-sarif@v3
        if: startsWith(github.ref, 'refs/tags/')
        with:
          sarif_file: results.sarif
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          path: results.sarif
      - run: exit 1
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
`);
  assert.deepEqual(duplicateUploads(betweenGuarded).map((u) => u.job), ['b']);
});

test('selfHostedSetups: a setup action on a self-hosted job, not on a hosted one', () => {
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

const twiceFile = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Unit tests
        run: npm test
      - name: Tests again
        run: npm test
`;
const TWICE = [['Set up job', 1], ['Run actions/checkout@v4', 2], ['Unit tests', 30], ['Tests again', 20], ['Complete job', 0]];

test('tests run twice: the shorter run is the saving, priced from the sample, confirmed when the command is the same', () => {
  const a = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: TWICE }), name: 'test' }]], file: twiceFile }]);
  const [f] = find(a, 'tests run twice');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.equal(f.confidence, 'confirmed');
  assert.equal(f.saving_min_week, 10); // 20 s x 30 runs / 60
  assert.match(f.evidence, /job test starts `npm test` in steps "Unit tests" and "Tests again" \(30 s and 20 s a run\)/);
  assert.match(f.example, /if: github.event_name == 'push'/);
  assert.match(f.tradeoff, /transformed tree/);
});

test('tests run twice: a second step the sample never timed adds nothing to the estimate, and the evidence says so', () => {
  const a = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: TWICE.filter(([n]) => n !== 'Tests again') }), name: 'test' }]], file: twiceFile }]);
  // Under the noise floor with no priced second step: the finding is left out rather than claiming a saving.
  assert.equal(find(a, 'tests run twice').length, 0);
});

test("tests run twice: each job's steps are priced from that job's own runs, not pooled by step name", () => {
  const file = `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Unit tests
        run: npm test
      - name: Again
        run: npm test
  b:
    runs-on: ubuntu-latest
    steps:
      - name: Unit tests
        run: npm test
      - name: Again
        run: npm test
`;
  const stepsOf = (s) => [['Set up job', 1], ['Unit tests', s], ['Again', s], ['Complete job', 0]];
  const a = audit([{ name: 'CI', runs: runs(60), jobsPerRun: [[{ ...job({ steps: stepsOf(10) }), name: 'a' }, { ...job({ steps: stepsOf(100) }), name: 'b' }]], file }]);
  const [f] = find(a, 'tests run twice');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  // Each job's second run at its own job's seconds, and no cross-job entry on top: a run counts once.
  assert.deepEqual(a.workflows[0].repeated_tests.map((r) => [r.scope, r.jobs, r.seconds]), [['job', ['a'], [10, 10]], ['job', ['b'], [100, 100]]]);
  assert.equal(f.saving_min_week, 110); // (10 + 100) s x 60 runs / 60, not 2 x 55 and not a third entry across the jobs
  // An API job no file job claims prices nothing.
  const unnamed = audit([{ name: 'CI', runs: runs(60), jobsPerRun: [[job({ steps: stepsOf(10) })]], file }]);
  assert.equal(find(unnamed, 'tests run twice').length, 0);
});

test('tests run twice: two jobs with one identical two-suite step are one cross-job finding, priced once', () => {
  const file = `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Suites
        run: |
          pytest tests/unit
          pytest tests/integration
  b:
    runs-on: ubuntu-latest
    steps:
      - name: Suites
        run: |
          pytest tests/unit
          pytest tests/integration
`;
  const steps = [['Set up job', 1], ['Suites', 60], ['Complete job', 0]];
  const a = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps }), name: 'a' }, { ...job({ steps }), name: 'b' }]], file }]);
  assert.deepEqual(a.workflows[0].repeated_tests.map((r) => [r.scope, r.jobs, r.command]), [['workflow', ['a', 'b'], 'pytest tests/unit']]);
  assert.equal(find(a, 'tests run twice')[0].saving_min_week, 30); // one 60 s step x 30 runs / 60, not two
  // A step in a within-job finding is out of every cross-job match, under any command.
  const shared = doc('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: A\n        run: |\n          npm test\n          pytest tests\n      - name: B\n        run: npm test\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - name: C\n        run: pytest tests\n');
  assert.deepEqual(repeatedTests(shared).map((r) => [r.scope, r.steps, r.command]), [['job', ['A', 'B'], 'npm test']]);
  // One step of two runners beside another such step: one finding, each step priced once.
  const twoRunners = doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: A\n        run: |\n          npm test\n          pytest tests\n      - name: B\n        run: |\n          npm test\n          pytest tests\n');
  assert.deepEqual(repeatedTests(twoRunners).map((r) => [r.steps, r.command]), [[['A', 'B'], 'npm test']]);
});

test('tests run twice: two steps with one display name share a timing list and are priced at its minimum', () => {
  const file = 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: npm test\n';
  const steps = [['Set up job', 1], ['Run npm test', 30], ['Run npm test', 10], ['Complete job', 0]];
  const a = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps }), name: 'test' }]], file }]);
  const [f] = find(a, 'tests run twice');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.deepEqual(a.workflows[0].repeated_tests[0].seconds, [10, 10]);
  assert.equal(f.saving_min_week, 5); // 10 s x 30 runs / 60, the lower of the two shared timings
});

test('an artifact that duplicates another upload: the artifact step\'s time is the saving, confirmed', () => {
  const file = `on: push
jobs:
  analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run analysis
        run: ./scan > results.sarif
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          path: results.sarif
      - name: Upload to code scanning
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
`;
  const steps = [['Set up job', 1], ['Run actions/checkout@v4', 2], ['Run analysis', 30], ['Upload artifact', 4], ['Upload to code scanning', 3], ['Complete job', 0]];
  const a = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[{ ...job({ steps }), name: 'analysis' }]], file }]);
  const [f] = find(a, 'an artifact that duplicates another upload');
  // At one run a week the saving is under the noise floor; a duplicate upload stays all the same.
  const rare = audit([{ name: 'Scorecard', runs: runs(1), jobsPerRun: [[{ ...job({ steps }), name: 'analysis' }]], file }]);
  assert.equal(find(rare, 'an artifact that duplicates another upload').length, 1);
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.equal(f.confidence, 'confirmed');
  assert.equal(f.saving_min_week, 2); // 4 s x 30 runs / 60
  assert.match(f.evidence, /uploads results.sarif as an artifact in "Upload artifact" \(4 s a run\) and sends the same file to code scanning/);
  assert.match(f.example, /# remove/);
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

test('toolchain setup on a self-hosted runner fires at a few seconds a job, saving the whole step; the same seconds on a hosted runner do not', () => {
  const a = audit([{ name: 'CI', runs: runs(40), jobsPerRun: [[{ ...job({ steps: SETUP(3), selfHosted: true }), name: 'test' }]], file: setupFile('[self-hosted, box]') }]);
  const [f] = find(a, 'toolchain setup');
  assert.ok(f, JSON.stringify(a.findings.map((x) => x.what)));
  assert.equal(f.saving_min_week, 2); // 3 s x 40 runs / 60, the whole step
  assert.match(f.evidence, /on self-hosted runners takes 3 s a run \(setup-node in job test, 3 s\)/);
  assert.match(f.fix, /drop the setup step/);
  const hosted = audit([{ name: 'CI', runs: runs(40), jobsPerRun: [[job({ steps: SETUP(3) })]], file: setupFile('ubuntu-latest') }]);
  assert.equal(find(hosted, 'toolchain setup').length, 0);
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
  // A self-hosted job with no setup action in the file is the image's own setup, judged by the usual threshold.
  const plain = audit([{ name: 'CI', runs: runs(40), jobsPerRun: [[job({ steps: SETUP(3), selfHosted: true })]], file: setupFile('[self-hosted, box]').replace(/      - uses: actions\/setup-node@v4\n        with:\n          node-version: '22'\n/, '') }]);
  assert.equal(find(plain, 'toolchain setup').length, 0);
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

test('client.sizeOf: the redirect costs one API call, the size comes from a HEAD of the file\'s address without the token, and no redirect is null', async () => {
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
