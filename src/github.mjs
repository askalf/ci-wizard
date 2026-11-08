// A small GitHub REST client: GET only, because an audit never writes. It retries a 5xx or a
// network error twice with a short backoff, answers a 404 as null, and sends no request once the
// token has minRemaining calls or fewer left (RateLimitError says how many were left and when the
// limit resets), so an audit always leaves that reserve for the repository's own CI.

/** Where a larger budget comes from, for a stop near the limit. */
export const RATE_LIMIT_HINT = "a GitHub App's installation token has its own budget of 5,000 or more an hour, against a workflow's GITHUB_TOKEN's 1,000 (the README's \"Rate limits\" section)";

export class RateLimitError extends Error {
  constructor(remaining, resetAt, limit = null) {
    const when = resetAt ? ` (resets at ${resetAt.toISOString()})` : '';
    const of = limit ? ` of ${limit} an hour` : '';
    super(`stopped near the GitHub API rate limit: ${remaining} calls left${of}${when}; ${RATE_LIMIT_HINT}`);
    this.name = 'RateLimitError';
    this.remaining = remaining;
    this.resetAt = resetAt;
    this.limit = limit;
  }
}

export class NotFoundError extends Error {
  constructor(repo) {
    super(`${repo} was not found, or the token cannot read it`);
    this.name = 'NotFoundError';
    this.repo = repo;
  }
}

