// A small evaluator for GitHub Actions expressions, enough to answer one question exactly: what a
// job's `if` and `runs-on` come to for a pull request from a fork. It parses the expression
// language (literals, context paths, ! == != < <= > >= && || and the common functions) and
// evaluates it against a context. Anything it cannot know (a vars or matrix value, an unknown
// function) is UNKNOWN, and UNKNOWN spreads through what depends on it, so a caller never takes
// an unresolved value for a resolved one.

export const UNKNOWN = Symbol('unknown');

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

const truthy = (v) => v !== UNKNOWN && !(v === false || v === null || v === 0 || v === '' || Number.isNaN(v));
const falsy = (v) => v !== UNKNOWN && !truthy(v);
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
const get = (obj, key) => {
  if (obj === UNKNOWN) return UNKNOWN;
  if (obj === null || typeof obj !== 'object') return null;
  const hit = Object.keys(obj).find((k) => k.toLowerCase() === String(key).toLowerCase());
  return hit === undefined ? UNKNOWN : obj[hit];
};

function call(name, args) {
  if (['always', 'success'].includes(name)) return true;
  if (['failure', 'cancelled'].includes(name)) return false;
  if (args.some((a) => a === UNKNOWN)) return UNKNOWN;
  switch (name) {
    case 'fromjson':
      try { return JSON.parse(String(args[0])); } catch { return UNKNOWN; }
    case 'tojson': return JSON.stringify(args[0]);
    case 'contains':
      return Array.isArray(args[0]) ? args[0].some((x) => lower(x) === lower(args[1])) : String(args[0]).toLowerCase().includes(String(args[1]).toLowerCase());
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
    case 'call': return call(node.name, node.args.map((a) => evaluate(a, ctx)));
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
      const x = lower(a);
      const y = lower(b);
      switch (node.k) {
        case '==': return x === y;
        case '!=': return x !== y;
        case '<': return x < y;
        case '<=': return x <= y;
        case '>': return x > y;
        case '>=': return x >= y;
        default: return UNKNOWN;
      }
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

/** The context of a pull request from a fork of `repo`, as GitHub gives it to the base repository's workflow. */
export function forkPullRequestContext(repo = 'owner/repo', event = 'pull_request') {
  const [owner, name] = String(repo).split('/');
  const pr = {
    head: { repo: { full_name: `contributor/${name || 'repo'}`, fork: true, owner: { login: 'contributor' } }, ref: 'patch', sha: '0'.repeat(40), label: 'contributor:patch' },
    base: { repo: { full_name: repo, fork: false, owner: { login: owner } }, ref: 'main' },
    user: { login: 'contributor' },
    number: 1,
    draft: false,
    author_association: 'CONTRIBUTOR',
  };
  return {
    github: {
      repository: repo, repository_owner: owner, event_name: event, actor: 'contributor', triggering_actor: 'contributor',
      head_ref: 'patch', base_ref: 'main', ref: 'refs/pull/1/merge',
      event: { pull_request: pr, action: 'synchronize', sender: { login: 'contributor' } },
    },
  };
}
