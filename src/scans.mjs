// Security scans of every workflow file, the checks a supply-chain review starts with: actions
// pinned to something that can move, untrusted event text pasted into a shell, and a job token with
// more power than the job needs. Each reads the parsed file, so a commented-out line never counts,
// and each finding names the file, job and step it found.
import { parseWorkflow } from './workflow.mjs';
import { evaluate, expressionSpans, parseExpr } from './expr.mjs';

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
].map((p) => `(?:${p})`).join('|'), 'i');

// The same fields as paths, one per field, with # for a collection's index (commits[0] or commits.*).
// Matching is by path, segment by segment, so an object filter, an element of a collection and an
// object that holds a field are all read the same way.
const UNTRUSTED_PATHS = [
  'github.event.issue.title', 'github.event.issue.body',
  'github.event.pull_request.title', 'github.event.pull_request.body',
  'github.event.discussion.title', 'github.event.discussion.body',
  'github.event.comment.body', 'github.event.review.body', 'github.event.review_comment.body',
  'github.event.pages.#.page_name',
  'github.event.commits.#.message', 'github.event.commits.#.author.email', 'github.event.commits.#.author.name',
  'github.event.head_commit.message', 'github.event.head_commit.author.email', 'github.event.head_commit.author.name',
  'github.event.pull_request.head.ref', 'github.event.pull_request.head.label', 'github.event.pull_request.head.repo.default_branch',
  'github.event.workflow_run.head_branch', 'github.event.workflow_run.head_commit.message',
  'github.event.workflow_run.head_commit.author.email', 'github.event.workflow_run.head_commit.author.name',
  'github.head_ref',
].map((p) => p.split('.'));

/**
 * Whether a normalised path (lower case, a collection index or an object filter as *) reaches an
 * untrusted field: it is the field, or an object that holds one. Segment by segment, a * in the
 * path matches any name or index (an object filter selects every property; github.event.issue.*
 * holds the title), while a named segment matches only that name, and a collection's index (#)
 * only an index, numeric or a numeric string as GitHub accepts it (commits['0']):
 * github.event.*.number reaches no title, and issue['0'] is no index.
 */
function untrustedPath(path) {
  const segs = path.split('.');
  return UNTRUSTED_PATHS.some((u) => segs.length <= u.length
    && segs.every((seg, i) => seg === '*' || seg === u[i] || (u[i] === '#' && /^\d+$/.test(seg))));
}

/** The dotted path of a context reference (github.event.commits[0].message), or null for anything else. */
function pathOf(node) {
  if (node.k === 'ctx') return node.path[0];
  if (node.k === 'prop') {
    const base = pathOf(node.of);
    return base === null ? null : `${base}.${node.key}`;
  }
  if (node.k === 'index') {
    const base = pathOf(node.of);
    if (base === null) return null;
    // A key built from constants (format('tit{0}', 'le')) is the key it evaluates to; one that
    // reads the run (inputs.field, matrix.key) is unknown, marked [?].
    const key = constantKey(node.key);
    if (typeof key === 'string') return `${base}.${key}`;
    return typeof key === 'number' ? `${base}[${key}]` : `${base}[?]`;
  }
  return null;
}

