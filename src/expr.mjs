// A small evaluator for GitHub Actions expressions, enough to answer one question exactly: what a
// job's `if` and `runs-on` come to for a pull request from a fork. It parses the expression
// language (literals, context paths, ! == != < <= > >= && || and the common functions) and
// evaluates it against a context. Anything it cannot know (a vars or matrix value, an unknown
// function) is UNKNOWN, and UNKNOWN spreads through what depends on it, so a caller never takes
// an unresolved value for a resolved one.

export const UNKNOWN = Symbol('unknown');

/**
 * A context object whose absent properties are null, as GitHub gives them, rather than unknown.
 * A test context of a push sets it; the fork context leaves request-dependent fields absent, and
 * so unknown.
 */
export const COMPLETE = Symbol('complete');

/**
 * A value known only to differ from some others: a fork's full name differs from the base
 * repository's, and nothing else about it is known. Truthy (a full name is never empty); equal to
 * none of `differsFrom`; anything else about it is unknown.
 */
export function opaque(differsFrom = []) {
  return { [OPAQUE]: true, differsFrom: differsFrom.map((v) => String(v).toLowerCase()) };
}
const OPAQUE = Symbol('opaque');

/** Where a job's status functions read whether it has dependencies: ctx[STATUS] = { hasNeeds }. */
export const STATUS = Symbol('status');
const isOpaque = (v) => Boolean(v && typeof v === 'object' && v[OPAQUE]);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) throw new Error('unterminated string');
        if (src[j] === "'") {
          if (src[j + 1] === "'") { s += "'"; j += 2; continue; }
          break;
        }
        s += src[j++];
      }
      tokens.push({ t: 'lit', v: s });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if ('!<>()[].,'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue; }
    const num = /^-?(0x[0-9a-f]+|\d+(\.\d+)?(e[+-]?\d+)?)/i.exec(src.slice(i));
    if (num && (c === '-' || /\d/.test(c))) { tokens.push({ t: 'lit', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (id) {
      const w = id[0];
      if (w === 'true' || w === 'false') tokens.push({ t: 'lit', v: w === 'true' });
      else if (w === 'null') tokens.push({ t: 'lit', v: null });
      else tokens.push({ t: 'id', v: w });
      i += w.length;
      continue;
    }
    if (c === '*') { tokens.push({ t: 'op', v: '*' }); i++; continue; }
    throw new Error(`unexpected ${c}`);
  }
  return tokens;
}

/** Parses an expression into a small tree. Throws on what it cannot parse. */
export function parseExpr(src) {
  const tokens = tokenize(src);
  let p = 0;
  const peek = (v) => tokens[p] && tokens[p].t === 'op' && tokens[p].v === v;
  const eat = (v) => {
    if (!peek(v)) throw new Error(`expected ${v}`);
    p++;
  };
  function or() {
    let left = and();
    while (peek('||')) { p++; left = { k: '||', a: left, b: and() }; }
    return left;
  }
  function and() {
    let left = cmp();
    while (peek('&&')) { p++; left = { k: '&&', a: left, b: cmp() }; }
    return left;
  }
  function cmp() {
    const left = unary();
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) {
      if (peek(op)) { p++; return { k: op, a: left, b: unary() }; }
    }
    return left;
  }
  function unary() {
    if (peek('!')) { p++; return { k: '!', a: unary() }; }
    return postfix(primary());
  }
  function primary() {
    const tok = tokens[p++];
    if (!tok) throw new Error('unexpected end');
    if (tok.t === 'lit') return { k: 'lit', v: tok.v };
    if (tok.t === 'op' && tok.v === '(') {
      const e = or();
      eat(')');
      return e;
    }
    if (tok.t === 'id') {
      if (peek('(')) {
        p++;
        const args = [];
        if (!peek(')')) {
          args.push(or());
          while (peek(',')) { p++; args.push(or()); }
        }
        eat(')');
        return { k: 'call', name: tok.v.toLowerCase(), args };
      }
      return { k: 'ctx', path: [tok.v] };
    }
    throw new Error(`unexpected ${tok.v}`);
  }
  function postfix(node) {
    for (;;) {
      if (peek('.')) {
        p++;
        const tok = tokens[p++];
        if (!tok || (tok.t !== 'id' && !(tok.t === 'op' && tok.v === '*'))) throw new Error('expected a property');
        node = { k: 'prop', of: node, key: tok.v };
      } else if (peek('[')) {
        p++;
        const key = or();
        eat(']');
        node = { k: 'index', of: node, key };
      } else return node;
    }
  }
  const tree = or();
  if (p !== tokens.length) throw new Error('trailing input');
  return tree;
}

