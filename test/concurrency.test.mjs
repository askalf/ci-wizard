// Requests in flight together: at most a few at once, the 25-call reserve still kept, out-of-order
// answers never raising the count, and the collected data the same whatever order answers arrive in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, RateLimitError } from '../src/github.mjs';
import { collect } from '../src/collect.mjs';
import { fakeFetch, job, runs, t } from './helpers.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const answer = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers });

test('the client keeps at most `concurrency` requests in flight', async () => {
  let now = 0;
  let peak = 0;
  const client = createClient({ concurrency: 3, fetchImpl: async () => {
    now++; peak = Math.max(peak, now);
    await delay(5);
    now--;
    return answer({});
  } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => client.get(`x/${i}`)));
  assert.equal(peak, 3);
  assert.equal(client.calls, 20);
});

test('requests in flight count against the reserve, so concurrency never spends it', async () => {
  // 30 left, reserve 25: five calls may be spent, however many are asked for at once.
  let sent = 0;
  let left = 30;
  const client = createClient({ concurrency: 6, fetchImpl: async () => {
    sent++;
    await delay(5);
    left--;
    return answer({}, { 'x-ratelimit-remaining': String(left), 'x-ratelimit-reset': '2000000000' });
  } });
  await client.get('first'); // learns the count: 29 left
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => client.get(`x/${i}`)));
  assert.equal(sent, 1 + 4, `sent ${sent}`);
  assert.ok(left >= 25, `left ${left}`);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof RateLimitError));
});

test('an answer that arrives late with an older, higher count does not raise it; a new hour does', async () => {
  const queue = [
    { left: '100', reset: '2000000000', wait: 20 }, // sent first, answered last
    { left: '90', reset: '2000000000', wait: 1 },
  ];
  const client = createClient({ fetchImpl: async () => {
    const a = queue.shift();
    await delay(a.wait);
    return answer({}, { 'x-ratelimit-remaining': a.left, 'x-ratelimit-reset': a.reset });
  } });
  await Promise.all([client.get('a'), client.get('b')]);
  assert.equal(client.remaining, 90);
  queue.push({ left: '4999', reset: '2000003600', wait: 0 });
  await client.get('c');
  assert.equal(client.remaining, 4999);
});

test('collect reads the run pages after the first together, counts a run that moved pages once, and keeps order', async () => {
  const now = new Date(Date.parse(t(7 * 86400)));
  const all = runs(250);
  const asked = [];
  const routes = {
    'repos/o/r/actions/runs?': (path) => {
      const page = Number(/[?&]page=(\d+)/.exec(path)[1]);
      const slice = all.slice((page - 1) * 100, page * 100);
      // Page 3 also repeats the last run of page 2, as when a new run pushes the list down.
      return { total_count: 250, workflow_runs: page === 3 ? [all[199], ...slice] : slice };
    },
    'repos/o/r/actions/runs/': { jobs: [job()] },
    'repos/o/r/contents': [],
  };
  const d = await collect(createClient({ fetchImpl: fakeFetch(routes, { calls: asked }) }), 'o/r', { now });
  assert.equal(d.runs.length, 250);
  assert.equal(new Set(d.runs.map((r) => r.id)).size, 250);
  assert.equal(asked.filter((u) => u.includes('actions/runs?')).length, 3);
  assert.equal(d.truncated, false);
  // The same data as one at a time.
  const serial = await collect(createClient({ concurrency: 1, fetchImpl: fakeFetch(routes) }), 'o/r', { now });
  assert.deepEqual([...d.byWf.keys()], [...serial.byWf.keys()]);
  assert.deepEqual([...d.samples.entries()], [...serial.samples.entries()]);
});

test('collect: a window with more runs than the cap is truncated from the count', async () => {
  const now = new Date(Date.parse(t(7 * 86400)));
  const all = runs(300);
  const routes = {
    'repos/o/r/actions/runs?': (path) => {
      const page = Number(/[?&]page=(\d+)/.exec(path)[1]);
      return { total_count: 900, workflow_runs: all.slice(((page - 1) % 3) * 100, ((page - 1) % 3 + 1) * 100) };
    },
    'repos/o/r/actions/runs/': { jobs: [job()] },
    'repos/o/r/contents': [],
  };
  const d = await collect(createClient({ fetchImpl: fakeFetch(routes) }), 'o/r', { now, maxPages: 3 });
  assert.equal(d.truncated, true);
});
