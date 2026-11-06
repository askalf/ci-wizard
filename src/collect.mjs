import { NotFoundError } from './github.mjs';

// Reads what an audit needs from GitHub, read-only: up to 500 workflow runs from the window, the
// jobs (with their steps) of the newest successful runs of the busiest workflows, those
// workflows' files, and the repository's root listing (to see which lockfiles it commits).

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock'];

/**
 * Runs grouped by workflow, labelled by name. A run's `name` is not a stable key: the runs a pull
 * request makes for a workflow it adds (or changes so it fails to load) can carry the pull
 * request's title instead, which split one workflow into two rows. So runs group by workflow_id
 * (then the file path, then the name), and each group is labelled with the name most of its runs
 * carry, ties going to the newest run's. Two workflows that share a name get their path appended.
 * @returns {Map<string, object[]>} label -> runs, newest first as the API lists them
 */
export function groupRuns(runs) {
  const groups = new Map();
  for (const r of runs) {
    const key = r.workflow_id != null ? `id:${r.workflow_id}` : r.path ? `path:${String(r.path).split('@')[0]}` : `name:${r.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const labelled = [...groups.values()].map((rs) => {
    const counts = new Map();
    for (const r of rs) counts.set(r.name, (counts.get(r.name) || 0) + 1);
    const best = Math.max(...counts.values());
    // rs is newest first, so the first run with the top count names the group on a tie.
    const name = String(rs.find((r) => counts.get(r.name) === best).name);
    return { name, path: String(rs[0].path || '').split('@')[0], rs };
  });
  const taken = new Map();
  for (const g of labelled) taken.set(g.name, (taken.get(g.name) || 0) + 1);
  const out = new Map();
  for (const g of labelled) out.set(taken.get(g.name) > 1 && g.path ? `${g.name} (${g.path})` : g.name, g.rs);
  return out;
}

/**
 * @param {ReturnType<import('./github.mjs').createClient>} client
 * @param {string} repo owner/name
 * @param {{ days?: number, perWorkflow?: number, perOutcome?: number, workflows?: number, only?: string[], now?: Date, maxPages?: number, onProgress?: (msg: string) => void }} [o]
 */
export async function collect(client, repo, { days = 7, perWorkflow = 5, perOutcome = 2, workflows = 8, only = [], now = new Date(), maxPages = 5, onProgress = () => {} } = {}) {
  const since = new Date(now.getTime() - days * 86400e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const runs = [];
  let truncated = false;
  onProgress('reading workflow runs');
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
    if (page === maxPages) truncated = true;
  }
  if (!runs.length) return null;
  // When every run of the window was read, the window is the one asked for: a repository that ran
  // nothing for the first five days of seven still ran that much in a week. Only a window cut short
  // by the run cap covers less, from its oldest run to now.
  const oldest = Math.min(...runs.map((r) => Date.parse(r.created_at)));
  const coveredDays = truncated ? Math.max(0.25, (now.getTime() - oldest) / 86400e3) : days;

  const byWf = groupRuns(runs);
  // The busiest workflows, sampled from their newest successful completed runs.
  // With `only`, the named workflows (matched by name, ignoring case) instead of the busiest.
  const wanted = only.map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  const ranked = [...byWf.entries()].sort((a, b) => b[1].length - a[1].length);
  // A name matches a workflow by the name its runs carry, which is what GitHub shows, not by the
  // report's label: two workflows both named Build are labelled with their paths, and --only Build
  // selects both of them.
  const namesOf = (label, rs) => new Set([String(label).toLowerCase(), ...rs.map((r) => String(r.name).toLowerCase())]);
  const matches = (label, rs, n) => namesOf(label, rs).has(String(n).trim().toLowerCase());
  const top = wanted.length ? ranked.filter(([label, rs]) => wanted.some((n) => matches(label, rs, n))) : ranked.slice(0, workflows);
  const onlyMissing = wanted.length ? only.filter((n) => String(n).trim() && !ranked.some(([label, rs]) => matches(label, rs, n))) : [];
  const samples = new Map();
  // Runs that did not succeed cost job time too, and not the same as a success: a failure often
  // stops early, a timeout runs to its limit. A few of each are timed apart, so the weekly cost
  // counts every outcome at its own measured cost (OUTCOMES in analyse.mjs).
  const outcomeSamples = new Map();
  const jobsOf = async (r) => {
    const j = await client.get(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`);
    return j ? (j.jobs || []).filter((x) => x.started_at && x.completed_at && x.conclusion !== 'skipped') : null;
  };
  let n = 0;
  for (const [wf, rs] of top) {
    onProgress(`timing ${wf} (${++n}/${top.length})`);
    const ok = rs.filter((r) => r.status === 'completed' && r.conclusion === 'success').slice(0, perWorkflow);
    const jobsPerRun = [];
    for (const r of ok) {
      const jobs = await jobsOf(r);
      if (jobs) jobsPerRun.push(jobs);
    }
    samples.set(wf, jobsPerRun);
    const byOutcome = {};
    for (const outcome of ['failure', 'cancelled', 'timed_out']) {
      const picked = rs.filter((r) => r.status === 'completed' && r.conclusion === outcome).slice(0, perOutcome);
      for (const r of picked) {
        const jobs = await jobsOf(r);
        if (jobs) (byOutcome[outcome] ||= []).push(jobs);
      }
    }
    outcomeSamples.set(wf, byOutcome);
  }
  onProgress('reading workflow files');
  const files = new Map();
  for (const [, rs] of top) {
    const path = String(rs[0].path || '').split('@')[0];
    if (path.startsWith('.github/workflows/') && !files.has(path)) {
      files.set(path, (await client.getRaw(`repos/${repo}/contents/${path}`)) || '');
    }
  }
  // The default branch, for advice that names it (a push trigger limited to it). Unknown when the
  // token cannot read the repository's metadata; the advice then says to fill it in.
  const meta = await client.get(`repos/${repo}`);
  const defaultBranch = meta && typeof meta.default_branch === 'string' ? meta.default_branch : null;
  // Standard GitHub-hosted runners are free for public repositories, so billed minutes only cost
  // money on a private or internal one. Null when the metadata cannot be read.
  const visibility = meta && typeof meta.visibility === 'string' ? meta.visibility : meta && typeof meta.private === 'boolean' ? (meta.private ? 'private' : 'public') : null;
  const root = (await client.get(`repos/${repo}/contents/`)) || [];
  const names = new Set((Array.isArray(root) ? root : []).map((x) => x && x.name));
  const lockfiles = LOCKFILES.filter((f) => names.has(f)).sort();
  return { runs, byWf, samples, outcomeSamples, coveredDays, truncated, since, files, lockfiles, defaultBranch, visibility, only: wanted.length ? only : [], onlyMissing };
}
