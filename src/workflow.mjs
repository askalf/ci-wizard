// What a workflow file says, as the findings need it: the command behind each step, the
// triggers, the push branch patterns and the concurrency group. A file that does not parse yields
// no facts, never an error: the audit then falls back to the step names the API reports.
import { parse } from 'yaml';
import { UNKNOWN, forkPullRequestContext, opaqueTag, valueOf } from './expr.mjs';

/** Step categories, matched on a lower-cased step name or command (a "Post " step counts with what it posts for). */
const CATS = [
  ['overhead', /^(set up job|complete job|set up runner|complete runner)$/],
  // actions/checkout, or a step named for it; not a test suite that happens to say "checkout".
  ['checkout', /actions\/checkout|^check ?out\b|^git clone\b/],
  ['toolchain', /setup-(node|go|python|java|dotnet|ruby|pnpm|bun|deno|uv|rust)|pnpm\/action-setup|rustup|toolchain|install (node|go|python|pnpm|bun|deno|rust)\b|setup (node|go|python|pnpm|bun|java)/],
  ['deps', /\b(npm (ci|install|i)\b|pnpm (install|i)\b|\byarn(\s+install\b|\s*$|\s+--(frozen-lockfile|immutable|pure-lockfile|prefer-offline))|bun install|pip install|uv (sync|pip)|poetry install|go mod download|bundle install|cargo fetch|install (dep|package)|dependencies)/],
  ['cache', /\bcache\b/],
  ['artifacts', /(upload|download)-artifact|(upload|download) artifact/],
  ['docker', /\bdocker\b|buildx|build-push/],
];

export const CATEGORIES = ['overhead', 'checkout', 'toolchain', 'deps', 'cache', 'artifacts', 'docker', 'work'];

export function category(name) {
  let n = String(name).toLowerCase();
  if (n.startsWith('post ')) n = n.slice(5);
  for (const [c, rx] of CATS) if (rx.test(n)) return c;
  return 'work';
}

