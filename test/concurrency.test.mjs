// Requests in flight together: at most a few at once, the 25-call reserve still kept, out-of-order
// answers never raising the count, and the collected data the same whatever order answers arrive in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, RateLimitError } from '../src/github.mjs';
import { collect } from '../src/collect.mjs';
import { fakeFetch, job, runs, t } from './helpers.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const answer = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers });

test('concurrency must be a whole number of 1 or more', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, '6']) assert.throws(() => createClient({ concurrency: bad }), /concurrency must be a whole number/, String(bad));
  assert.doesNotThrow(() => createClient({ concurrency: 1 }));
});

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
  // Each response is held until the test releases it, so the order of answers is exact.
  const gates = [];
  const client = createClient({ fetchImpl: (url) => new Promise((resolve) => {
    gates.push({ url, open: (left, reset = '2000000000') => resolve(answer({}, { 'x-ratelimit-remaining': left, 'x-ratelimit-reset': reset })) });
  }) });
  const until = async (n) => { while (gates.length < n) await delay(1); };
  // The probe: the budget becomes known (200), and requests may go out together.
  const probe = client.get('probe');
  await until(1);
  gates[0].open('200');
  await probe;
  // Two requests in the same hour: the one sent first (100) is answered after the one sent second (90).
  const a = client.get('a');
  const b = client.get('b');
  await until(3);
  gates[2].open('90');
  await b;
  assert.equal(client.remaining, 90);
  gates[1].open('100');
  await a;
  assert.equal(client.remaining, 90, 'the late, higher count does not raise it');
  // A new hour raises it.
  const c = client.get('c');
  await until(4);
  gates[3].open('4999', '2000003600');
  await c;
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

test('a fresh client sends one request until it knows the budget, so a cold start keeps the reserve', async () => {
  let sent = 0;
  let left = 30;
  let concurrent = 0;
  let peak = 0;
  const client = createClient({ concurrency: 6, fetchImpl: async () => {
    sent++; concurrent++; peak = Math.max(peak, concurrent);
    await delay(5);
    concurrent--; left--;
    return answer({}, { 'x-ratelimit-remaining': String(left), 'x-ratelimit-reset': '2000000000' });
  } });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => client.get(`x/${i}`)));
  assert.ok(left >= 25, `left ${left}`);
  assert.equal(sent, 5);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof RateLimitError));
  // Once the budget is known, requests go out together again.
  const roomy = createClient({ concurrency: 4, fetchImpl: async () => {
    concurrent++; peak = Math.max(peak, concurrent);
    await delay(5);
    concurrent--;
    return answer({}, { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '2000000000' });
  } });
  peak = 0;
  await Promise.all(Array.from({ length: 12 }, (_, i) => roomy.get(`y/${i}`)));
  assert.equal(peak, 4);
});

test("a late answer from an hour that has reset does not lower the new hour's budget", async () => {
  // The client already knows the old hour (27 left: room for two more above the reserve). Two
  // requests straddle the reset: the new hour's answer (4999) comes first, the old hour's (26) after.
  const queue = [{ left: '27', reset: '2000000000', wait: 0 }];
  const client = createClient({ fetchImpl: async () => {
    const a = queue.shift() || { left: '4998', reset: '2000003600', wait: 0 };
    await delay(a.wait);
    return answer({}, { 'x-ratelimit-remaining': a.left, 'x-ratelimit-reset': a.reset });
  } });
  await client.get('probe');
  assert.equal(client.remaining, 27);
  queue.push({ left: '26', reset: '2000000000', wait: 30 }, { left: '4999', reset: '2000003600', wait: 1 });
  await Promise.all([client.get('a'), client.get('b')]);
  assert.equal(client.remaining, 4999);
  // Another request can go, and its count stands.
  await client.get('c');
  assert.equal(client.remaining, 4998);
});
