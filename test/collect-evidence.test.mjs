// collect reads the newest successful run's record for the two rules that would remove a step,
// and only where the sampled workflow's file raises a candidate: the matched jobs' logs (the
// redirect, then the file from its host), the run's artifact listing, and each candidate
// artifact's zip. A record that cannot be read, or is too large, is left off; logs: false and
// artifacts: false ask for none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../src/collect.mjs';
import { createClient } from '../src/github.mjs';
import { fakeFetch, job, run, t } from './helpers.mjs';
import { storedZip } from './zip-helper.mjs';

const FILE = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm test
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
  analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
      - uses: actions/upload-artifact@v4
        with:
          name: SARIF file
          path: results.sarif
`;
const LOG = '2026-11-08T04:50:38Z ##[group]Run npm test\n2026-11-08T04:50:39Z ok 1 - a\n2026-11-08T04:50:39Z # tests 1\n2026-11-08T04:50:40Z ##[group]Run npm test\n2026-11-08T04:50:41Z ok 1 - a\n2026-11-08T04:50:41Z # tests 1\n';

function setup({ zipBytes = storedZip([{ name: 'results.sarif', data: 'sarif' }]), zipLength = null, artifactTotal = 3 } = {}) {
  const now = new Date(Date.parse(t(7 * 86400)));
  const newest = run({ at: 7200, conclusion: 'success' });
  const older = run({ at: 3600, conclusion: 'success' });
  const jobsOf = {
    [newest.id]: [
      { ...job(), id: 11, name: 'test', run_id: newest.id },
      { ...job(), id: 12, name: 'lint', run_id: newest.id },
      { ...job(), id: 13, name: 'analysis', run_id: newest.id },
    ],
    [older.id]: [{ ...job(), id: 21, name: 'test', run_id: older.id }],
  };
  const asked = [];
  const routes = {
    'repos/o/r/actions/runs?': { total_count: 2, workflow_runs: [newest, older] },
    'repos/o/r/actions/runs/': (path) => {
      if (/\/artifacts/.test(path)) {
        return { total_count: artifactTotal, artifacts: [
          { id: 901, name: 'SARIF file', size_in_bytes: 16334, expired: false },
          { id: 902, name: 'coverage', size_in_bytes: 5, expired: false },
          { id: 903, name: 'SARIF file', size_in_bytes: 1, expired: true },
        ] };
      }
      return { total_count: 1, jobs: jobsOf[/runs\/(\d+)\/jobs/.exec(path)[1]] || [] };
    },
    'repos/o/r/actions/jobs/': (path) => ({ __status: 302, headers: { location: `https://blobs.example/logs/${/jobs\/(\d+)\/logs/.exec(path)[1]}` } }),
    'repos/o/r/actions/artifacts/': (path) => ({ __status: 302, headers: { location: `https://blobs.example/zip/${/artifacts\/(\d+)\/zip/.exec(path)[1]}` } }),
    'repos/o/r/contents/.github/workflows/ci.yml': FILE,
    'repos/o/r/contents': [],
  };
  const api = fakeFetch(routes, { calls: asked });
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://blobs.example/')) {
      const method = (init && init.method) || 'GET';
      asked.push(`${method} ${url}`);
      if (url.includes('/logs/')) return method === 'HEAD' ? new Response(null, { status: 200, headers: { 'content-length': '471642' } }) : new Response(LOG, { status: 200 });
      const headers = zipLength !== null ? { 'content-length': String(zipLength) } : {};
      return new Response(zipBytes, { status: 200, headers });
    }
    return api(url, init);
  };
  return { now, asked, fetchImpl, newest };
}

test('collect: the logs of the jobs a repeat names in the newest successful run, and of no other job; the artifact listing once and the candidate artifact\'s zip only', async () => {
  const { now, asked, fetchImpl, newest } = setup();
  const d = await collect(createClient({ fetchImpl }), 'o/r', { now });
  const gets = asked.filter((u) => u.startsWith('GET https://blobs.example/'));
  assert.deepEqual(gets.sort(), ['GET https://blobs.example/logs/11', 'GET https://blobs.example/zip/901'], 'job test\'s log (the candidate), not lint\'s nor analysis\'s; the live SARIF artifact, not coverage nor the expired copy');
  // The redirect for job 11's log is asked twice (the size, then the file), lint's and analysis's once each.
  assert.equal(asked.filter((u) => /actions\/jobs\/11\/logs/.test(u)).length, 2);
  assert.equal(asked.filter((u) => /actions\/jobs\/12\/logs/.test(u)).length, 1);
  assert.equal(asked.filter((u) => /actions\/runs\/\d+\/artifacts/.test(u)).length, 1);
  assert.ok(asked.some((u) => u.includes(`actions/runs/${newest.id}/artifacts`)), 'the newest successful run\'s artifacts');
  const [sampled] = d.samples.values();
  const [newestJobs, olderJobs] = sampled;
  assert.equal(newestJobs.find((j) => j.id === 11).log_text, LOG);
  assert.equal(newestJobs.find((j) => j.id === 12).log_text, undefined);
  assert.equal(olderJobs.find((j) => j.id === 21).log_text, undefined, 'only the newest run\'s record');
  assert.deepEqual(newestJobs[0].run_artifacts, [{ name: 'SARIF file', bytes: 16334, entries: [{ name: 'results.sarif', size: 5 }] }]);
  assert.equal(olderJobs[0].run_artifacts, undefined);
});

test('collect: logs: false reads no log, artifacts: false reads no artifact; a zip past the cap, or one that is not a zip, leaves the entries unknown', async () => {
  const a = setup();
  await collect(createClient({ fetchImpl: a.fetchImpl }), 'o/r', { now: a.now, logs: false });
  assert.equal(a.asked.filter((u) => /\/logs/.test(u) || u.startsWith('HEAD ') || u.startsWith('GET https://blobs.example/logs')).length, 0);
  assert.ok(a.asked.some((u) => u.startsWith('GET https://blobs.example/zip/')), 'artifacts still read');
  const b = setup();
  await collect(createClient({ fetchImpl: b.fetchImpl }), 'o/r', { now: b.now, artifacts: false });
  assert.equal(b.asked.filter((u) => /artifacts/.test(u)).length, 0);
  assert.ok(b.asked.some((u) => u === 'GET https://blobs.example/logs/11'), 'logs still read');
  const big = setup({ zipLength: 9 * 1048576 });
  const d = await collect(createClient({ fetchImpl: big.fetchImpl }), 'o/r', { now: big.now });
  const [sampled] = d.samples.values();
  assert.deepEqual(sampled[0][0].run_artifacts, [{ name: 'SARIF file', bytes: 16334, entries: null }]);
  const text = setup({ zipBytes: 'not a zip' });
  const e = await collect(createClient({ fetchImpl: text.fetchImpl }), 'o/r', { now: text.now });
  assert.deepEqual([...e.samples.values()][0][0][0].run_artifacts[0].entries, null);
});

test('collect: a listing with more artifacts than the page read may hold a second artifact of the name on another page, so no record is kept and no zip is read', async () => {
  const paged = setup({ artifactTotal: 101 });
  const d = await collect(createClient({ fetchImpl: paged.fetchImpl }), 'o/r', { now: paged.now });
  assert.equal(paged.asked.filter((u) => u.startsWith('GET https://blobs.example/zip/')).length, 0);
  const [sampled] = d.samples.values();
  assert.equal(sampled[0][0].run_artifacts, undefined);
});