/** The value of an index key that uses no context, or undefined where it reads one or fails. */
function constantKey(node) {
  if (node.k === 'lit') return node.v;
  const readsContext = (n) => n.k === 'ctx' || (n.of && readsContext(n.of)) || (n.key && typeof n.key === 'object' && readsContext(n.key))
    || (n.args && n.args.some(readsContext)) || (n.a && readsContext(n.a)) || (n.b && readsContext(n.b));
  if (readsContext(node)) return undefined;
  try {
    const v = evaluate(node, {});
    return typeof v === 'string' || typeof v === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}

// Functions whose result carries their arguments' text; the rest (contains, startsWith, endsWith,
// hashFiles, the status functions) return a boolean or a hash, never the text itself.
const PASSES_TEXT = new Set(['format', 'join', 'tojson', 'fromjson']);

/**
 * The untrusted fields whose value reaches the result of an expression tree: the field itself, or
 * an object holding one, through ||, the right side of && and the functions that pass text on. A
 * comparison, a negation, a boolean function, a literal, or a field that only picks a branch
 * yields no attacker text.
 */
function flowingFields(node) {
  switch (node.k) {
    case 'ctx': case 'prop': case 'index': {
      const spelled = pathOf(node);
      // A property of a computed value (fromJSON(toJSON(github.event)).issue.title) may be the text
      // the value holds: it carries whatever its base carries.
      if (spelled === null) return node.k === 'ctx' ? [] : flowingFields(node.of);
      const path = spelled.toLowerCase();
      // A key the scan cannot resolve could name any property: where the object before it can hold
      // untrusted text (github.event.issue[inputs.field]), the expression counts.
      if (path.includes('[?]')) {
        const before = path.slice(0, path.indexOf('[?]'));
        return untrustedPath(before.replace(/\[[^\]]*\]/g, '.*')) ? [before] : [];
      }
      const norm = path.replace(/\[[^\]]*\]/g, '.*');
      return untrustedPath(norm) ? [path] : [];
    }
    // a || b gives a when a is truthy, else b: either can be the result. a && b gives a only when a
    // is falsy, and the only falsy text is the empty string, so only b's text can reach the result:
    // in `title && 'yes' || 'no'` the title picks a branch and the result is always a literal.
    case '||': return [...flowingFields(node.a), ...flowingFields(node.b)];
    case '&&': return flowingFields(node.b);
    case 'call': return PASSES_TEXT.has(node.name) ? node.args.flatMap(flowingFields) : [];
    default: return [];
  }
}


/**
 * The untrusted expressions in a script: each `${{ }}` whose value carries text an outside
 * contributor wrote. An expression that does not parse is judged by what it mentions, so an
 * unreadable one is never passed as safe.
 */
export function untrustedExpressions(script) {
  const out = [];
  for (const m of expressionSpans(script)) {
    let fields;
    try {
      fields = flowingFields(parseExpr(m.body));
    } catch {
      const hit = UNTRUSTED.exec(m.body);
      fields = hit ? [hit[0].toLowerCase()] : [];
    }
    if (fields.length) out.push({ expression: m.expression, field: fields[0], fields, index: m.index });
  }
  return out;
}

/** A shell-safe variable name for a field: github.event.pull_request.title becomes PR_TITLE. */
export function envNameFor(field) {
  // Index and filter segments (commits[0], commits['0'], commits.*) name nothing: dropped.
  const parts = String(field).replace(/\[[^\]]*\]/g, '').split('.').filter((p) => p && p !== '*' && !/^\d+$/.test(p));
  const last = parts.slice(-2).join('_').replace(/^pull_request_/, 'PR_').replace(/^github_/, '');
  const name = last.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  // A shell variable starts with a letter or an underscore.
  return /^[A-Z_]/.test(name) ? name : `VALUE${name ? `_${name}` : ''}`;
}

/** The script language of a run step: posix for bash and sh, pwsh for PowerShell, else null. */
function shellLang(shell, runsOn) {
  if (shell !== undefined && shell !== null) {
    const first = String(shell).trim().split(/\s+/)[0].toLowerCase();
    if (first === 'bash' || first === 'sh') return 'posix';
    if (first === 'pwsh' || first === 'powershell') return 'pwsh';
    if (first === 'python' || first === 'python3') return 'python';
    if (first === 'cmd') return 'cmd';
    return null; // a custom command or an expression: the language is unknown
  }
  // No shell named: bash on Linux and macOS, pwsh on Windows. Labels that do not say which (an
  // expression, a matrix value, a bare self-hosted) leave it unknown.
  const labels = (Array.isArray(runsOn) ? runsOn : typeof runsOn === 'string' ? [runsOn] : [])
    .filter((l) => typeof l === 'string').map((l) => l.toLowerCase());
  if (!labels.length || labels.some((l) => l.includes('${{'))) return null;
  if (labels.some((l) => l.startsWith('windows'))) return 'pwsh';
  if (labels.some((l) => /^(ubuntu|macos|linux)/.test(l))) return 'posix';
  return null;
}

