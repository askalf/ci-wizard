// Security scans of every workflow file, the checks a supply-chain review starts with: actions
// pinned to something that can move, untrusted event text pasted into a shell, and a job token with
// more power than the job needs. Each reads the parsed file, so a commented-out line never counts,
// and each finding names the file, job and step it found.
import { parseWorkflow } from './workflow.mjs';
import { parseExpr } from './expr.mjs';
import { stringify } from 'yaml';

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

// Context property names are case-insensitive in expressions (github.event.issue.TITLE is the
// title), so paths are matched in lower case.
const UNTRUSTED_FULL = new RegExp(`^(?:${UNTRUSTED.source})$`, 'i');

// Objects that hold an untrusted field: toJSON(github.event) or ${{ github.event.pull_request }}
// carries the title and body into the script as surely as the field itself.
const CONTAINERS = new Set([
  'github', 'github.event', 'github.event.issue', 'github.event.pull_request', 'github.event.pull_request.head',
  'github.event.pull_request.head.repo', 'github.event.discussion', 'github.event.comment', 'github.event.review',
  'github.event.review_comment', 'github.event.pages', 'github.event.commits', 'github.event.head_commit',
  'github.event.head_commit.author', 'github.event.workflow_run', 'github.event.workflow_run.head_commit',
  'github.event.workflow_run.head_commit.author',
]);

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
    return node.key.k === 'lit' && typeof node.key.v === 'string' ? `${base}.${node.key.v}` : `${base}[${node.key.k === 'lit' ? node.key.v : '*'}]`;
  }
  return null;
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
      if (spelled === null) return [];
      const path = spelled.toLowerCase();
      const norm = path.replace(/\[[^\]]*\]/g, '.*').replace(/\.\*\.\*/g, '.*');
      if (UNTRUSTED_FULL.test(path) || UNTRUSTED_FULL.test(norm)) return [path];
      if (CONTAINERS.has(path)) return [path];
      return [];
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
  for (const m of String(script ?? '').matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    let fields;
    try {
      fields = flowingFields(parseExpr(m[1]));
    } catch {
      const hit = UNTRUSTED.exec(m[1]);
      fields = hit ? [hit[0].toLowerCase()] : [];
    }
    if (fields.length) out.push({ expression: m[0], field: fields[0], fields, index: m.index });
  }
  return out;
}

/** A shell-safe variable name for a field: github.event.pull_request.title becomes PR_TITLE. */
export function envNameFor(field) {
  const parts = String(field).replace(/\[[^\]]*\]|\.\*/g, '').split('.');
  const last = parts.slice(-2).join('_').replace(/^pull_request_/, 'PR_').replace(/^github_/, '');
  return last.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

/**
 * The quote context at each expression of a script, for the languages the rewrite handles. Other
 * expressions are skipped as opaque text (they are what gets replaced). Returns a function from an
 * expression's offset to 'none' | 'subst' | 'double' | 'single' | 'template', or null where the
 * script is too intricate to say with certainty (a heredoc, a backtick substitution, arithmetic, a
 * nested template), so no rewrite is offered rather than one that changes what the script does.
 */
