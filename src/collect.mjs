import { NotFoundError, RateLimitError } from './github.mjs';

// Reads what an audit needs from GitHub, read-only: up to 500 workflow runs from the window, the
// jobs (with their steps) of the newest successful runs of the busiest workflows, those
// workflows' files, and the repository's root listing (to see which lockfiles it commits).

// Each segment of a file path percent-encoded: a name with ? or # would otherwise change which
// file, or which ref, the contents API reads.
const encodePath = (path) => String(path).split('/').map(encodeURIComponent).join('/');

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock'];

/**
 * Runs grouped by workflow, labelled by name. A run's `name` is not a stable key: a workflow with
 * `run-name:` names each run after its pull request or commit, and the runs a pull request makes for
 * a workflow it adds (or changes so it fails to load) carry the pull request's title. So runs group
 * by workflow_id (then the file path, then the name), and each group is labelled with the
 * workflow's own name from the workflows API where it is known (`names`, workflow_id -> name), else
 * the name most of its runs carry, ties going to the newest run's. Two workflows that share a name
 * get their path appended.
 * @param {object[]} runs
 * @param {Map<number, string>} [names] each workflow's name, by id, from GET /actions/workflows
 * @returns {Map<string, object[]>} label -> runs, newest first as the API lists them
 */
