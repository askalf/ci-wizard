// What a workflow file says, as the findings need it: the command behind each step, the
// triggers, the push branch patterns and the concurrency group. A file that does not parse yields
// no facts, never an error: the audit then falls back to the step names the API reports.
import { parse } from 'yaml';

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
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

/**
 * Step name -> its run or uses text, naming unnamed steps the way GitHub does ("Run <uses>" or
 * "Run <first line>"). A name with an expression (`Test on ${{ matrix.node }}`) reaches the API
 * expanded, so categoryOf also matches it as a pattern.
 */
export function stepCommands(doc) {
  const out = new Map();
  for (const job of Object.values(doc.jobs || {})) {
    for (const st of (job && job.steps) || []) {
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
    for (const st of (job && job.steps) || []) if (st && typeof st === 'object') steps.push(st);
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
  for (const st of steps) {
    const uses = String(st.uses || '');
    const inputs = st.with && typeof st.with === 'object' ? st.with : {};
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
    preferOffline: runs.includes('--prefer-offline'),
  };
}
