// The patch for "outdated runs keep going": what it adds, where, and that git applies it to the file
// the audit read; the files it refuses, with the reason; and the report and CLI that carry it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { CANCEL_GROUP } from '../src/advice.mjs';
import { analyse } from '../src/analyse.mjs';
import { report } from '../src/report.mjs';
import { main as cli } from '../src/cli.mjs';
import { cancelOutdatedFix, insertionPatch } from '../src/fix.mjs';
import { data, fakeFetch, job, run } from './helpers.mjs';

const PATH = '.github/workflows/ci.yml';

let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }

/** `text` at PATH in a fresh directory, `patch` applied by git; the file after, or null without git. */
function applied(text, patch, path = PATH) {
  if (!hasGit) return null;
  const dir = mkdtempSync(join(tmpdir(), 'ci-wizard-fix-'));
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
  writeFileSync(join(dir, 'fix.patch'), patch);
  execFileSync('git', ['apply', '--whitespace=nowarn', 'fix.patch'], { cwd: dir, stdio: 'pipe' });
  return readFileSync(join(dir, path), 'utf8');
}

/** The patch applies, and the file after it reads as the workflow plus the group. */
function holds(text, path = PATH) {
  const r = cancelOutdatedFix(path, text);
  assert.ok(r.patch, r.refused);
  const after = applied(text, r.patch, path);
  if (after !== null) {
    const { concurrency, ...rest } = parse(after);
    assert.deepEqual(rest, parse(text));
    assert.deepEqual(concurrency, { group: CANCEL_GROUP, 'cancel-in-progress': true });
  }
  return { ...r, after };
}

const WF = 'name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\n\n# the jobs\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';

test('the group: per pull request number and event; every other run is its own group', () => {
  assert.equal(CANCEL_GROUP, '${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}');
  assert.doesNotMatch(CANCEL_GROUP, /head_ref/);
});

test('the patch adds the group before jobs, above the comment on it, and git applies it', () => {
  const r = holds(WF);
  assert.match(r.patch, /^diff --git a\/\.github\/workflows\/ci\.yml b\/\.github\/workflows\/ci\.yml\n--- a\/.+\n\+\+\+ b\/.+\n@@ -4,6 \+4,10 @@\n/);
  if (r.after !== null) {
    assert.ok(r.after.includes(`branches: [main]\n\nconcurrency:\n  group: ${CANCEL_GROUP}\n  cancel-in-progress: true\n\n# the jobs\njobs:\n`), r.after);
  }
});

