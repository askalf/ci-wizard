// Security scans of every workflow file, the checks a supply-chain review starts with: actions
// pinned to something that can move, untrusted event text pasted into a shell, and a job token with
// more power than the job needs. Each reads the parsed file, so a commented-out line never counts,
// and each finding names the file, job and step it found.
import { parseWorkflow } from './workflow.mjs';

/** Owners whose actions GitHub itself publishes. */
const FIRST_PARTY = new Set(['actions', 'github']);

/**
 * A uses: reference as owner, name and ref; null for a local action (./), a Docker image, or text
 * that is not a reference.
 */
export function parseUses(uses) {
  const s = String(uses ?? '').trim();
  if (!s || s.startsWith('./') || s.startsWith('../') || s.startsWith('docker://')) return null;
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_./-]+)@(.+)$/.exec(s);
  if (!m) return null;
  return { owner: m[1], name: m[2], ref: m[3], pinned: /^[0-9a-f]{40}$/i.test(m[3]), firstParty: FIRST_PARTY.has(m[1].toLowerCase()) };
}

/**
 * Event fields an outside contributor writes, per GitHub's security-hardening guide: titles,
 * bodies, commit messages and authors, and branch names. Interpolated into a run script, any of
 * them is code the contributor chose.
 */
const UNTRUSTED = new RegExp([
  String.raw`github\.event\.(issue|pull_request|discussion)\.(title|body)`,
  String.raw`github\.event\.(comment|review|review_comment)\.body`,
  String.raw`github\.event\.pages(\.\*|\[[^\]]*\])\.page_name`,
  String.raw`github\.event\.commits(\.\*|\[[^\]]*\])\.(message|author\.(email|name))`,
  String.raw`github\.event\.head_commit\.(message|author\.(email|name))`,
  String.raw`github\.event\.pull_request\.head\.(ref|label|repo\.default_branch)`,
  String.raw`github\.event\.workflow_run\.(head_branch|head_commit\.(message|author\.(email|name)))`,
  String.raw`github\.head_ref`,
].map((p) => `(?:${p})`).join('|'));

/** The untrusted expressions in a script: each `${{ }}` that reads an untrusted field. */
export function untrustedExpressions(script) {
  const out = [];
  for (const m of String(script ?? '').matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const hit = UNTRUSTED.exec(m[1]);
    if (hit) out.push({ expression: m[0], field: hit[0] });
  }
  return out;
}

/** A shell-safe variable name for a field: github.event.pull_request.title becomes PR_TITLE. */
export function envNameFor(field) {
  const parts = String(field).replace(/\[[^\]]*\]|\.\*/g, '').split('.');
  const last = parts.slice(-2).join('_').replace(/^pull_request_/, 'PR_').replace(/^github_/, '');
  return last.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

function jobsOf(doc) {
  return Object.entries(doc.jobs || {}).filter(([, j]) => j && typeof j === 'object');
}

function stepsOf(job) {
  return Array.isArray(job.steps) ? job.steps.filter((st) => st && typeof st === 'object') : [];
}

/**
 * What one workflow file shows: unpinned action references, untrusted text in scripts, and how
 * its job token is scoped.
 */
export function scanWorkflow(text) {
  const doc = parseWorkflow(text);
  const unpinned = [];
  const injections = [];
  for (const [id, job] of jobsOf(doc)) {
    const reusable = parseUses(job.uses);
    if (reusable && !reusable.pinned) unpinned.push({ job: id, uses: String(job.uses), firstParty: reusable.firstParty });
    stepsOf(job).forEach((st, i) => {
      const step = st.name ? String(st.name) : st.uses ? String(st.uses) : `step ${i + 1}`;
      const ref = parseUses(st.uses);
      if (ref && !ref.pinned) unpinned.push({ job: id, step, uses: String(st.uses), firstParty: ref.firstParty });
      // A run script, and actions/github-script's script input, are code: an expression there is
      // pasted in before the shell or the script engine reads it.
      const scripts = [st.run];
      if (/^actions\/github-script@/.test(String(st.uses || '')) && st.with && typeof st.with === 'object') scripts.push(st.with.script);
      for (const script of scripts) {
        for (const hit of untrustedExpressions(script)) injections.push({ job: id, step, ...hit });
      }
    });
  }
  // The job token: write-all anywhere is a grant of everything; no permissions block at the top and
  // none on a job leaves that job the repository's default, which the audit cannot read (read-only
  // for repositories created since February 2023, write on many older ones).
  const isWriteAll = (p) => typeof p === 'string' && p.trim().toLowerCase() === 'write-all';
  const jobs = jobsOf(doc).filter(([, j]) => j.uses === undefined || j.permissions !== undefined);
  const writeAll = isWriteAll(doc.permissions) ? ['(workflow)'] : jobs.filter(([, j]) => isWriteAll(j.permissions)).map(([id]) => id);
  const unscoped = doc.permissions === undefined ? jobs.filter(([, j]) => j.permissions === undefined).map(([id]) => id) : [];
  return { unpinned, injections, writeAll, unscoped, parsed: Object.keys(doc).length > 0 };
}

