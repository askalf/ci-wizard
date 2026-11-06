import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, GitHubError, RateLimitError } from '../src/github.mjs';
import { collect } from '../src/collect.mjs';
import { fakeFetch, job, run, t } from './helpers.mjs';

const noWait = { backoffMs: [0, 0] };

test('client: sends the token as a bearer header and answers a 404 as null', async () => {
  const seen = [];
  const c = createClient({ token: 'tok', ...noWait, fetchImpl: async (url, o) => { seen.push(o.headers); return new Response('{}', { status: 404 }); } });
  assert.equal(await c.get('repos/o/r/x'), null);
  assert.equal(seen[0].Authorization, 'Bearer tok');
  assert.equal(c.calls, 1);
});

test('client: retries a 5xx twice, then succeeds', async () => {
  let n = 0;
  const c = createClient({ ...noWait, fetchImpl: async () => (++n < 3 ? new Response('', { status: 502 }) : new Response('{"ok":1}', { status: 200 })) });
  assert.deepEqual(await c.get('x'), { ok: 1 });
  assert.equal(n, 3);
});

test('client: a 5xx after the retries is an error that names the status', async () => {
  const c = createClient({ ...noWait, fetchImpl: async () => new Response('{"message":"boom"}', { status: 503 }) });
  await assert.rejects(c.get('repos/o/r'), (e) => e instanceof GitHubError && e.status === 503 && /boom/.test(e.message));
});

test('client: stops before the rate limit runs out and says how many calls were left', async () => {
  const c = createClient({ minRemaining: 25, fetchImpl: async () => new Response('{}', { status: 200, headers: { 'x-ratelimit-remaining': '10' } }) });
  await c.get('a');
  await assert.rejects(c.get('b'), (e) => e instanceof RateLimitError && /10 calls left/.test(e.message));
  assert.equal(c.calls, 1, 'the second call never went out');
});

test('client: a 403 with no calls left is a rate-limit stop, not a generic error', async () => {
  const c = createClient({ fetchImpl: async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767607200' } }) });
  await assert.rejects(c.get('a'), (e) => e instanceof RateLimitError && /resets at 2026-01-05/.test(e.message));
});

test('collect: pages until a short page, samples the busiest workflows, reads their files and the lockfiles', async () => {
  const ci = Array.from({ length: 100 }, (_, i) => ({ ...run({ name: 'CI', at: i * 60 }), path: '.github/workflows/ci.yml' }));
  const lint = [{ ...run({ name: 'Lint', at: 5 }), path: '.github/workflows/lint.yml@refs/heads/main' }];
  const calls = [];
  const fetchImpl = fakeFetch({
    'repos/o/r/actions/runs?per_page=100&page=1': { workflow_runs: ci },
    'repos/o/r/actions/runs?per_page=100&page=2': { workflow_runs: lint },
    'repos/o/r/actions/runs/': { jobs: [job(), { ...job(), conclusion: 'skipped' }] },
    'repos/o/r/contents/.github/workflows/ci.yml': 'on: push\n',
    'repos/o/r/contents/.github/workflows/lint.yml': 'on: pull_request\n',
    'repos/o/r/contents': [{ name: 'package.json' }, { name: 'package-lock.json' }],
  }, { calls });
  const c = createClient({ fetchImpl });
  const d = await collect(c, 'o/r', { workflows: 2, perWorkflow: 2, now: new Date(Date.parse(t(7 * 86400))) });
  assert.equal(d.runs.length, 101);
  assert.deepEqual([...d.samples.keys()], ['CI', 'Lint']);
  assert.equal(d.samples.get('CI').length, 2, 'two newest successful runs sampled');
  assert.equal(d.samples.get('CI')[0].length, 1, 'skipped jobs dropped');
  assert.equal(d.files.get('.github/workflows/lint.yml'), 'on: pull_request\n', 'the @ref suffix is stripped from the path');
  assert.deepEqual(d.lockfiles, ['package-lock.json']);
  assert.ok(calls[0].includes('created=%3E%3D'), 'the date filter is encoded');
});

test('collect: no runs in the window is null', async () => {
  const c = createClient({ fetchImpl: fakeFetch({ 'repos/o/r/actions/runs': { workflow_runs: [] } }) });
  assert.equal(await collect(c, 'o/r'), null);
});