test('indent, line ends and the file end follow the file', () => {
  const four = 'on: pull_request\njobs:\n    t:\n        runs-on: ubuntu-latest\n';
  const r4 = holds(four);
  if (r4.after !== null) assert.ok(r4.after.startsWith(`on: pull_request\nconcurrency:\n    group: ${CANCEL_GROUP}\n    cancel-in-progress: true\n\njobs:\n`), r4.after);
  const crlf = 'on:\r\n  pull_request:\r\njobs:\r\n  t:\r\n    runs-on: ubuntu-latest\r\n';
  const rc = holds(crlf);
  if (rc.after !== null) {
    assert.ok(rc.after.includes(`concurrency:\r\n  group: ${CANCEL_GROUP}\r\n  cancel-in-progress: true\r\n\r\njobs:\r\n`));
    assert.equal(rc.after.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF in a CRLF file');
  }
  // No line end after the last line: the context reaches it and git is told.
  const open = 'on: [push, pull_request]\njobs:\n  t:\n    runs-on: x';
  const ro = holds(open);
  assert.match(ro.patch, /\n\\ No newline at end of file\n$/);
  if (ro.after !== null) assert.ok(ro.after.endsWith('runs-on: x'));
  // jobs first in the file: nothing above it to keep.
  holds('jobs:\n  t:\n    runs-on: x\non:\n  pull_request_target:\n');
});

test('a file it cannot patch safely gets the reason, never a patch', () => {
  const no = (text) => cancelOutdatedFix(PATH, text).refused;
  assert.match(no(''), /was not read/);
  assert.match(no(undefined), /was not read/);
  assert.match(no('on: pull_request\njobs: [\n'), /does not parse/);
  assert.match(no('on: pull_request\njobs:\n  t:\n    runs-on: x\n---\non: push\n'), /more than one YAML document/);
  assert.match(no('{on: pull_request, jobs: {t: {runs-on: x}}}'), /not a block mapping/);
  assert.match(no('on: pull_request\nconcurrency:\n  group: ci\njobs:\n  t:\n    runs-on: x\n'), /already has a concurrency setting/);
  assert.match(no('on:\n  pull_request:\n  workflow_call:\njobs:\n  t:\n    runs-on: x\n'), /reusable workflow/);
  assert.match(no('on: push\njobs:\n  t:\n    runs-on: x\n'), /no pull request trigger/);
  assert.match(no('  on: pull_request\n  jobs:\n    t:\n      runs-on: x\n'), /no top-level jobs key at the start of a line/);
  assert.match(no('on: pull_request\nname: x\n'), /no top-level jobs key/);
});

test('insertionPatch: counts and context at the start of a file', () => {
  const p = insertionPatch('a.yml', 'one\ntwo\n', 0, ['new']);
  assert.equal(p, 'diff --git a/a.yml b/a.yml\n--- a/a.yml\n+++ b/a.yml\n@@ -1,2 +1,3 @@\n+new\n one\n two\n');
});

const prFile = 'on: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
const pushFile = 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
// Each pull request run still going when the next push to the branch starts one.
const prRuns = (n) => Array.from({ length: n }, (_, i) => run({ event: 'pull_request', sha: `p${i}`, branch: 'fix/a', at: i * 300, wall: 600 }));

test('the report carries one patch per outdated-runs finding, and says so under the finding', () => {
  const a = analyse('owner/repo', data({ workflows: [{ name: 'CI', runs: prRuns(6), file: prFile }] }));
  assert.equal(a.fixes.length, 1);
  assert.equal(a.fixes[0].workflow, 'CI');
  assert.equal(a.fixes[0].path, PATH);
  assert.match(a.fixes[0].patch, /\+  cancel-in-progress: true/);
  assert.match(report(a), /\*\*Patch:\*\* `--fix FILE` writes it for `\.github\/workflows\/ci\.yml`/);
  // A workflow the finding fires on that the patch cannot touch: the reason, in the report too.
  const reusable = 'on:\n  pull_request:\n  workflow_call:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  const b = analyse('owner/repo', data({ workflows: [{ name: 'CI', runs: prRuns(6), file: reusable }] }));
  assert.match(b.fixes[0].refused, /reusable workflow/);
  assert.match(report(b), /\*\*Patch:\*\* none for `\.github\/workflows\/ci\.yml`: a reusable workflow/);
  // No such finding (push runs, none outdated), no patch.
  const pushRuns = Array.from({ length: 6 }, (_, i) => run({ event: 'push', sha: `s${i}`, at: i * 3600, wall: 600 }));
  assert.deepEqual(analyse('owner/repo', data({ workflows: [{ name: 'CI', runs: pushRuns, file: pushFile }] })).fixes, []);
});

function cliIO() {
  const o = { out: '', err: '' };
  return { o, stdout: { write: (s) => (o.out += s) }, stderr: { write: (s) => (o.err += s) } };
}
const routes = (file) => fakeFetch({
  'repos/o/r/actions/runs?': { workflow_runs: prRuns(6).map((r) => ({ ...r, name: 'CI', path: PATH })) },
  'repos/o/r/actions/runs/': { jobs: [job({ steps: [['Set up job', 1], ['Run tests', 300], ['Complete job', 0]] })] },
  [`repos/o/r/contents/${PATH}`]: file,
  'repos/o/r/contents': [{ name: 'package.json' }],
});

test('cli --fix FILE writes the patches for git apply, or says there is none and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-wizard-cli-fix-'));
  const out = join(dir, 'ci.patch');
  const io = cliIO();
  assert.equal(await cli(['o/r', '--fix', out], { env: { GITHUB_TOKEN: 'x' }, ...io, fetchImpl: routes(prFile) }), 0);
  assert.match(io.o.err, /wrote 1 patch to .*ci\.patch \(\.github\/workflows\/ci\.yml\); check it, then `git apply /);
  const patch = readFileSync(out, 'utf8');
  assert.match(patch, /^diff --git a\/\.github\/workflows\/ci\.yml/);
  if (hasGit) assert.ok(applied(prFile, patch).includes(`group: ${CANCEL_GROUP}`));

  const none = join(dir, 'none.patch');
  const io2 = cliIO();
  assert.equal(await cli(['o/r', '--fix', none], { env: { GITHUB_TOKEN: 'x' }, ...io2, fetchImpl: routes(pushFile) }), 0);
  // The finding fires (the runs are pull request runs) but the file read has no pull request trigger.
  assert.match(io2.o.err, /no patch to write; .*none\.patch was not written$/m);
  assert.match(io2.o.err, /no patch for \.github\/workflows\/ci\.yml \(CI\): no pull request trigger/);
  assert.equal(existsSync(none), false);

  const j = cliIO();
  assert.equal(await cli(['o/r', '--json'], { env: { GITHUB_TOKEN: 'x' }, ...j, fetchImpl: routes(prFile) }), 0);
  assert.equal(JSON.parse(j.o.out).fixes[0].path, PATH);
});
