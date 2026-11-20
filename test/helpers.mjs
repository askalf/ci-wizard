// Synthetic fixtures: runs, jobs and workflow files shaped like the GitHub API's, built from a
// few parameters so each test states only what its rule looks at. No real repository's data.

export const BASE = Date.parse('2026-01-05T10:00:00Z');
export const t = (s) => new Date(BASE + s * 1000).toISOString().replace(/\.000Z$/, 'Z');

let nextId = 1000;

/** A workflow run. Times are seconds after BASE. */
export function run({ name = 'CI', event = 'push', sha, branch = 'main', conclusion = 'success', status = 'completed', at = 0, wall = 60, attempt = 1, path = '.github/workflows/ci.yml' } = {}) {
  const id = nextId++;
  return {
    id, name, event, head_sha: sha || `sha${id}`, head_branch: branch, conclusion, status, path,
    created_at: t(at), run_started_at: t(at), updated_at: t(at + wall), run_attempt: attempt,
  };
}

/** A job: steps as [name, seconds]; steps run back to back after `head` seconds, then `tail` seconds before the job completes. */
export function job({ steps = [['Set up job', 1], ['Run tests', 30], ['Complete job', 0]], wait = 2, head = 1, tail = 2, at = 0, selfHosted = false, runId = undefined } = {}) {
  const created = at;
  const started = at + wait;
  let cur = started + head;
  const st = steps.map(([name, d]) => {
    const s = { name, started_at: t(cur), completed_at: t(cur + d), conclusion: 'success' };
    cur += d;
    return s;
  });
  return {
    created_at: t(created), started_at: t(started), completed_at: t(cur + tail), conclusion: 'success',
    runner_name: selfHosted ? 'self-hosted-1' : 'GitHub Actions 12',
    labels: selfHosted ? ['self-hosted', 'Linux', 'X64'] : ['ubuntu-latest'],
    steps: st,
    ...(runId !== undefined ? { run_id: runId } : {}),
  };
}

/**
 * The collect() shape for analyse(). Each workflow: { name, path, runs, jobsPerRun, file }.
 * jobsPerRun defaults to one sampled run holding one default job.
 */
export function data({ workflows, coveredDays = 7, lockfiles = [] }) {
  const runs = [];
  const byWf = new Map();
  const samples = new Map();
  const files = new Map();
  for (const w of workflows) {
    const path = w.path || '.github/workflows/ci.yml';
    const rs = (w.runs || [run({ name: w.name, path })]).map((r) => ({ ...r, name: w.name, path }));
    runs.push(...rs);
    byWf.set(w.name, rs);
    samples.set(w.name, w.jobsPerRun || [[job()]]);
    if (w.file !== undefined) files.set(path, w.file);
  }
  return { runs, byWf, samples, coveredDays, since: t(-7 * 86400), files, lockfiles };
}

/** n runs of one workflow spread over the window, all with the given fields. */
export function runs(n, fields = {}) {
  return Array.from({ length: n }, (_, i) => run({ at: i * 600, ...fields }));
}

export const find = (a, what) => a.findings.filter((f) => f.what === what);

/** A fake fetch serving routes: { 'repos/o/r/actions/runs?...': body | (url) => body }, matched by path prefix. */
export function fakeFetch(routes, { remaining = 4000, calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    const path = url.replace('https://api.github.com/', '');
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => path.startsWith(k));
    const headers = { 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': '1767607200' };
    if (!key) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers });
    let body = routes[key];
    if (typeof body === 'function') body = body(path);
    if (body && body.__status) return new Response(JSON.stringify(body.json || {}), { status: body.__status, headers: { ...headers, ...(body.headers || {}) } });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers });
  };
}