const truthy = (v) => v !== UNKNOWN && (isOpaque(v) || !(v === false || v === null || v === 0 || v === '' || Number.isNaN(v)));
const falsy = (v) => v !== UNKNOWN && !truthy(v);
const get = (obj, key) => {
  if (obj === UNKNOWN || isOpaque(obj)) return UNKNOWN;
  if (obj === null || typeof obj !== 'object') return null;
  const hit = Object.keys(obj).find((k) => k.toLowerCase() === String(key).toLowerCase());
  if (hit !== undefined) return obj[hit];
  return obj[COMPLETE] ? null : UNKNOWN;
};

/** GitHub's number coercion for comparisons of different types: null 0, booleans 1 and 0, strings parsed, others NaN. */
function toNumber(v) {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return 0;
    const n = /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : Number(t);
    return Number.isNaN(n) ? NaN : n;
  }
  return NaN;
}

/**
 * A comparison as GitHub makes it: same types compare directly (strings ignoring case), different
 * types as numbers (NaN compares false), objects and arrays only by identity. An opaque value is
 * unequal to what it is known to differ from, and unknown against anything else.
 */
function compare(op, a, b) {
  if (isOpaque(a) || isOpaque(b)) {
    const [o, other] = isOpaque(a) ? [a, b] : [b, a];
    if (typeof other === 'string' && o.differsFrom.includes(other.toLowerCase()) && (op === '==' || op === '!=')) return op === '!=';
    return UNKNOWN;
  }
  let x = a;
  let y = b;
  if (typeof x === 'string' && typeof y === 'string') {
    x = x.toLowerCase();
    y = y.toLowerCase();
  } else if (typeof x !== typeof y || (typeof x === 'object' && x !== null) || (typeof y === 'object' && y !== null)) {
    if ((typeof x === 'object' && x !== null) || (typeof y === 'object' && y !== null)) {
      if (op === '==') return x === y;
      if (op === '!=') return x !== y;
      return false;
    }
    x = toNumber(x);
    y = toNumber(y);
    if (Number.isNaN(x) || Number.isNaN(y)) return op === '!=';
  }
  switch (op) {
    case '==': return x === y;
    case '!=': return x !== y;
    case '<': return x < y;
    case '<=': return x <= y;
    case '>': return x > y;
    case '>=': return x >= y;
    default: return UNKNOWN;
  }
}

function call(name, args, ctx) {
  // Status functions: always() is always true. A job with no dependencies starts in success, so
  // success() is true and failure() false there; with dependencies, or for cancelled() (the run can
  // be cancelled at any time), the outcome is not known from the file.
  if (name === 'always') return true;
  if (name === 'success' || name === 'failure') {
    const status = ctx && ctx[STATUS];
    if (status && status.hasNeeds === false) return name === 'success';
    return UNKNOWN;
  }
  if (name === 'cancelled') return UNKNOWN;
  if (args.some((a) => a === UNKNOWN || isOpaque(a))) return UNKNOWN;
  switch (name) {
    case 'fromjson':
      try { return JSON.parse(String(args[0])); } catch { return UNKNOWN; }
    case 'tojson': return JSON.stringify(args[0]);
    case 'contains':
      return Array.isArray(args[0]) ? args[0].some((x) => compare('==', x, args[1]) === true) : String(args[0]).toLowerCase().includes(String(args[1]).toLowerCase());
    case 'startswith': return String(args[0]).toLowerCase().startsWith(String(args[1]).toLowerCase());
    case 'endswith': return String(args[0]).toLowerCase().endsWith(String(args[1]).toLowerCase());
    case 'format': return String(args[0]).replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n) + 1] ?? ''));
    default: return UNKNOWN;
  }
}

