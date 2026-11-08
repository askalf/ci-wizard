// Work done twice or shipped twice, and logs nobody reads: tests started twice in a job or a run,
// an artifact of a file another step already published, a runtime setup on a self-hosted runner
// that has the runtime, and a passing job's log the size of a test listing. Each against the
// pattern it must catch and a near miss it must leave alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../src/analyse.mjs';
import { createClient } from '../src/github.mjs';
import { savingText } from '../src/report.mjs';
import { duplicateUploads, onlyCommand, repeatedTests, runnerOf, selfHostedSetups, stepName, survivesFailure, testCommands } from '../src/trim.mjs';
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

test('repeatedTests: the same one-command test step twice, in one job or in two jobs alike in every way the file shows', () => {
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
  assert.equal(onlyCommand('set -euo pipefail\nnpm test -- --silent', 'npm test'), true);
  assert.equal(onlyCommand('cd pkg\nnpm test', 'npm test'), false); // a cd moves the tests: not the same step
  assert.equal(onlyCommand('export DB_BACKEND=sqlite\nnpm test', 'npm test'), false); // an export changes their environment
  assert.equal(onlyCommand('echo postgres > backend.conf\nnpm test', 'npm test'), false); // a redirection writes a file
  assert.equal(onlyCommand('echo "starting" | tee log.txt\nnpm test', 'npm test'), false);
  assert.equal(onlyCommand('echo "starting the tests"\nnpm test', 'npm test'), true);
  assert.equal(onlyCommand('npm test\nnpm run build', 'npm test'), false);
  assert.equal(onlyCommand('npm test\npytest tests/a', 'npm test'), false); // another suite is work that stays
  assert.equal(onlyCommand('npm run build', 'npm test'), false);
});