export function groupRuns(runs, names = new Map()) {
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
    const known = rs[0].workflow_id != null ? names.get(rs[0].workflow_id) : undefined;
    const name = typeof known === 'string' && known ? known : String(rs.find((r) => counts.get(r.name) === best).name);
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
export async function collect(client, repo, { days = 7, perWorkflow = 5, perOutcome = 2, workflows = 8, only = [], now = new Date(), maxPages = 5, maxScanFiles = 30, onProgress = () => {} } = {}) {
  const since = new Date(now.getTime() - days * 86400e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const runs = [];
  let truncated = false;
  onProgress('reading workflow runs');
  const runsPage = (page) => client.get(`repos/${repo}/actions/runs?per_page=100&page=${page}&created=${encodeURIComponent('>=' + since)}`);
  const first = await runsPage(1);
  // GitHub answers 404 for a repository that does not exist and for one the token cannot see.
  if (!first) throw new NotFoundError(repo);
  runs.push(...(first.workflow_runs || []));
  // No run in the window: nothing to measure, and nothing more is read.
  if (!runs.length) return null;
  const total = Number.isFinite(first.total_count) ? first.total_count : null;
  // The repository exists and can be read: the requests that depend on nothing else start now,
  // beside the remaining run pages. A failed one is settled here and read later, so its rejection
  // waits for its turn (and a rate-limit stop there still stops the audit then).
  const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
  const settled = async (p) => { const r = await p; if (r.error) throw r.error; return r.value; };
  const early = {
    listing: settle(client.get(`repos/${repo}/contents/.github/workflows`)),
    meta: settle(client.get(`repos/${repo}`)),
    root: settle(client.get(`repos/${repo}/contents`)),
    workflows: settle(client.get(`repos/${repo}/actions/workflows?per_page=100&page=1`)),
  };
  if ((first.workflow_runs || []).length === 100 && maxPages > 1) {
    if (total !== null) {
      // The first page says how many runs the window holds: the rest of the pages, up to the cap,
      // are read together.
      const pages = Math.min(maxPages, Math.ceil(total / 100));
      const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => runsPage(i + 2)));
      for (const d of rest) if (d) runs.push(...(d.workflow_runs || []));
      truncated = total > maxPages * 100;
    } else {
      // No count: page by page until a short page or the cap, as before.
      for (let page = 2; page <= maxPages; page++) {
        const d = await runsPage(page);
        if (!d) break;
        const batch = d.workflow_runs || [];
        runs.push(...batch);
        if (batch.length < 100) break;
        if (page === maxPages) truncated = true;
      }
    }
  } else if ((first.workflow_runs || []).length === 100 && maxPages === 1) {
    truncated = total === null || total > 100;
  }
  // A run that moved between pages while they were read (a newer one pushed it down) is counted once.
  const seenRuns = new Set();
  for (let i = runs.length - 1; i >= 0; i--) {
    const id = runs[i] && runs[i].id;
    if (id == null) continue;
    if (seenRuns.has(id)) runs.splice(i, 1);
    else seenRuns.add(id);
  }
  if (!runs.length) return null;
  // When every run of the window was read, the window is the one asked for: a repository that ran
  // nothing for the first five days of seven still ran that much in a week. Only a window cut short
  // by the run cap covers less, from its oldest run to now.
  const oldest = Math.min(...runs.map((r) => Date.parse(r.created_at)));
  const coveredDays = truncated ? Math.max(0.25, (now.getTime() - oldest) / 86400e3) : days;

  // Each workflow's own name (one call): a run's name can be its pull request's title. Only labels
  // depend on it, so an answer that cannot be read leaves the run names to label the workflows;
  // the rate-limit reserve still stops the audit.
  // The list is paginated: pages are read until every workflow the runs name has its name, or the
  // list ends (a short page, or as many records as its total_count). Usually that is one call; the
  // rate-limit reserve bounds the rest.
  const workflowNames = new Map();
  const wantedIds = new Set(runs.map((r) => r.workflow_id).filter((id) => id != null));
  try {
    for (let page = 1, seen = 0; ; page++) {
      const listed = page === 1 ? await settled(early.workflows) : await client.get(`repos/${repo}/actions/workflows?per_page=100&page=${page}`);
      const batch = listed && Array.isArray(listed.workflows) ? listed.workflows : [];
      seen += batch.length;
      for (const w of batch) if (w && w.id != null && typeof w.name === 'string') workflowNames.set(w.id, w.name);
      const total = listed && Number.isFinite(listed.total_count) ? listed.total_count : Infinity;
      if (batch.length < 100 || seen >= total || [...wantedIds].every((id) => workflowNames.has(id))) break;
    }
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
  }
  const byWf = groupRuns(runs, workflowNames);
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
  // Each run's jobs are read once: the timing samples and the merge-gate check share them.
  const rawJobs = new Map();
  const jobsRaw = (r) => {
    if (!rawJobs.has(r.id)) rawJobs.set(r.id, client.get(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`));
    return rawJobs.get(r.id);
  };
  const jobsOf = async (r) => {
    const j = await jobsRaw(r);
    return j ? (j.jobs || []).filter((x) => x.started_at && x.completed_at && x.conclusion !== 'skipped') : null;
  };
  // The sampled workflows' files are read beside their jobs.
  const samplePaths = [...new Set(top.map(([, rs]) => String(rs[0].path || '').split('@')[0]).filter((p) => p.startsWith('.github/workflows/')))];
  const sampleTextsP = Promise.all(samplePaths.map((path) => settle(client.getRaw(`repos/${repo}/contents/${encodePath(path)}`))));
  // Every sampled run's jobs are read together (the client keeps a few in flight at once), and
  // put back in the order they were asked for, so the result does not depend on which came first.
  const timed = await Promise.all(top.map(async ([wf, rs], n) => {
    onProgress(`timing ${wf} (${n + 1}/${top.length})`);
    const ok = rs.filter((r) => r.status === 'completed' && r.conclusion === 'success').slice(0, perWorkflow);
    const outcomes = ['failure', 'cancelled', 'timed_out'].map((outcome) => [outcome, rs.filter((r) => r.status === 'completed' && r.conclusion === outcome).slice(0, perOutcome)]);
    const [okJobs, ...outcomeJobs] = await Promise.all([
      Promise.all(ok.map(jobsOf)),
      ...outcomes.map(([, picked]) => Promise.all(picked.map(jobsOf))),
    ]);
    const byOutcome = {};
    outcomes.forEach(([outcome], i) => {
      const got = outcomeJobs[i].filter(Boolean);
      if (got.length) byOutcome[outcome] = got;
    });
    return [wf, okJobs.filter(Boolean), byOutcome];
  }));
  for (const [wf, jobsPerRun, byOutcome] of timed) {
    samples.set(wf, jobsPerRun);
    outcomeSamples.set(wf, byOutcome);
  }
  onProgress('reading workflow files');
  const files = new Map();
  // What each read returned (null for a file that could not be read), so the scans count a failed
  // read as unread rather than as an empty file.
  const fileReads = new Map();
  const sampleTexts = await Promise.all((await sampleTextsP).map((r) => settled(Promise.resolve(r))));
  samplePaths.forEach((path, i) => {
    const text = sampleTexts[i];
    fileReads.set(path, typeof text === 'string' ? text : null);
    files.set(path, text || '');
  });
  // The workflow scans read every workflow file, not only the sampled workflows': an attack comes in
  // through whichever workflow lets it, busy or not. One listing, then each file not read yet, up to
  // maxScanFiles; `scanned` says how many of how many were read.
  onProgress('scanning workflow files');
  // The workflow listing, the repository's metadata and its root listing do not depend on each other.
  const [listing, meta, rootListing] = await Promise.all([settled(early.listing), settled(early.meta), settled(early.root)]);
  const workflowPaths = (Array.isArray(listing) ? listing : [])
    .filter((x) => x && x.type === 'file' && /\.ya?ml$/i.test(String(x.name || '')))
    .map((x) => `.github/workflows/${x.name}`)
    .sort();
  // Only a file that was read counts as scanned: one that came back missing (deleted between the
  // listing and the read) is counted apart, and without a listing the total is unknown (null).
  const listed = Array.isArray(listing);
  const scanFiles = new Map();
  const unreadable = [];
  const candidates = listed ? workflowPaths : [...files.keys()];
  const toScan = candidates.slice(0, maxScanFiles);
  const scanTexts = await Promise.all(toScan.map((path) => {
    const known = fileReads.get(path);
    return known !== undefined ? known : client.getRaw(`repos/${repo}/contents/${encodePath(path)}`);
  }));
  toScan.forEach((path, i) => {
    if (typeof scanTexts[i] === 'string') scanFiles.set(path, scanTexts[i]);
    else unreadable.push(path);
  });
  const scanned = { read: scanFiles.size, of: listed ? workflowPaths.length : null, unreadable };
  // The default branch, for advice that names it (a push trigger limited to it). Unknown when the
  // token cannot read the repository's metadata; the advice then says to fill it in.
  const defaultBranch = meta && typeof meta.default_branch === 'string' ? meta.default_branch : null;
  // Standard GitHub-hosted runners are free for public repositories, so billed minutes only cost
  // money on a private or internal one. Null when the metadata cannot be read.
  const visibility = meta && typeof meta.visibility === 'string' ? meta.visibility : meta && typeof meta.private === 'boolean' ? (meta.private ? 'private' : 'public') : null;
  const root = rootListing || [];
  const names = new Set((Array.isArray(root) ? root : []).map((x) => x && x.name));
  const lockfiles = LOCKFILES.filter((f) => names.has(f)).sort();
  onProgress('reading merge gates');
  const gates = await collectGates(client, repo, { runs, byWf, defaultBranch, rootNames: Array.isArray(rootListing) ? names : null, jobsRaw, settle, settled });
  return { runs, byWf, samples, outcomeSamples, scanFiles, scanned, coveredDays, truncated, since, files, lockfiles, defaultBranch, visibility, gates, only: wanted.length ? only : [], onlyMissing };
}

const PR_EVENTS = new Set(['pull_request', 'pull_request_target', 'merge_group']);
const RENOVATE_FILES = ['renovate.json', 'renovate.json5', '.renovaterc', '.renovaterc.json', '.renovaterc.json5'];

/**
 * What guards a merge into the default branch, from what a read-only token can see: the required
 * status checks of the branch's rulesets (GET rules/branches) and of classic branch protection (the
 * branch's protection summary), the checks pull requests actually got (the jobs of each workflow's
 * newest pull request run in the window: a job's name is the check Actions reports), whether code
 * scanning runs, and whether dependency updates are configured. Anything that could not be read is
 * null (unknown), never "none".
 */
async function collectGates(client, repo, { runs, byWf, defaultBranch, rootNames, jobsRaw, settle, settled }) {
  const soft = async (p) => {
    try {
      return { ok: true, value: await settled(settle(p)) };
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      return { ok: false, value: null };
    }
  };
  const branch = defaultBranch ? encodeURIComponent(defaultBranch) : null;
  // The newest pull request run of each workflow that ran on one in the window.
  const prRuns = [];
  for (const rs of byWf.values()) {
    const pr = rs.find((r) => PR_EVENTS.has(r.event));
    if (pr) prRuns.push(pr);
  }
  const [rules, branchInfo, githubDir, ...prJobLists] = await Promise.all([
    branch ? soft(client.get(`repos/${repo}/rules/branches/${branch}?per_page=100`)) : { ok: false, value: null },
    branch ? soft(client.get(`repos/${repo}/branches/${branch}`)) : { ok: false, value: null },
    soft(client.get(`repos/${repo}/contents/.github`)),
    ...prRuns.map((r) => soft(jobsRaw(r))),
  ]);
  // Required checks: every enforced ruleset rule, and classic protection when it is on.
  let required = null;
  const rulesRead = rules.ok && Array.isArray(rules.value);
  const protection = branchInfo.ok && branchInfo.value ? branchInfo.value.protection : undefined;
  const classicRead = protection !== undefined && protection !== null;
  if (rulesRead || classicRead) {
    const seen = new Map();
    const add = (context, integrationId) => {
      if (typeof context !== 'string' || !context) return;
      if (!seen.has(context)) seen.set(context, { context, integrationId: integrationId ?? null });
    };
    if (rulesRead) {
      for (const rule of rules.value) {
        if (rule && rule.type === 'required_status_checks') {
          for (const c of (rule.parameters && rule.parameters.required_status_checks) || []) add(c && c.context, c && c.integration_id);
        }
      }
    }
    if (classicRead && protection.enabled !== false) {
      const rsc = protection.required_status_checks || {};
      if (rsc.enforcement_level !== 'off') {
        for (const c of rsc.contexts || []) add(c, null);
        for (const c of rsc.checks || []) add(c && c.context, c && c.app_id);
      }
    }
    required = [...seen.values()];
  }
  const prChecks = new Set();
  let prJobsRead = 0;
  prJobLists.forEach((r) => {
    if (r.ok && r.value && Array.isArray(r.value.jobs)) {
      prJobsRead += 1;
      for (const j of r.value.jobs) if (j && typeof j.name === 'string') prChecks.add(j.name);
    }
  });
  // Code scanning: default setup runs as a dynamic workflow; advanced setup is a workflow file
  // (read by the caller from scanFiles).
  const codeScanningRuns = runs.some((r) => String(r.path || '').startsWith('dynamic/github-code-scanning'));
  const dependabotRuns = runs.some((r) => String(r.path || '').startsWith('dynamic/dependabot'));
  const ghNames = githubDir.ok && Array.isArray(githubDir.value) ? new Set(githubDir.value.map((x) => x && x.name)) : null;
  const dependabotFile = ghNames ? ghNames.has('dependabot.yml') || ghNames.has('dependabot.yaml') : null;
  const renovateFile = ghNames && rootNames ? RENOVATE_FILES.some((f) => rootNames.has(f) || ghNames.has(f)) : null;
  return {
    branch: defaultBranch,
    required,
    pr_runs_seen: prRuns.length,
    pr_runs_read: prJobsRead,
    pr_checks: [...prChecks].sort(),
    code_scanning_runs: codeScanningRuns,
    dependency_updates: dependabotRuns || dependabotFile || renovateFile ? true : dependabotFile === null || renovateFile === null ? null : false,
  };
}