export class GitHubError extends Error {
  constructor(status, path, message) {
    super(`GitHub API ${status} on ${path}${message ? `: ${message}` : ''}`);
    this.name = 'GitHubError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A response body as text, no more than max bytes of it: a hostile or broken server cannot make
 * the audit hold an unbounded answer in memory (a workflow file can be 100 MB through the contents
 * API; none that matters is more than a few).
 */
async function readCapped(res, max, path) {
  return (await readCappedBytes(res, max, path)).toString('utf8');
}

/** The same, as the bytes themselves (an artifact's zip is read for its directory, not as text). */
async function readCappedBytes(res, max, path) {
  const tooLarge = () => new GitHubError('answer too large', path, `more than ${Math.round(max / 1048576)} MB`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!res.body || typeof res.body.getReader !== 'function') {
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > max) throw tooLarge();
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
}

/**
 * @param {object} o
 * @param {string} [o.token] a token with actions:read and contents:read on the repository
 * @param {typeof fetch} [o.fetchImpl]
 * @param {string} [o.baseUrl]
 * @param {number} [o.minRemaining] calls always left for others: no request is sent once the token has this many or fewer
 * @param {number} [o.timeoutMs] each attempt's deadline, the body included (30 s)
 * @param {number} [o.maxBytes] the largest answer read (20 MB); a larger one is an error
 * @param {number} [o.concurrency] requests in flight at once (6)
 * @param {number[]} [o.backoffMs] wait before each retry
 */
/**
 * The API the token belongs to: GITHUB_API_URL, which the runner sets (https://api.github.com on
 * github.com, the server's own API on GitHub Enterprise Server or GHE.com), else github.com's.
 * Only an https URL is taken: the token is sent to it.
 */
export function apiBase(env = {}) {
  const raw = String(env.GITHUB_API_URL || '').trim();
  if (!raw) return 'https://api.github.com';
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`GITHUB_API_URL is not a URL: ${raw}`);
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error(`GITHUB_API_URL must be a plain https URL: ${raw}`);
  return u.href.replace(/\/+$/, '');
}

export function createClient({ token, fetchImpl = globalThis.fetch, baseUrl = 'https://api.github.com', minRemaining = 25, backoffMs = [1000, 3000], timeoutMs = 30000, maxBytes = 20 * 1048576, concurrency = 6 } = {}) {
  if (!/^https:\/\/[^/?#@\s]+(\/[^?#\s]*)?$/.test(String(baseUrl))) throw new Error(`the API base must be an https URL: ${baseUrl}`);
  // Anything else would leave queued requests waiting forever (0 slots, or NaN that no count passes).
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`concurrency must be a whole number of 1 or more: ${concurrency}`);
  let calls = 0;
  let remaining = null;
  // When the count's hour resets (x-ratelimit-reset): answers can arrive out of order, so within
  // one hour the lowest count seen stands, and only a later reset raises it again.
  let hourResetsAt = null;
  // Requests sent and not yet answered. Each will cost one call, so the reserve is checked against
  // the count less these: several requests in flight together cannot spend the calls kept for the
  // repository's own CI.
  let inFlight = 0;
  // At most `concurrency` requests at once: the audit's calls are independent reads, and GitHub
  // asks clients not to send many at the same moment.
  // Until the first answer arrives the budget is unknown, so one request goes alone: six sent
  // blind could spend calls the reserve keeps. After it, the full concurrency applies (and with no
  // count reported at all, the reserve cannot be enforced, as the report says).
  let active = 0;
  let probed = false;
  const waiting = [];
  const cap = () => (probed ? concurrency : 1);
  const acquire = () => (active < cap() ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => {
    active--;
    while (waiting.length && active < cap()) {
      active++;
      waiting.shift()();
    }
  };
  // The token's hourly budget as GitHub reports it (x-ratelimit-limit): 1,000 for a workflow's
  // GITHUB_TOKEN, 5,000 for a person's token, 5,000 or more for a GitHub App installation, 60 with
  // no token. It says which budget an audit drew on, and so whether a larger one is available.
  let limit = null;

  async function request(path, { raw = false, redirect = false } = {}) {
    const headers = {
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ci-wizard',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `${baseUrl}/${path.replace(/^\//, '')}`;
    for (let attempt = 0; ; attempt++) {
      // Checked before every attempt, retries included: a request is only sent while more than
      // minRemaining calls are left, and costs one, so the audit always leaves at least
      // minRemaining for the repository's own CI.
      if (remaining !== null && remaining - inFlight <= minRemaining) throw new RateLimitError(remaining - inFlight, null, limit);
      let res;
      inFlight++;
      try {
        calls++;
        // Each attempt has its own deadline, the body's reading included, so a server that stops
        // answering cannot hold the audit (and, in the action, the runner) indefinitely.
        res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), ...(redirect ? { redirect: 'manual' } : {}) });
      } catch (err) {
        inFlight--;
        // No answer means no new count, but GitHub may have received and charged the request: count
        // it as spent, so the reserve check before a retry never works from a stale, higher number.
        if (remaining !== null) remaining -= 1;
        if (attempt < backoffMs.length) {
          await sleep(backoffMs[attempt]);
          continue;
        }
        throw new GitHubError('network', path, err && err.message);
      }
      inFlight--;
      const left = res.headers.get('x-ratelimit-remaining');
      const resetHeader = Number(res.headers.get('x-ratelimit-reset'));
      // An answer with a count replaces ours, unless it is older news: within the same hour the
      // lower count stands (another answer may have come back first). An answer without one (or
      // with one that is not a number) was still charged, so it counts as spent.
      const hasReset = Number.isFinite(resetHeader) && resetHeader > 0;
      if (left !== null && Number.isFinite(Number(left))) {
        const n = Number(left);
        if (hasReset && hourResetsAt !== null && resetHeader < hourResetsAt) {
          // A count from an hour that has already reset says nothing about this one: ignored.
        } else {
          const newHour = hasReset && (hourResetsAt === null || resetHeader > hourResetsAt);
          if (newHour) hourResetsAt = resetHeader;
          remaining = remaining === null || newHour ? n : Math.min(remaining, n);
        }
      } else if (remaining !== null) remaining -= 1;
      const cap = res.headers.get('x-ratelimit-limit');
      if (cap !== null && Number.isFinite(Number(cap))) limit = Number(cap);
      const reset = res.headers.get('x-ratelimit-reset');
      const resetAt = reset ? new Date(Number(reset) * 1000) : null;
      if (res.status === 404) return null;
      // An endpoint that answers with a redirect to a file (a job's log): the file's address is the
      // answer, and the file itself is not read here.
      if (redirect && (res.status === 301 || res.status === 302 || res.status === 307)) return res.headers.get('location');
      if ((res.status === 403 || res.status === 429) && (remaining === 0 || res.headers.get('retry-after'))) {
        throw new RateLimitError(remaining ?? 0, resetAt, limit);
      }
      if (res.status >= 500 && attempt < backoffMs.length) {
        await sleep(backoffMs[attempt]);
        continue;
      }
      if (!res.ok) {
        let msg = '';
        try {
          // The error body is capped like any answer: a large one adds nothing to the message.
          msg = String(JSON.parse(await readCapped(res, Math.min(maxBytes, 65536), path)).message || '').slice(0, 300);
        } catch {
          // a body that is not JSON, or too large, adds nothing to the error
        }
        throw new GitHubError(res.status, path, msg);
      }
      // An answer that brings the token down to minRemaining is still returned; the next attempt stops.
      let text;
      try {
        text = await readCapped(res, maxBytes, path);
      } catch (err) {
        if (err instanceof GitHubError) throw err;
        throw new GitHubError('network', path, `the answer stopped arriving (${err && err.message})`);
      }
      if (raw) return text;
      try {
        return JSON.parse(text);
      } catch {
        throw new GitHubError(res.status, path, 'the answer is not JSON');
      }
    }
  }

  async function limited(path, opts) {
    await acquire();
    try {
      return await request(path, opts);
    } finally {
      probed = true;
      release();
    }
  }

  /**
   * The size in bytes of the file an endpoint redirects to (a job's log), from a HEAD of the file's
   * address; null when there is no redirect, no size, or the file's host does not answer. The
   * redirect costs one API call; the HEAD goes to the file's host, outside the API and its budget,
   * and carries no token.
   */
  async function sizeOf(path) {
    const location = await limited(path, { redirect: true });
    if (typeof location !== 'string' || !/^https:\/\//.test(location)) return null;
    try {
      const head = await fetchImpl(location, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
      const raw = head.headers.get('content-length');
      if (raw === null) return null; // no length is no size, not an empty log
      const n = Number(raw);
      return head.ok && Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * The file an endpoint redirects to (a job's log, an artifact's zip), read in full up to `max`
   * bytes: as text, or as bytes with `bytes: true`. Null when there is no redirect, the file's host
   * does not answer, or the file is larger than `max`: a file too large to read is no evidence,
   * not an error. The redirect costs one API call; the file comes from its host, outside the API
   * and its budget, and the request carries no token.
   */
  async function fileOf(path, { bytes = false, max = maxBytes } = {}) {
    const location = await limited(path, { redirect: true });
    if (typeof location !== 'string' || !/^https:\/\//.test(location)) return null;
    try {
      const res = await fetchImpl(location, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return bytes ? await readCappedBytes(res, max, path) : await readCapped(res, max, path);
    } catch {
      return null;
    }
  }

  return {
    get: (path) => limited(path),
    getRaw: (path) => limited(path, { raw: true }),
    sizeOf,
    fileOf,
    get calls() {
      return calls;
    },
    get remaining() {
      return remaining;
    },
    get limit() {
      return limit;
    },
  };
}