export function parseWorkflow(text) {
  if (!text) return {};
  try {
    const doc = parse(text, { uniqueKeys: false });
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

// A job's steps as a list. A file that gives `steps` as anything else (a mapping, a number) has no
// steps this tool can read, and must not stop the audit of every other workflow.
function stepsOfJob(job) {
  return job && Array.isArray(job.steps) ? job.steps : [];
}

/**
 * Step name -> its run or uses text, naming unnamed steps the way GitHub does ("Run <uses>" or
 * "Run <first line>"). A name with an expression (`Test on ${{ matrix.node }}`) reaches the API
 * expanded, so categoryOf also matches it as a pattern.
 */
export function stepCommands(doc) {
  const out = new Map();
  for (const job of Object.values(doc.jobs || {})) {
    for (const st of stepsOfJob(job)) {
      if (!st || typeof st !== 'object') continue;
      const cmd = String(st.run || st.uses || '');
      let name = st.name;
      if (!name) {
        if (st.uses) name = `Run ${st.uses}`;
        else if (st.run) name = `Run ${String(st.run).trim().split('\n')[0]}`;
      }
      if (name) out.set(String(name).trim(), cmd);
    }
  }
  return out;
}

/**
 * The category of a step: by its name first, and when the name says nothing (category "work"),
 * by the command the workflow file gives it, so a step named "Install" that runs `npm install`
 * counts as a dependency install.
 */
export function commandOf(name, commands) {
  const n = String(name).trim();
  const exact = commands.get(n) || (n.startsWith('Post ') ? commands.get(n.slice(5)) : '');
  if (exact) return exact;
  for (const [pattern, cmd] of commands) {
    if (!pattern.includes('${{')) continue;
    const rx = new RegExp(`^(Post )?${pattern.split(/\$\{\{.*?\}\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*?')}$`, 's');
    if (rx.test(n)) return cmd;
  }
  return '';
}

export function categoryOf(name, commands) {
  const c = category(name);
  if (c !== 'work') return c;
  const cmd = commandOf(name, commands);
  if (!cmd) return c;
  const first = cmd.trim() ? cmd.split('\n')[0] : '';
  const c2 = category(first);
  if (c2 === 'work') {
    for (const line of cmd.split('\n')) if (category(line) === 'deps') return 'deps';
  }
  return c2;
}

function onOf(doc) {
  // YAML 1.1 parsers read a bare `on:` key as the boolean true; this parser reads YAML 1.2, but a file may say either.
  return doc.on !== undefined ? doc.on : doc.true;
}

export function triggersOf(doc) {
  const on = onOf(doc);
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String).sort();
  if (on && typeof on === 'object') return Object.keys(on).sort();
  return [];
}

export function pushBranchesOf(doc) {
  const on = onOf(doc);
  if (on && typeof on === 'object' && !Array.isArray(on) && on.push && typeof on.push === 'object') {
    const b = on.push.branches;
    return Array.isArray(b) ? b.map(String) : [];
  }
  return [];
}

export function concurrencyGroupOf(doc) {
  const c = doc.concurrency;
  if (c && typeof c === 'object') return String(c.group || '');
  return c ? String(c) : '';
}

/** Every step of every job, in file order. */
export function allSteps(doc) {
  const steps = [];
  for (const job of Object.values(doc.jobs || {})) {
    for (const st of stepsOfJob(job)) if (st && typeof st === 'object') steps.push(st);
  }
  return steps;
}

/** Whether a YAML value turns a feature on: true, "true", or an expression that is not literally false. */
export function isOn(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  const s = String(value).trim();
  if (s === '' || s === 'false') return false;
  if (s === 'true') return true;
  const expr = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(s);
  if (expr) return expr[1] !== 'false' && expr[1] !== "'false'";
  return false;
}

/** A setup action's cache input names a package manager (npm, pip, maven) or says true; off is false, empty, or an expression that is literally false. */
export function cacheInputOn(value) {
  if (value === undefined || value === null || value === false) return false;
  const s = String(value).trim();
  if (s === '' || s === 'false') return false;
  const expr = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(s);
  if (expr) return expr[1] !== 'false' && expr[1] !== "''" && expr[1] !== "'false'";
  return true;
}

/** The major version in `owner/action@v4` or `@v4.1.0`, or null for a SHA or a branch. */
function majorOf(uses) {
  const m = /@v(\d+)/.exec(uses);
  return m ? Number(m[1]) : null;
}

/** The package managers a workflow installs with, from its run lines and setup actions, in a fixed order. */
export function installersOf(runs, steps = []) {
  const uses = steps.map((st) => String(st.uses || '')).join('\n');
  const found = [];
  const add = (name, hit) => {
    if (hit && !found.includes(name)) found.push(name);
  };
  add('pnpm', /\bpnpm (install|i)\b/.test(runs) || /pnpm\/action-setup@/.test(uses));
  add('yarn', /\byarn(\s+install\b|\s*$|\s+--)/m.test(runs));
  add('npm', /\bnpm (ci|install|i)\b/.test(runs));
  add('bun', /\bbun install\b/.test(runs));
  add('uv', /\buv (sync|pip)\b/.test(runs) || /astral-sh\/setup-uv@/.test(uses));
  add('poetry', /\bpoetry install\b/.test(runs));
  add('pipenv', /\bpipenv (install|sync)\b/.test(runs));
  add('pip', /\bpip3? install\b/.test(runs));
  add('go', /\bgo (mod download|build|test)\b/.test(runs) || /actions\/setup-go@/.test(uses));
  add('bundler', /\bbundle install\b/.test(runs) || /ruby\/setup-ruby@/.test(uses));
  add('cargo', /\bcargo (fetch|build|test)\b/.test(runs));
  return found;
}

/**
 * Cache, concurrency and install facts from the parsed file, so a commented-out line or a value
 * that switches a feature off never counts. A dependency cache is an actions/cache step, a setup
 * action's cache input that is on (setup-go from v4 caches unless told not to), a
 * cache-dependency-path, or setup-ruby's bundler-cache.
 */
export function workflowFacts(doc) {
  const steps = allSteps(doc);
  let hasCache = false;
  let setupCache = false;
  let cachesNodeModules = false;
  // What makes a checkout slow, as the file says: the whole history, LFS objects, submodules or
  // every tag. actions/checkout fetches one commit with none of those by default.
  // `inspected` says a checkout step was found to read; `depth` is the largest fetch-depth above 1
  // it sets (null when every step fetches one commit), and `depthUnknown` a depth set by an
  // expression, which cannot be read from the file.
  const checkout = { inspected: false, fullHistory: false, depth: null, depthUnknown: false, lfs: false, submodules: false, tags: false };
  for (const st of steps) {
    const uses = String(st.uses || '');
    const inputs = st.with && typeof st.with === 'object' ? st.with : {};
    if (/^actions\/checkout@/.test(uses)) {
      checkout.inspected = true;
      const rawDepth = inputs['fetch-depth'];
      if (rawDepth !== undefined && rawDepth !== null && String(rawDepth).trim() !== '') {
        const d = Number(String(rawDepth).trim());
        if (d === 0) checkout.fullHistory = true;
        else if (Number.isInteger(d) && d > 1) checkout.depth = Math.max(checkout.depth ?? 0, d);
        else if (!Number.isInteger(d)) checkout.depthUnknown = true;
      }
      if (isOn(inputs.lfs)) checkout.lfs = true;
      const sub = String(inputs.submodules ?? '').trim();
      if (sub === 'recursive' || isOn(inputs.submodules)) checkout.submodules = true;
      if (isOn(inputs['fetch-tags'])) checkout.tags = true;
    }
    if (/^actions\/cache(\/restore)?@/.test(uses)) {
      hasCache = true;
      if (/node_modules/.test(String(inputs.path || ''))) cachesNodeModules = true;
    }
    if (/^actions\/setup-[a-z]+@/.test(uses) || /^pnpm\/action-setup@/.test(uses) || /^ruby\/setup-ruby@/.test(uses)) {
      const cacheInput = inputs.cache;
      const goDefault = /^actions\/setup-go@/.test(uses) && (majorOf(uses) ?? 4) >= 4 && cacheInput === undefined;
      if (cacheInputOn(cacheInput) || goDefault || inputs['cache-dependency-path'] || isOn(inputs['bundler-cache'])) {
        hasCache = true;
        if (/^actions\/setup-node@/.test(uses)) setupCache = true;
      }
    }
  }
  const concurrencies = [doc.concurrency, ...Object.values(doc.jobs || {}).map((j) => j && j.concurrency)].filter((c) => c !== undefined && c !== null);
  const cancels = concurrencies.some((c) => c && typeof c === 'object' && isOn(c['cancel-in-progress']));
  const runs = steps.map((st) => String(st.run || '')).join('\n');
  return {
    hasCache,
    setupCache,
    cachesNodeModules,
    hasConcurrency: concurrencies.length > 0,
    cancels,
    npmInstallNoCi: /\bnpm (install|i)\b/.test(runs) && !/\bnpm ci\b/.test(runs),
    installers: installersOf(runs, steps),
    preferOffline: runs.includes('--prefer-offline'),
    checkout,
  };
}

/** Whether a runs-on value can pick a self-hosted runner: a label list, a string or an expression naming self-hosted. */
export function runsOnSelfHosted(runsOn) {
  if (runsOn === undefined || runsOn === null) return false;
  if (Array.isArray(runsOn)) return runsOn.some((l) => /self-hosted/i.test(String(l)));
  if (typeof runsOn === 'object') return Array.isArray(runsOn.labels) ? runsOn.labels.some((l) => /self-hosted/i.test(String(l))) : /self-hosted/i.test(String(runsOn.labels || ''));
  return /self-hosted/i.test(String(runsOn));
}

/**
 * Whether a resolved runs-on value picks a self-hosted runner: true, false, or null when part of it
 * could not be resolved and the resolved part does not already say self-hosted.
 */
function picksSelfHosted(value, raw) {
  const mentions = /self-hosted/i.test(typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''));
  if (value === UNKNOWN) return mentions ? null : false;
  if (Array.isArray(value)) {
    if (value.some((v) => typeof v === 'string' && /self-hosted/i.test(v))) return true;
    return value.some((v) => v === UNKNOWN) && mentions ? null : false;
  }
  if (value && typeof value === 'object') {
    // A label object: its labels, evaluated (a group alone names no self-hosted label).
    if (value.labels === undefined) return false;
    if (value.labels === UNKNOWN) return mentions ? null : false;
    return picksSelfHosted([].concat(value.labels), raw);
  }
  return typeof value === 'string' && /self-hosted/i.test(value);
}