/** Evaluates a parsed expression against a context; UNKNOWN where the answer cannot be known. */
export function evaluate(node, ctx) {
  switch (node.k) {
    case 'lit': return node.v;
    case 'ctx': return get(ctx, node.path[0]);
    case 'prop': return get(evaluate(node.of, ctx), node.key);
    case 'index': {
      const key = evaluate(node.key, ctx);
      return key === UNKNOWN ? UNKNOWN : get(evaluate(node.of, ctx), key);
    }
    case 'call': return call(node.name, node.args.map((a) => evaluate(a, ctx)), ctx);
    case '!': {
      const v = evaluate(node.a, ctx);
      return v === UNKNOWN ? UNKNOWN : !truthy(v);
    }
    case '&&': {
      const a = evaluate(node.a, ctx);
      if (falsy(a)) return a;
      const b = evaluate(node.b, ctx);
      if (a === UNKNOWN) return falsy(b) ? b : UNKNOWN;
      return b;
    }
    case '||': {
      const a = evaluate(node.a, ctx);
      if (truthy(a)) return a;
      const b = evaluate(node.b, ctx);
      // An unknown left side could be the answer itself or fall through to b: not knowable.
      if (a === UNKNOWN) return UNKNOWN;
      return b;
    }
    default: {
      const a = evaluate(node.a, ctx);
      const b = evaluate(node.b, ctx);
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      return compare(node.k, a, b);
    }
  }
}

/**
 * The value of a workflow field for a context: a plain value as it is (arrays element by element),
 * a `${{ }}` string evaluated, an `if` (which may omit the braces) evaluated as an expression.
 * UNKNOWN when it cannot be parsed or resolved.
 */
export function valueOf(field, ctx, { isIf = false } = {}) {
  if (field === undefined) return undefined;
  if (Array.isArray(field)) return field.map((f) => valueOf(f, ctx));
  if (field && typeof field === 'object') return Object.fromEntries(Object.entries(field).map(([k, v]) => [k, valueOf(v, ctx)]));
  if (typeof field !== 'string') return field;
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(field);
  if (whole || isIf) {
    try {
      return evaluate(parseExpr(whole ? whole[1] : field), ctx);
    } catch {
      return UNKNOWN;
    }
  }
  // A string with expressions inside other text is an interpolation; any part we cannot resolve
  // leaves the whole unknown.
  if (field.includes('${{')) {
    let unknown = false;
    const out = field.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => {
      let v;
      try { v = evaluate(parseExpr(e), ctx); } catch { v = UNKNOWN; }
      if (v === UNKNOWN) unknown = true;
      return v === UNKNOWN ? '' : String(v ?? '');
    });
    return unknown ? UNKNOWN : out;
  }
  return field;
}

/**
 * The context every pull request from a fork of `repo` shares, and nothing more: the event, the
 * base repository, and a head repository that is a fork and is not the base. Whatever differs from
 * one fork's pull request to the next (the action, branches, author, number, draft state, the
 * fork's own name) is left out, and so unknown.
 */
export function forkPullRequestContext(repo = 'owner/repo', event = 'pull_request', { hasNeeds } = {}) {
  const [owner] = String(repo).split('/');
  const pr = {
    head: { repo: { full_name: opaque([repo]), fork: true, owner: { login: opaque([owner]) } } },
    base: { repo: { full_name: repo, fork: false, owner: { login: owner } } },
  };
  return {
    [STATUS]: { hasNeeds },
    github: { repository: repo, repository_owner: owner, event_name: event, event: { pull_request: pr } },
  };
}

/** A fully known context, for testing what an expression does on other events: absent fields are null. */
export function completeContext(github) {
  const mark = (o) => {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      o[COMPLETE] = true;
      Object.values(o).forEach(mark);
    }
    return o;
  };
  return mark({ github });
}