test('repeatedTests: what the file can tell apart is no repeat: other paths, another directory, a cd, another environment, a build beside, a matrix, two platforms, a condition', () => {
  // The same runner on other paths, or after an export and a cd: two suites as far as the file can tell.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test a/*.test.mjs b/*.test.mjs\n      - run: node --test a/*.test.mjs\n')), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test a/*.test.mjs\n      - run: |\n          node tools/export.mjs out\n          cd out\n          node --test a/*.test.mjs\n')), []);
  // The same cd before the test and after it are two directories; two cds anywhere are no repeat.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          npm test\n          cd packages/backend\n      - run: |\n          cd packages/backend\n          npm test\n')), []);
  // Another environment is another result.
  const envs = doc(`on: push
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        env:
          DB_BACKEND: sqlite
      - run: npm test
        env:
          DB_BACKEND: postgres
  a:
    runs-on: ubuntu-latest
    env:
      DB_BACKEND: sqlite
    steps:
      - run: npm test
  b:
    runs-on: ubuntu-latest
    env:
      DB_BACKEND: postgres
    steps:
      - run: npm test
  c:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres
    steps:
      - run: npm test
  d:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
  assert.deepEqual(repeatedTests(envs), []);
  // The environment set inside the script is an environment too.
  const exported = doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          export DB_BACKEND=sqlite\n          npm test\n      - run: |\n          export DB_BACKEND=postgres\n          npm test\n');
  assert.deepEqual(repeatedTests(exported), []);
  // A configuration written before the tests picks what they test.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo sqlite > backend.conf\n          npm test\n      - run: |\n          echo postgres > backend.conf\n          npm test\n')), []);
  // Two runtimes are two results, in two jobs and within one; a step between two test steps can change what the second tests.
  const runtimes = doc(`on: push
jobs:
  n20:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test
  n22:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
  same1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
  within:
    runs-on: ubuntu-latest
    steps:
      - name: A
        run: npm test
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: B
        run: npm test
      - name: C
        run: npm test
`);
  assert.deepEqual(repeatedTests(runtimes).map((r) => [r.scope, r.jobs, r.steps]), [['job', ['within'], ['B', 'C']], ['workflow', ['n22', 'same1'], ['Run npm test', 'Run npm test']]]);
  const exportedRuns = [['Set up job', 1], ['Run export DB_BACKEND=sqlite', 30], ['Run export DB_BACKEND=postgres', 30], ['Complete job', 0]];
  const e = audit([{ name: 'CI', runs: runs(30), jobsPerRun: [[{ ...job({ steps: exportedRuns }), name: 't' }]], file: 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          export DB_BACKEND=sqlite\n          npm test\n      - run: |\n          export DB_BACKEND=postgres\n          npm test\n' }]);
  assert.equal(find(e, 'tests run twice').length, 0);
  // A build or another suite beside the tests keeps work that must stay.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          npm test\n          npm run build:a\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          npm test\n          npm run build:b\n')), []);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: A\n        run: |\n          npm test\n          pytest tests\n      - name: B\n        run: npm test\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - name: C\n        run: pytest tests\n')), []);
  // Two scripts of one runner, one run each, are two suites.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run test:unit\n      - run: npm run test:e2e\n')), []);
  // One run, a matrix, two platforms.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n')), []);
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
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  linux:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n  mac:\n    runs-on: macos-latest\n    steps:\n      - run: npm test\n')), []);
  // Two jobs, or two steps, that never run in the same run; under one condition they are a repeat.
  const gated = doc(`on: [push, pull_request]
jobs:
  onpush:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  onpr:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  both:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  both2:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
  assert.deepEqual(repeatedTests(gated).map((r) => r.jobs), [['both', 'both2']]);
  const gatedSteps = doc(`on: [push, pull_request]
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - name: On push
        if: github.event_name == 'push'
        run: npm test
      - name: On pull request
        if: github.event_name == 'pull_request'
        run: npm test
      - name: A
        if: github.event_name == 'push'
        run: pytest tests
      - name: B
        if: github.event_name == 'push'
        run: pytest tests
`);
  assert.deepEqual(repeatedTests(gatedSteps).map((r) => [r.steps, r.command]), [[['A', 'B'], 'pytest tests']]);
  // A monorepo: the same command in two declared directories is two suites; the same directory twice is a repeat.
  const monorepo = doc(`on: push
defaults:
  run:
    working-directory: packages
jobs:
  one:
    runs-on: ubuntu-latest
    steps:
      - name: Front
        run: npm test
        working-directory: packages/frontend
      - name: Also front
        run: npm test
        working-directory: packages/frontend
      - name: Back
        run: npm test
        working-directory: packages/backend
  two:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: packages/api
    steps:
      - run: npm test
  three:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
  assert.deepEqual(repeatedTests(monorepo).map((r) => [r.scope, r.jobs, r.steps]), [['job', ['one'], ['Front', 'Also front']]]);
  // Two unnamed steps with the same command share a display name and are still two runs; a third runner
  // started twice beside them is its own repeat, and a step in one finding is in no other.
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: npm test\n')), [{ scope: 'job', jobs: ['t'], steps: ['Run npm test', 'Run npm test'], command: 'npm test', same: true }]);
  assert.deepEqual(repeatedTests(doc('on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: A\n        run: npm test\n      - name: B\n        run: npm test\n      - name: C\n        run: pytest tests\n')), [{ scope: 'job', jobs: ['t'], steps: ['A', 'B'], command: 'npm test', same: true }]);
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
  assert.deepEqual(duplicateUploads(scorecard), [{ job: 'analysis', step: 'Upload artifact', path: 'results.sarif', alsoTo: ['code scanning'], after: true }]);
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
  assert.deepEqual(duplicateUploads(release), [{ job: 'r', step: 'Run actions/upload-artifact@v4', path: 'dist.tar.gz', alsoTo: ['the release'], after: true }]);
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
  // A directory given to upload-sarif sends its SARIF files; the artifact keeps everything in it.
  const directory = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: reports
      - uses: actions/upload-artifact@v4
        with:
          path: reports
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: reports/
      - uses: actions/upload-artifact@v4
        with:
          path: reports/
`);
  assert.deepEqual(duplicateUploads(directory), []);
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
  // Under always() on both, the destination can fail and the artifact still goes up: no duplicate either.
  assert.deepEqual(duplicateUploads(afterFailure), []);
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
  assert.deepEqual(duplicateUploads(betweenGuarded), []);
  // The destination first and both under always(): a failed destination leaves the artifact the only copy.
  const sarifFirstAlways = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: results.sarif
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          path: results.sarif
`);
  assert.deepEqual(duplicateUploads(sarifFirstAlways), []);
  // A compound condition that mentions always() still carries success(): it does not survive the failure.
  const compound = doc(betweenGuarded === null ? '' : `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        if: always() && success()
        with:
          path: results.sarif
      - run: exit 1
      - uses: github/codeql-action/upload-sarif@v3
        if: always() && success()
        with:
          sarif_file: results.sarif
`);
  assert.deepEqual(duplicateUploads(compound), []);
  // A destination allowed to fail can leave the artifact the only copy.
  const tolerant = doc(`on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        continue-on-error: true
        with:
          sarif_file: results.sarif
      - uses: actions/upload-artifact@v4
        with:
          path: results.sarif
`);
  assert.deepEqual(duplicateUploads(tolerant), []);
  assert.equal(survivesFailure('always()'), true);
  assert.equal(survivesFailure('${{ !cancelled() }}'), true);
  assert.equal(survivesFailure('always() && success()'), false);
  assert.equal(survivesFailure(''), false);
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
  assert.match(f.evidence, /job test runs the same test step twice, `npm test` in steps "Unit tests" and "Tests again" \(30 s and 20 s a run\)/);
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
  assert.match(f.evidence, /uploads results.sarif as an artifact in "Upload artifact" \(4 s a run\) and sends the same file to code scanning, in a later step/);
  // The destination comes after the artifact and can fail after it went up: the fix is the order and failure(), not a deletion.
  assert.match(f.fix, /move the artifact step after the upload it duplicates and give it `if: failure\(\)`/);
  assert.match(f.example, /if: failure\(\)/);
  // The destination first: the artifact step is dropped.
  const first = file.replace(/      - name: Upload artifact\n        uses: actions\/upload-artifact@v4\n        with:\n          path: results.sarif\n/, '') + '      - name: Upload artifact\n        uses: actions/upload-artifact@v4\n        with:\n          path: results.sarif\n';
  const b = audit([{ name: 'Scorecard', runs: runs(30), jobsPerRun: [[{ ...job({ steps }), name: 'analysis' }]], file: first }]);
  const [g] = find(b, 'an artifact that duplicates another upload');
  assert.match(g.fix, /^drop the artifact step/);
  assert.match(g.example, /# remove/);
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