function quoteContexts(script, lang, spans) {
  const at = new Map(spans.map((sp) => [sp.start, sp]));
  const states = new Map();
  const stack = ['none'];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < script.length) {
    const sp = at.get(i);
    if (sp) {
      states.set(i, top());
      i = sp.end;
      continue;
    }
    const c = script[i];
    const two = script.slice(i, i + 2);
    const t = top();
    if (lang === 'posix') {
      if (t === 'single') { if (c === "'") stack.pop(); i += 1; continue; }
      if (c === '\\') { i += 2; continue; }
      if (c === '`' || two === '<<' || script.startsWith('$((', i)) return null;
      if (t === 'double') {
        if (c === '"') stack.pop();
        else if (two === '$(') { stack.push('subst'); i += 2; continue; }
        i += 1;
        continue;
      }
      // At the top level or inside $( ): a fresh quoting context.
      if (c === "'") stack.push('single');
      else if (c === '"') stack.push('double');
      else if (two === '$(') { stack.push('subst'); i += 2; continue; }
      else if (c === '(' && t === 'subst') return null; // a subshell or case pattern inside $( )
      else if (c === ')' && t === 'subst') stack.pop();
      i += 1;
      continue;
    }
    if (lang === 'pwsh') {
      if (t === 'single') {
        if (c === "'") { if (script[i + 1] === "'") { i += 2; continue; } stack.pop(); }
        i += 1;
        continue;
      }
      if (c === '`') { i += 2; continue; }
      if (two === '@"' || two === "@'" || two === '$(') return null; // here-strings, subexpressions
      if (t === 'double') { if (c === '"') stack.pop(); i += 1; continue; }
      if (c === "'") stack.push('single');
      else if (c === '"') stack.push('double');
      i += 1;
      continue;
    }
    // JavaScript (actions/github-script)
    if (t === 'single' || t === 'double') {
      if (c === '\\') { i += 2; continue; }
      if (c === (t === 'single' ? "'" : '"')) stack.pop();
      i += 1;
      continue;
    }
    if (t === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (two === '${') return null;
      if (c === '`') stack.pop();
      i += 1;
      continue;
    }
    if (two === '//') { const nl = script.indexOf('\n', i); i = nl < 0 ? script.length : nl; continue; }
    if (two === '/*') { const e = script.indexOf('*/', i + 2); i = e < 0 ? script.length : e + 2; continue; }
    if (c === "'") stack.push('single');
    else if (c === '"') stack.push('double');
    else if (c === '`') stack.push('template');
    i += 1;
  }
  return (offset) => (states.has(offset) ? states.get(offset) : null);
}