/**
 * Whether a checkout, for a fork's pull request on pull_request_target, fetches the fork's code,
 * from its ref and repository together: 'yes', 'no' or 'maybe'.
 * - A commit is the same code from any repository: the head commit is the fork's, the base commit
 *   is not.
 * - A branch name (the head's, the base's, a literal, or none for the default branch) is whatever
 *   that branch holds in the repository it is fetched from: the fork's code from the fork, the
 *   base's from the base repository or another fixed one.
 * Anything unresolved is 'maybe'.
 */
export function checkoutRunsForkCode(ref, repository, baseRepo) {
  const refTag = opaqueTag(ref);
  if (refTag === 'head-sha') return 'yes';
  if (refTag === 'base-sha') return 'no';
  if (ref === UNKNOWN || (ref !== null && typeof ref !== 'string' && !refTag)) return 'maybe';
  if (repository === UNKNOWN) return 'maybe';
  const repoTag = opaqueTag(repository);
  if (repoTag === 'head-repo') return 'yes';
  if (repoTag) return 'maybe';
  if (repository !== null && typeof repository !== 'string') return 'maybe';
  return 'no';
}

/**
 * The jobs a pull request from a fork can send to a self-hosted runner, found by evaluating each
 * job's `if` and `runs-on` as GitHub would for such a pull request (src/expr.mjs): a job whose
 * `if` is false for it never runs, and a runs-on that picks a GitHub-hosted runner for it is safe,
 * whatever else the expression mentions. On pull_request_target the job counts only when a step
 * checks out the pull request's head, since that event otherwise runs the base repository's code.
 * `certain` is false when the if or runs-on could not be fully resolved (a vars or matrix value).
 * @returns {{ job: string, runsOn: unknown, event: string, certain: boolean }[]}
 */
