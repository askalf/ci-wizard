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

// The scans, the merge-gate checks and the measurements each read the same files. Inside an audit
// (withParseCache) a parsed file is kept by its text for the whole audit, so each is parsed once;
// the cache goes with the audit, so a long-lived process holds nothing between audits. Outside one,
// every call parses. Callers treat the document as read-only.
let parsed = null;

/** Runs fn (synchronous) with one parse per distinct workflow text; a nested call shares the outer cache. */
export function withParseCache(fn) {
  if (parsed) return fn();
  parsed = new Map();
  try {
    return fn();
  } finally {
    parsed = null;
  }
}

export function parseWorkflow(text) {
  if (!text) return {};
  const key = String(text);
  if (parsed && parsed.has(key)) return parsed.get(key);
  let doc;
  try {
    doc = parse(key, { uniqueKeys: false });
    doc = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch {
    doc = {};
  }
  if (parsed) parsed.set(key, doc);
  return doc;
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

/**
 * The body of a value that is one whole `${{ … }}` expression, trimmed, or null. A prefix and
 * suffix test, not a regex: a pattern like /^\$\{\{\s*(.*?)\s*\}\}$/ backtracks in cubic time
 * on a long unterminated value, which a hostile workflow file can supply.
 */
export function wholeExpression(s) {
  const t = String(s).trim();
  return t.length >= 5 && t.startsWith('${{') && t.endsWith('}}') ? t.slice(3, -2).trim() : null;
}

/** Whether a YAML value turns a feature on: true, "true", or an expression that is not literally false. */
export function isOn(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  const s = String(value).trim();
  if (s === '' || s === 'false') return false;
  if (s === 'true') return true;
  const expr = wholeExpression(s);
  if (expr !== null) return expr !== 'false' && expr !== "'false'";
  return false;
}

/** A setup action's cache input names a package manager (npm, pip, maven) or says true; off is false, empty, or an expression that is literally false. */
export function cacheInputOn(value) {
  if (value === undefined || value === null || value === false) return false;
  const s = String(value).trim();
  if (s === '' || s === 'false') return false;
  const expr = wholeExpression(s);
  if (expr !== null) return expr !== 'false' && expr !== "''" && expr !== "'false'";
  return true;
}

/** The major version in `owner/action@v4` or `@v4.1.0`, or null for a SHA or a branch. */
function majorOf(uses) {
  const m = /@v(\d+)/.exec(uses);
  return m ? Number(m[1]) : null;
}

/**
 * The simple commands of a shell script, each as its words with the quotes taken off. Commands are
 * split at newlines, `;`, `&`, `|` and parentheses outside quotes; comments and here-document
 * bodies are dropped. A quoted word stays one word, so the text passed to a command (an echo's
 * message, a heredoc's lines) is never read as a command of its own. Expansions are left as
 * written, and a command inside a quoted string (`bash -c "..."`) is not looked into.
 */
export function shellCommands(script) {
  const s = String(script || '');
  const commands = [];
  const heredocs = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      // A backslash before a newline continues the line; before anything else it quotes it.
      if (s[i + 1] !== '\n' && i + 1 < s.length) {
        word += s[i + 1];
        inWord = true;
      }
      i += 1;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end === -1 ? s.length : end;
      word += s.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      word += s.slice(i + 1, Math.min(j, s.length));
      inWord = true;
      i = j;
    } else if (c === '#' && !inWord) {
      const nl = s.indexOf('\n', i);
      i = (nl === -1 ? s.length : nl) - 1;
    } else if (s.startsWith('<<<', i)) {
      // A here-string: the word after it is input, read as an ordinary word.
      endWord();
      i += 2;
    } else if (s.startsWith('$((', i) || (c === '(' && s[i + 1] === '(' && !inWord)) {
      // Arithmetic, $((...)) or ((...)): its << is a shift, not a here-document. Kept as one word.
      const end = s.indexOf('))', i + 2);
      const stop = end === -1 ? s.length : end + 2;
      if (c === '(') endCommand();
      word += s.slice(i, stop);
      inWord = true;
      if (c === '(') endCommand();
      i = stop - 1;
    } else if (c === '<' && s.startsWith('<<', i)) {
      // A here-document: its body, from the next line to the delimiter, is input, not commands.
      const tabs = s[i + 2] === '-';
      const d = heredocWord(s, i + (tabs ? 3 : 2));
      if (d) {
        endWord();
        heredocs.push({ delim: d.word, tabs });
        i = d.end - 1;
      } else {
        word += c;
        inWord = true;
      }
    } else if (c === '\n') {
      endCommand();
      let j = i + 1;
      while (heredocs.length) {
        // The delimiter line matches exactly; <<- strips leading tabs first, nothing else.
        const { delim, tabs } = heredocs.shift();
        while (j < s.length) {
          const nl = s.indexOf('\n', j);
          const end = nl === -1 ? s.length : nl;
          const line = s.slice(j, end);
          j = end + 1;
          if ((tabs ? line.replace(/^\t+/, '') : line) === delim) break;
        }
      }
      i = Math.min(j, s.length) - 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else if (';&|()'.includes(c)) {
      endCommand();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

// A here-document's delimiter: the shell word after << (spaces first), with its quotes removed, so
// 'END-TEXT', "EOF" and E\OF are END-TEXT, EOF and EOF. Null when no word follows.
function heredocWord(s, from) {
  let i = from;
  while (s[i] === ' ' || s[i] === '\t') i += 1;
  let word = '';
  let present = false; // a quoted empty word ('') is a delimiter: an empty line ends it
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const end = s.indexOf(c, i + 1);
      if (end === -1) return null;
      word += s.slice(i + 1, end);
      present = true;
      i = end;
    } else if (c === '\\' && i + 1 < s.length && s[i + 1] !== '\n') {
      word += s[i + 1];
      present = true;
      i += 1;
    } else if (/[\s;&|()<>]/.test(c)) {
      break;
    } else {
      word += c;
      present = true;
    }
  }
  return present ? { word, end: i } : null;
}

// Programs that run the command after them, each with the options of its that take a value (as
// the next word, or after = in a long option): `sudo -u root semgrep ci` runs semgrep, not root.
// After `--`, the next word is the program. Reserved words that open a compound command come
// before a command too: `then semgrep ci`.
const WRAPPERS = new Map([
  ['sudo', ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--command-timeout', '--other-user']],
  ['env', ['-u', '-C', '--unset', '--chdir']],
  ['nice', ['-n', '--adjustment']],
  ['time', ['-f', '-o', '--format', '--output']],
  ['exec', ['-a']],
  ['command', []],
  ['npx', ['-p', '--package']],
  ['pnpx', []],
  ['bunx', ['-p', '--package']],
  ['uvx', ['-p', '--python', '--from', '--with', '--with-editable', '--with-requirements', '-c', '--constraints', '--index', '--default-index', '--index-url', '--extra-index-url', '-f', '--find-links', '--directory', '--project', '--config-file', '--cache-dir']],
].map(([name, valued]) => [name, new Set(valued)]));
const OPENERS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
// Wrapper options that make it look a name up instead of running it: command -v semgrep runs nothing.
const LOOKUPS = new Map([['command', new Set(['-v', '-V'])]]);

/**
 * A command's words from the program it runs, past reserved words that open a compound command,
 * assignments, and wrappers with their options and option values, with the program's directory
 * dropped.
 */
export function programWords(words) {
  let k = 0;
  while (k < words.length && OPENERS.has(words[k])) k += 1;
  let wrapper = null; // the options of the innermost wrapper seen so far
  let lookups = null;
  while (k < words.length) {
    const w = words[k];
    if (WRAPPERS.has(w)) {
      wrapper = WRAPPERS.get(w);
      lookups = LOOKUPS.get(w) || null;
    } else if (lookups && lookups.has(w)) {
      return [];
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      // FOO=1 before a command (or after env) sets a variable for it.
    } else if (wrapper && w === '--') {
      k += 1;
      break;
    } else if (wrapper && w.startsWith('-')) {
      if (wrapper.has(w)) k += 1; // its value is the next word; --user=root carries its own
    } else {
      break;
    }
    k += 1;
  }
  const rest = words.slice(k);
  if (rest.length) rest[0] = rest[0].split('/').pop();
  return rest;
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
  return allJobTimeouts(doc).filter((t) => t.judged).map(({ judged, ...t }) => t);
}

/**
 * Every job of the file, judged or not: `judged` is false for a job whose limit the file does not
 * say (an expression timeout, a reusable-workflow call). Those still take part in matching runs to
 * jobs, so their runs are never credited to another job.
 */
export function allJobTimeouts(doc) {
  const out = [];
  for (const [id, job] of Object.entries(doc.jobs || {})) {
    if (!job || typeof job !== 'object') continue;
    const raw = job['timeout-minutes'];
    const name = typeof job.name === 'string' ? job.name : id;
    if (job.uses !== undefined) out.push({ id, name, minutes: null, isDefault: false, judged: false, reusable: true });
    else if (raw === undefined || raw === null) out.push({ id, name, minutes: DEFAULT_JOB_TIMEOUT, isDefault: true, judged: true });
    else if (typeof raw === 'number' && Number.isFinite(raw)) out.push({ id, name, minutes: raw, isDefault: false, judged: true });
    else if (typeof raw === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(raw)) out.push({ id, name, minutes: Number(raw), isDefault: false, judged: true });
    else out.push({ id, name, minutes: null, isDefault: false, judged: false });
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
/**
 * A matcher for `^L0 … L1 … Ln$` (each … any text), by finding the literals in order: the first as a
 * prefix, the middle ones leftmost after it, the last as a suffix, or, with `rest`, followed by at
 * least one more character. Linear in the name's length, where the equivalent regex
 * (L0[\s\S]*L1[\s\S]*…) backtracks polynomially on a long name that does not match.
 */
function inOrder(literals, { rest = false } = {}) {
  return {
    test(name) {
      const s = String(name);
      const last = literals.length - 1;
      if (!s.startsWith(literals[0])) return false;
      let pos = literals[0].length;
      if (last === 0) return rest ? s.length > pos : s.length === pos;
      for (let i = 1; i < last; i += 1) {
        const at = s.indexOf(literals[i], pos);
        if (at < 0) return false;
        pos = at + literals[i].length;
      }
      if (rest) {
        const at = s.indexOf(literals[last], pos);
        return at >= 0 && s.length > at + literals[last].length;
      }
      return s.length - literals[last].length >= pos && s.endsWith(literals[last]);
    },
  };
}

export function jobNamePattern(fileJobName, { reusable = false } = {}) {
  const base = String(fileJobName);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A reusable-workflow call runs no job of its own: its runs are the called workflow's jobs, named
  // "<call> / <job>" (a matrix leg "<call> (a) / <job>"). It claims those before any ordinary job,
  // so its children's runs are never credited to a job that only shares its name.
  if (reusable) {
    const literals = base.split(/\$\{\{[\s\S]*?\}\}/);
    if (!literals.join('').trim()) return { rx: /(?!)/, specificity: 0 };
    if (base.includes('${{')) {
      const parts = [...literals];
      parts[parts.length - 1] += ' / ';
      return { rx: inOrder(parts, { rest: true }), specificity: Infinity };
    }
    return { rx: new RegExp(`^${esc(base)}( \\(.*\\))? / [\\s\\S]+$`), specificity: Infinity };
  }
  if (base.includes('${{')) {
    const literals = base.split(/\$\{\{[\s\S]*?\}\}/);
    // A name that is all expression has no text to recognise its runs by: it matches nothing.
    if (!literals.join('').trim()) return { rx: /(?!)/, specificity: 0 };
    return { rx: inOrder(literals), specificity: literals.join('').length };
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
 * @returns {Map<string, string[]>} file job id (or name) -> its API job names
 */
export function assignJobRuns(fileJobNames, apiNames) {
  // Each entry is a name, or { id, name, reusable }. Results are keyed by the job id when there is
  // one (else the name), since two jobs can share a display name and must not share runs.
  const patterns = fileJobNames.map((j) => (typeof j === 'string'
    ? { key: j, ...jobNamePattern(j) }
    : { key: j.id ?? j.name, ...jobNamePattern(j.name, { reusable: j.reusable }) }));
  const out = new Map(patterns.map((p) => [p.key, []]));
  for (const api of apiNames) {
    const hits = patterns.filter((p) => p.rx.test(api)).sort((a, b) => b.specificity - a.specificity);
    if (!hits.length || (hits[1] && hits[1].specificity === hits[0].specificity)) continue;
    out.get(hits[0].key).push(api);
  }
  return out;
}
