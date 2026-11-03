import { NotFoundError } from './github.mjs';

// Reads what an audit needs from GitHub, read-only: up to 500 workflow runs from the window, the
// jobs (with their steps) of the newest successful runs of the busiest workflows, those
// workflows' files, and the repository's root listing (to see which lockfiles it commits).

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock'];

/**
 * @param {ReturnType<import('./github.mjs').createClient>} client
 * @param {string} repo owner/name
 * @param {{ days?: number, perWorkflow?: number, workflows?: number, now?: Date, maxPages?: number }} [o]
 */
export async function collect(client, repo, { days = 7, perWorkflow = 5, workflows = 8, now = new Date(), maxPages = 5 } = {}) {
  const since = new Date(now.getTime() - days * 86400e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const runs = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await client.get(`repos/${repo}/actions/runs?per_page=100&page=${page}&created=${encodeURIComponent('>=' + since)}`);
    // GitHub answers 404 for a repository that does not exist and for one the token cannot see.
    if (!d) {
      if (page === 1) throw new NotFoundError(repo);
      break;
    }
    const batch = d.workflow_runs || [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  if (!runs.length) return null;
  const oldest = Math.min(...runs.map((r) => Date.parse(r.created_at)));
  const coveredDays = Math.max(0.25, (now.getTime() - oldest) / 86400e3);

  const byWf = new Map();
  for (const r of runs) {
    if (!byWf.has(r.name)) byWf.set(r.name, []);
    byWf.get(r.name).push(r);
  }
  // The busiest workflows, sampled from their newest successful completed runs.
  const top = [...byWf.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, workflows);
  const samples = new Map();
  for (const [wf, rs] of top) {
    const ok = rs.filter((r) => r.status === 'completed' && r.conclusion === 'success').slice(0, perWorkflow);
    const jobsPerRun = [];
    for (const r of ok) {
      const j = await client.get(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`);
      if (j) jobsPerRun.push((j.jobs || []).filter((x) => x.started_at && x.completed_at && x.conclusion !== 'skipped'));
    }
    samples.set(wf, jobsPerRun);
  }
  const files = new Map();
  for (const [, rs] of top) {
    const path = String(rs[0].path || '').split('@')[0];
    if (path.startsWith('.github/workflows/') && !files.has(path)) {
      files.set(path, (await client.getRaw(`repos/${repo}/contents/${path}`)) || '');
    }
  }
  const root = (await client.get(`repos/${repo}/contents/`)) || [];
  const names = new Set((Array.isArray(root) ? root : []).map((x) => x && x.name));
  const lockfiles = LOCKFILES.filter((f) => names.has(f)).sort();
  return { runs, byWf, samples, coveredDays, since, files, lockfiles };
}