export function forkReachableSelfHosted(doc, repo = 'owner/repo') {
  const triggers = triggersOf(doc);
  const events = ['pull_request', 'pull_request_target'].filter((e) => triggers.includes(e));
  const out = [];
  for (const [id, job] of Object.entries(doc.jobs || {})) {
    if (!job || typeof job !== 'object' || job['runs-on'] === undefined) continue;
    const hasNeeds = job.needs !== undefined && !(Array.isArray(job.needs) && job.needs.length === 0);
    for (const event of events) {
      const ctx = forkPullRequestContext(repo, event, { hasNeeds });
      // On pull_request_target the job runs the base repository's code unless a step checks out the
      // pull request's head, and that step only counts when its own if lets it run for a fork.
      let checkoutCertain = true;
      if (event === 'pull_request_target') {
        // A step's status functions follow the steps before it, which can fail, so success() and
        // failure() are unknown there whatever the job's needs.
        const stepCtx = forkPullRequestContext(repo, event);
        // Each checkout step that runs for a fork, judged by what its ref and repository come to:
        // the head's commit or branch, or the head repository, is the fork's code (certain); the
        // base's, or a literal, is not; anything unresolved is possible.
        const verdicts = stepsOfJob(job)
          .filter((st) => st && typeof st === 'object' && /^actions\/checkout@/.test(String(st.uses || '')))
          .map((st) => {
            const cond = st.if === undefined ? true : valueOf(st.if, stepCtx, { isIf: true });
            if (cond !== UNKNOWN && !cond) return 'no';
            const inputs = st.with && typeof st.with === 'object' ? st.with : {};
            const ref = inputs.ref === undefined ? null : valueOf(inputs.ref, stepCtx);
            const repoIn = inputs.repository === undefined ? null : valueOf(inputs.repository, stepCtx);
            let which = checkoutRunsForkCode(ref, repoIn, repo);
            if (which === 'yes' && cond === UNKNOWN) which = 'maybe';
            return which;
          });
        if (!verdicts.some((v) => v !== 'no')) continue;
        checkoutCertain = verdicts.includes('yes');
      }
      const cond = job.if === undefined ? true : valueOf(job.if, ctx, { isIf: true });
      if (cond !== UNKNOWN && !cond) continue;
      const picks = picksSelfHosted(valueOf(job['runs-on'], ctx), job['runs-on']);
      if (picks === false) continue;
      out.push({ job: id, runsOn: job['runs-on'], event, certain: cond !== UNKNOWN && picks === true && checkoutCertain });
      break;
    }
  }
  return out;
}