const list = (xs, n = 5) => `${xs.slice(0, n).join('; ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`;
const where = (paths) => (paths.length === 1 ? paths[0] : `${paths.length} workflow files: ${list(paths, 4)}`);

/** The scan findings for a repository's workflow files (path -> text), one per kind. */
export function scanFindings(files) {
  const scans = [...files].map(([path, text]) => ({ path, ...scanWorkflow(text) })).filter((s) => s.parsed);
  const F = [];

  const unpinned = scans.flatMap((s) => s.unpinned.map((u) => ({ ...u, path: s.path })));
  if (unpinned.length) {
    const third = unpinned.filter((u) => !u.firstParty);
    const unique = (xs) => [...new Set(xs.map((u) => u.uses))];
    const paths = [...new Set(unpinned.map((u) => u.path))];
    F.push({
      saving: 0, unit: 'risk', confidence: 'confirmed', what: 'actions not pinned to a commit',
      workflow: where(paths),
      evidence: `${unpinned.length} action reference${unpinned.length === 1 ? '' : 's'} ${unpinned.length === 1 ? 'is' : 'are'} pinned to a tag or branch, which its owner (or anyone who takes over the repository) can move to other code`
        + (third.length ? `; third-party: ${list(unique(third))}` : '; all are GitHub\'s own actions')
        + (unpinned.length > third.length ? `${third.length ? '; GitHub\'s own' : ''}: ${list(unique(unpinned.filter((u) => u.firstParty)), 3)}` : ''),
      fix: 'pin each to the full 40-character commit SHA of the release it means, with the tag in a comment, and let Dependabot or Renovate propose new pins as releases come',
      tradeoff: 'a new release becomes a pull request to review instead of arriving silently with a moved tag',
      example: `- uses: ${(third[0] || unpinned[0]).uses.split('@')[0]}@<full 40-character commit SHA>  # ${(third[0] || unpinned[0]).uses.split('@')[1]}`,
    });
  }

  const injections = scans.flatMap((s) => s.injections.map((x) => ({ ...x, path: s.path })));
  if (injections.length) {
    const first = injections[0];
    const env = envNameFor(first.field);
    F.push({
      saving: 0, unit: 'risk', confidence: 'confirmed', what: 'untrusted input in a script',
      workflow: where([...new Set(injections.map((x) => x.path))]),
      evidence: `${list(injections.map((x) => `${x.path} job ${x.job}, ${x.step}: ${x.expression}`), 4)}; the expression is pasted into the script before it runs, so a title, branch name or comment written as shell code runs as shell code`,
      fix: 'pass the value through an environment variable and quote it in the script, so it is read as data and never parsed as code',
      tradeoff: 'none to speak of: the step reads the same value, and only the shell no longer executes it',
      example: `- name: ${first.step}\n  env:\n    ${env}: ${first.expression}\n  run: echo "$${env}"   # quoted: the value is data, never code`,
    });
  }

  const writeAll = scans.filter((s) => s.writeAll.length);
  const unscoped = scans.filter((s) => s.unscoped.length);
  if (writeAll.length || unscoped.length) {
    const confirmed = writeAll.length > 0;
    const parts = [];
    if (writeAll.length) parts.push(`write-all in ${list(writeAll.map((s) => `${s.path} (${s.writeAll.join(', ')})`), 4)}`);
    if (unscoped.length) parts.push(`no permissions block in ${list(unscoped.map((s) => s.path), 4)}, so its jobs get the repository's default token, which is write access on many repositories created before February 2023`);
    F.push({
      saving: 0, unit: 'risk', confidence: confirmed ? 'confirmed' : 'inferred', what: 'job token wider than the job',
      workflow: where([...new Set([...writeAll, ...unscoped].map((s) => s.path))]),
      evidence: `${parts.join('; ')}: a compromised step can use the token to push, release or change settings`,
      fix: 'set a read-only default at the top of each workflow and grant each job only what it uses',
      tradeoff: 'a job that needs more (a release, a comment, a package) must name it, so a missing grant shows as a 403 the first time it runs',
      example: 'permissions:\n  contents: read\njobs:\n  release:\n    permissions:\n      contents: write   # only the job that publishes',
    });
  }
  return F;
}