/** The script language of a run step: posix for bash and sh, pwsh for PowerShell, else null. */
function shellLang(shell, runsOn) {
  if (shell !== undefined && shell !== null) {
    const first = String(shell).trim().split(/\s+/)[0].toLowerCase();
    if (first === 'bash' || first === 'sh') return 'posix';
    if (first === 'pwsh' || first === 'powershell') return 'pwsh';
    return null; // cmd, python, a custom command or an expression: no rewrite
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

// Commands that parse an argument as code or as a program: a variable expanded into their command
// string reaches that second parser as text, so `bash -c "echo $TITLE"` runs the title as surely as
// the expression did. A step that hands an expression to one of these gets no rewrite: the value
// would have to reach the inner program as data too, which only a person can arrange.
const NESTED = {
  posix: [
    /\b(ba|z|da|k|fi|c|tc)?sh\s+(-[A-Za-z]+\s+)*-[A-Za-z]*c\b/,
    /(^|[\s;&|(`])(eval|source|exec|ssh|su|xargs|awk|gawk|mawk|nawk|sed|jq|yq|envsubst|osascript)\b/,
    /(^|[\s;&|(`])\.\s/,
    /\b(python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|pwsh|powershell|Rscript|lua)\b[^\n]*\s-(c|e|E|r|Command|eval|exec)\b/,
    /\bfind\b[^\n]*\s-exec(dir)?\b/,
    /\bgit\b[^\n]*\s-c\s/,
  ],
  pwsh: [/\b(Invoke-Expression|iex|Invoke-Command|Start-Process|cmd(\.exe)?|bash|sh|wsl|pwsh|powershell|python[0-9.]*|node)\b/i, /\s-(Command|c|e|EncodedCommand)\b/i],
  js: [/\b(eval|Function|exec|execSync|execFile|execFileSync|spawn|spawnSync|execa|execaCommand|runInNewContext|runInThisContext)\s*\(/, /\$`/, /child_process/],
};

/** The logical line holding an offset: backslash continuations joined, so one command is one line. */
function commandLine(script, offset) {
  let start = script.lastIndexOf('\n', offset - 1) + 1;
  while (start > 1 && script[start - 2] === '\\') start = script.lastIndexOf('\n', start - 2) + 1;
  let end = script.indexOf('\n', offset);
  while (end > 0 && script[end - 1] === '\\') end = script.indexOf('\n', end + 1);
  return script.slice(start, end < 0 ? script.length : end);
}

/** Whether an expression at `offset` is handed to a second parser (see NESTED). */
export function nestedInterpreter(script, offset, lang) {
  const text = lang === 'js' ? script : commandLine(script, offset);
  return (NESTED[lang] || []).some((re) => re.test(text));
}

/** How a script reads environment variable `name` in a quote context, or null where it cannot. */
function reference(lang, ctx, name) {
  const table = lang === 'posix'
    ? { none: `"$${name}"`, subst: `"$${name}"`, double: `\${${name}}`, single: `'"$${name}"'` }
    : lang === 'pwsh'
      ? { none: `\${env:${name}}`, double: `\${env:${name}}` }
      : { none: `process.env.${name}`, template: `\${process.env.${name}}`, single: `' + process.env.${name} + '`, double: `" + process.env.${name} + "` };
  return table[ctx] ?? null;
}

/**
 * The step rewritten so each untrusted expression in its script reaches it through an environment
 * variable: the command, the step's other settings and its existing env stay as they are. Returns
 * YAML for the step, or '' when no rewrite can be made with certainty.
 */
export function rewriteStep(step, { lang, script, field }) {
  if (!lang || typeof script !== 'string') return '';
  const all = [...script.matchAll(/\$\{\{[\s\S]*?\}\}/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const hits = untrustedExpressions(script);
  if (!hits.length) return '';
  if (hits.some((h) => nestedInterpreter(script, h.index, lang))) return '';
  const ctxAt = quoteContexts(script, lang, all);
  if (!ctxAt) return '';
  const env = { ...(step.env && typeof step.env === 'object' ? step.env : {}) };
  const nameOf = new Map();
  for (const h of hits) {
    if (nameOf.has(h.expression)) continue;
    const base = envNameFor(h.field);
    let name = base;
    for (let n = 2; Object.prototype.hasOwnProperty.call(env, name) && env[name] !== h.expression; n += 1) name = `${base}_${n}`;
    env[name] = h.expression;
    nameOf.set(h.expression, name);
  }
  let out = script;
  for (const h of [...hits].sort((a, b) => b.index - a.index)) {
    const ref = reference(lang, ctxAt(h.index), nameOf.get(h.expression));
    if (ref === null) return '';
    out = out.slice(0, h.index) + ref + out.slice(h.index + h.expression.length);
  }
  // A JavaScript string that held only the expression reads better as the bare variable.
  if (lang === 'js') out = out.replace(/(["'])\1 \+ (process\.env\.\w+) \+ \1\1/g, '$2');
  if (lang === 'posix') out = out.replace(/''("\$\w+")''/g, '$1');
  const rewritten = {};
  let placed = false;
  for (const [k, v] of Object.entries(step)) {
    if (k === 'env') { rewritten.env = env; placed = true; continue; }
    if (!placed && (k === 'with' || k === 'run')) { rewritten.env = env; placed = true; }
    if (k === 'run' && field === 'run') rewritten.run = out;
    else if (k === 'with' && field === 'script') rewritten.with = { ...v, script: out };
    else rewritten[k] = v;
  }
  if (!placed) rewritten.env = env;
  return stringify([rewritten], { lineWidth: 0 }).trimEnd();
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
        scripts.push({ script: st.run, field: 'run', lang: shellLang(shell, job['runs-on']) });
      }
      if (/^actions\/github-script@/.test(String(st.uses || '')) && st.with && typeof st.with === 'object') {
        scripts.push({ script: st.with.script, field: 'script', lang: 'js' });
      }
      for (const sc of scripts) {
        const hits = untrustedExpressions(sc.script);
        if (!hits.length) continue;
        const example = rewriteStep(st, sc);
        for (const hit of hits) injections.push({ job: id, step, ...hit, example, nested: Boolean(sc.lang && typeof sc.script === 'string' && nestedInterpreter(sc.script, hit.index, sc.lang)) });
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
      fix: 'pass the value through an environment variable and quote it in the script, so it is read as data and never parsed as code'
        + (injections.some((x) => x.nested)
          ? `. ${injections.filter((x) => x.nested).length === injections.length ? 'Here the' : 'Where the'} script hands the value to a second parser (bash -c, eval, ssh, awk, sed, jq, a github-script exec), the variable must reach that parser as data too: let the inner program read it from the environment itself (bash -c 'echo "$TITLE"', in single quotes) or pass it as a separate argument (jq --arg), never expand it into the command or program text`
          : ''),
      tradeoff: 'none to speak of: the step reads the same value, and only the shell no longer executes it',
      // The first step that can be rewritten with certainty, as it stands with only its expressions
      // moved to env; none when no step can (a cmd or python shell, a heredoc, a matrix OS).
      example: (injections.find((x) => x.example) || {}).example || '',
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
