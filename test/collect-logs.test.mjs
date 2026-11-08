// collect reads log sizes for the jobs of each sampled workflow's newest successful run only, puts
// each size on its own job, leaves a job whose size cannot be read without one, and with
// logs: false asks for none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../src/collect.mjs';
import { createClient } from '../src/github.mjs';
import { fakeFetch, job, run, t } from './helpers.mjs';

function setup() {
  const now = new Date(Date.parse(t(7 * 86400)));
  // Newest first, as the API lists them: a success, an older success, a failure.
  const newest = run({ at: 7200, conclusion: 'success' });
  const older = run({ at: 3600, conclusion: 'success' });
  const failed = run({ at: 1800, conclusion: 'failure' });
  const jobsOf = {
    [newest.id]: [{ ...job(), id: 11, name: 'test' }, { ...job(), id: 12, name: 'lint' }],
    [older.id]: [{ ...job(), id: 21, name: 'test' }],
    [failed.id]: [{ ...job(), id: 31, name: 'test', conclusion: 'failure' }],
  };
  const asked = [];
  const routes = {
    'repos/o/r/actions/runs?': { total_count: 3, workflow_runs: [newest, older, failed] },
    'repos/o/r/actions/runs/': (path) => ({ total_count: 1, jobs: jobsOf[/runs\/(\d+)\/jobs/.exec(path)[1]] || [] }),
    // The job-logs endpoint answers with a redirect to the file; job 12's file has no size.
    'repos/o/r/actions/jobs/': (path) => ({ __status: 302, headers: { location: `https://blobs.example/logs/${/jobs\/(\d+)\/logs/.exec(path)[1]}` } }),
    'repos/o/r/contents': [],
  };
  const api = fakeFetch(routes, { calls: asked });
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://blobs.example/logs/')) {
      asked.push(`HEAD ${url}`);
      return url.endsWith('/11') ? new Response(null, { status: 200, headers: { 'content-length': '471642' } }) : new Response(null, { status: 404 });
    }
    return api(url, init);
  };
  return { now, asked, fetchImpl, ids: { newest: newest.id, older: older.id, failed: failed.id } };
}

test('collect: log sizes for the newest successful run\'s jobs only, each on its own job, none for a size that cannot be read', async () => {
  const { now, asked, fetchImpl } = setup();
  const d = await collect(createClient({ fetchImpl }), 'o/r', { now });
  const logs = asked.filter((u) => /actions\/jobs\/\d+\/logs/.test(u)).map((u) => Number(/jobs\/(\d+)\/logs/.exec(u)[1])).sort();
  assert.deepEqual(logs, [11, 12], 'the newest successful run\'s two jobs, not the older run\'s nor the failed run\'s');
  assert.deepEqual(asked.filter((u) => u.startsWith('HEAD ')).sort(), ['HEAD https://blobs.example/logs/11', 'HEAD https://blobs.example/logs/12']);
  const [sampled] = d.samples.values();
  const [newestJobs, olderJobs] = sampled;
  assert.equal(newestJobs.find((j) => j.id === 11).log_bytes, 471642);
  assert.equal(newestJobs.find((j) => j.id === 12).log_bytes, undefined, 'no size is no size, not an empty log');
  assert.equal(olderJobs.find((j) => j.id === 21).log_bytes, undefined);
});

test('collect: logs: false asks for no log at all', async () => {
  const { now, asked, fetchImpl } = setup();
  const d = await collect(createClient({ fetchImpl }), 'o/r', { now, logs: false });
  assert.equal(asked.filter((u) => /\/logs/.test(u) || u.startsWith('HEAD ')).length, 0);
  const [sampled] = d.samples.values();
  assert.ok(sampled[0].every((j) => j.log_bytes === undefined));
});