/**
 * The fix as a pattern, not a rewrite of the step: the expression moved to env and the variable read
 * where it was, in the step's language. Rewriting an arbitrary script safely would take a full
 * parser for bash, PowerShell and JavaScript and knowledge of every command's options, so the
 * example shows the shape and leaves the command to the person who knows what it does.
 */
function patternExample(x) {
  const name = envNameFor(x.field);
  const head = `# the pattern, not a drop-in edit: the expression moves to env, the script reads the variable\n- name: ${JSON.stringify(x.step)}\n  env:\n    ${name}: ${JSON.stringify(x.expression)}\n`;
  const read = {
    js: `  with:\n    script: |\n      // read process.env.${name} where the expression was`,
    pwsh: `  run: |\n    # read $env:${name} where the expression was, e.g. Write-Host $env:${name}`,
    posix: `  run: |\n    # read "$${name}" (in double quotes) where the expression was, e.g. echo "$${name}"`,
    python: `  run: |\n    # read os.environ["${name}"] where the expression was (import os)`,
  }[x.lang];
  // cmd expands %VAR% before it parses the line, so a variable is no safer there: no example, and
  // the fix says to move the step to bash or pwsh. An unknown shell (a matrix OS, a custom
  // command) gets the env entry and the forms for the shells it could be, said as such.
  if (x.lang === 'cmd') return '';
  if (!read) return `${head}  run: |\n    # read the variable as this step's shell does: "$${name}" in bash, $env:${name} in PowerShell`;
  return head + read;
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
      const scripts = [];
      if (st.run !== undefined) {
        const shell = st.shell ?? job.defaults?.run?.shell ?? doc.defaults?.run?.shell;
        scripts.push({ script: st.run, lang: shellLang(shell, job['runs-on']) });
      }
      if (/^actions\/github-script@/.test(String(st.uses || '')) && st.with && typeof st.with === 'object') {
        scripts.push({ script: st.with.script, lang: 'js' });
      }
      for (const sc of scripts) {
        for (const hit of untrustedExpressions(sc.script)) injections.push({ job: id, step, lang: sc.lang, ...hit });
      }
    });
  }
  // The job token: write-all anywhere is a grant of everything; no permissions block at the top and
  // none on a job leaves that job the repository's default, which the audit cannot read (read-only
  // for repositories created since February 2023, write on many older ones).
  const isWriteAll = (p) => typeof p === 'string' && p.trim().toLowerCase() === 'write-all';
  // A reusable-workflow call with no permissions of its own passes the caller's token on: the called
  // workflow can narrow it, but the audit does not read that workflow, so the call counts as
  // unscoped like any other job.
  const jobs = jobsOf(doc);
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
    F.push({
      saving: 0, unit: 'risk', confidence: 'confirmed', what: 'untrusted input in a script',
      workflow: where([...new Set(injections.map((x) => x.path))]),
      evidence: `${list(injections.map((x) => `${x.path} job ${x.job}, ${x.step}: ${x.expression}`), 4)}; the expression is pasted into the script before it runs, so a title, branch name or comment written as shell code runs as shell code`,
      fix: 'pass the value through an environment variable and read the variable, quoted, where the expression was ("$VAR" in bash, $env:VAR in PowerShell, process.env.VAR in github-script, os.environ in python), so the shell reads it as data. '
        + (injections.some((x) => x.lang === 'cmd') ? 'cmd expands %VAR% before it parses the line, so a variable is no safer there: run that step in bash or pwsh. ' : '')
        + 'The variable is only data while nothing parses it again: not inside a command string (bash -c, eval, ssh, a github-script exec), a program (awk, sed, jq), or an option that runs a program (tar --checkpoint-action, git --upload-pack). '
        + 'Written to $GITHUB_ENV or $GITHUB_OUTPUT, a newline in it sets another variable: write it with a random multiline delimiter (NAME<<DELIM … DELIM). Never write it to $GITHUB_PATH, which takes one path per line and has no delimiter: every line would join PATH. '
        + 'Where it is a command\'s argument, put -- before it so a leading dash is not read as an option',
      tradeoff: 'none to speak of: the step reads the same value, and only the shell no longer executes it',
      example: patternExample(injections.find((x) => x.lang !== 'cmd') || injections[0]),
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