/** GitHub's job timeout when timeout-minutes is not set, in minutes. */
export const DEFAULT_JOB_TIMEOUT = 360;

/**
 * Each job's timeout as the file sets it: the job id, the name GitHub shows for it (its name, or
 * its id), the minutes (DEFAULT_JOB_TIMEOUT when unset), and whether that is the default. A
 * timeout set by an expression, or a job that calls a reusable workflow (whose own jobs carry the
 * timeouts), is left out: the file does not say what the limit is.
 * @returns {{ id: string, name: string, minutes: number, isDefault: boolean }[]}
 */
export function jobTimeouts(doc) {
  const out = [];
  for (const [id, job] of Object.entries(doc.jobs || {})) {
    if (!job || typeof job !== 'object' || job.uses !== undefined) continue;
    const raw = job['timeout-minutes'];
    const name = typeof job.name === 'string' ? job.name : id;
    if (raw === undefined || raw === null) out.push({ id, name, minutes: DEFAULT_JOB_TIMEOUT, isDefault: true });
    else if (typeof raw === 'number' && Number.isFinite(raw)) out.push({ id, name, minutes: raw, isDefault: false });
    else if (typeof raw === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(raw)) out.push({ id, name, minutes: Number(raw), isDefault: false });
  }
  return out;
}

/**
 * How a file job's name matches the names GitHub gives its runs, and how specific the match is
 * (the length of its literal text). A static name matches itself and its matrix legs
 * ("test (20, ubuntu)"). A name with expressions matches with each expression standing for any
 * text, every literal part kept in place; GitHub adds no matrix suffix to such a name. A name with
 * no literal text matches nothing.
 */
export function jobNamePattern(fileJobName) {
  const base = String(fileJobName);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (base.includes('${{')) {
    const literals = base.split(/\$\{\{[\s\S]*?\}\}/);
    // A name that is all expression has no text to recognise its runs by: it matches nothing.
    if (!literals.join('').trim()) return { rx: /(?!)/, specificity: 0 };
    return { rx: new RegExp(`^${literals.map(esc).join('[\\s\\S]*')}$`), specificity: literals.join('').length };
  }
  return { rx: new RegExp(`^${esc(base)}( \\(.*\\))?$`), specificity: base.length + 1 };
}

/** The API job names that are runs of a file job (see jobNamePattern). */
export function jobRunsOf(fileJobName, apiNames) {
  const { rx } = jobNamePattern(fileJobName);
  return apiNames.filter((n) => rx.test(n));
}

/**
 * Each API job name assigned to at most one file job: the most specific pattern that matches it. A
 * name two jobs match equally well is ambiguous and goes to neither, so no job is judged on
 * another's runs.
 * @returns {Map<string, string[]>} file job name -> its API job names
 */
export function assignJobRuns(fileJobNames, apiNames) {
  const patterns = fileJobNames.map((name) => ({ name, ...jobNamePattern(name) }));
  const out = new Map(fileJobNames.map((n) => [n, []]));
  for (const api of apiNames) {
    const hits = patterns.filter((p) => p.rx.test(api)).sort((a, b) => b.specificity - a.specificity);
    if (!hits.length || (hits[1] && hits[1].specificity === hits[0].specificity)) continue;
    out.get(hits[0].name).push(api);
  }
  return out;
}
