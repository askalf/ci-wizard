// --max-runs / audit({ maxRuns }): how many workflow runs an audit reads from its window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, MAX_RUNS_DEFAULT, MAX_RUNS_LIMIT } from '../src/index.mjs';
import { collect } from '../src/collect.mjs';
import { createClient } from '../src/github.mjs';
import { main as cli } from '../src/cli.mjs';
import { fakeFetch, run, t } from './helpers.mjs';

const now = new Date(Date.parse(t(7 * 86400)));

// A window holding `total` runs a minute apart up to `now`, served newest first as the API does, 100 a
// page with distinct ids; the page asked for is recorded.
function windowOf(total) {
  const pagesAsked = [];
  const end = 7 * 86400;
  const routes = {
    'repos/o/r/actions/runs?': (path) => {
      const page = Number(new URL(`https://x/${path}`).searchParams.get('page'));
      pagesAsked.push(page);
      const from = (page - 1) * 100;
      const n = Math.max(0, Math.min(100, total - from));
      return { total_count: total, workflow_runs: Array.from({ length: n }, (_, i) => run({ name: 'CI', at: end - (from + i + 1) * 60 })) };
    },
  };
  return { fetchImpl: fakeFetch(routes), pagesAsked };
}

test('the default reads 500 runs: 5 pages', async () => {
  assert.equal(MAX_RUNS_DEFAULT, 500);
  const w = windowOf(2000);
  await audit({ repo: 'o/r', token: 'x', fetchImpl: w.fetchImpl, now }).catch(() => {});
  assert.deepEqual([...new Set(w.pagesAsked)].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('maxRuns 1000 reads 10 pages, and no more than the window holds', async () => {
  const big = windowOf(2000);
  await audit({ repo: 'o/r', token: 'x', fetchImpl: big.fetchImpl, now, maxRuns: MAX_RUNS_LIMIT }).catch(() => {});
  assert.deepEqual([...new Set(big.pagesAsked)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const small = windowOf(250);
  await audit({ repo: 'o/r', token: 'x', fetchImpl: small.fetchImpl, now, maxRuns: 1000 }).catch(() => {});
  assert.deepEqual([...new Set(small.pagesAsked)].sort((a, b) => a - b), [1, 2, 3]);
});

test('collect never asks past the 10th page, whatever it is given', async () => {
  const w = windowOf(5000);
  await collect(createClient({ fetchImpl: w.fetchImpl }), 'o/r', { now, maxPages: 40 }).catch(() => {});
  assert.equal(Math.max(...w.pagesAsked), 10);
});

test('a page limit that is not a finite number reads one page, and says the window was cut short', async () => {
  for (const bad of [NaN, 'x', Infinity, -3]) {
    const w = windowOf(300);
    const d = await collect(createClient({ fetchImpl: w.fetchImpl }), 'o/r', { now, maxPages: bad });
    assert.deepEqual([...new Set(w.pagesAsked)], [1], String(bad));
    assert.equal(d.runs.length, 100, String(bad));
    assert.equal(d.truncated, true, `${bad}: 300 runs in the window, 100 read`);
    assert.ok(d.coveredDays < 7, `${bad}: coverage from the runs read, not the days asked`);
  }
});

test('audit refuses a maxRuns that is not a multiple of 100 from 100 to 1000', async () => {
  for (const bad of [0, 50, 150, 1100, 500.5]) {
    await assert.rejects(audit({ repo: 'o/r', token: 'x', fetchImpl: fakeFetch({}), maxRuns: bad }), /maxRuns must be a multiple of 100 from 100 to 1000/);
  }
});

test('--max-runs: a bad value exits 2 with the reason, before any API call', async () => {
  for (const bad of ['250', '0', '1100', 'many']) {
    let err = '';
    const calls = [];
    const code = await cli(['o/r', '--max-runs', bad], { env: { GITHUB_TOKEN: 'x' }, stdout: { write() {} }, stderr: { write: (s) => (err += s) }, fetchImpl: fakeFetch({}, { calls }) });
    assert.equal(code, 2, `${bad}: ${err}`);
    assert.match(err, /--max-runs must be/);
    assert.equal(calls.length, 0);
  }
});

test('--max-runs 1000 reaches the collector', async () => {
  const w = windowOf(1500);
  await cli(['o/r', '--max-runs', '1000', '--json'], { env: { GITHUB_TOKEN: 'x' }, stdout: { write() {} }, stderr: { write() {} }, fetchImpl: w.fetchImpl });
  assert.equal(Math.max(...w.pagesAsked), 10);
});
