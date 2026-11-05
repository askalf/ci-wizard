// A small GitHub REST client: GET only, because an audit never writes. It retries a 5xx or a
// network error twice with a short backoff, answers a 404 as null, and stops before the token's
// rate limit runs out (RateLimitError says how many calls were left and when the limit resets),
// so an audit never burns the budget a team's own CI needs.

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
 * @param {object} o
 * @param {string} [o.token] a token with actions:read and contents:read on the repository
 * @param {typeof fetch} [o.fetchImpl]
 * @param {string} [o.baseUrl]
 * @param {number} [o.minRemaining] stop when the token has fewer calls left than this
 * @param {number[]} [o.backoffMs] wait before each retry
 */
export function createClient({ token, fetchImpl = globalThis.fetch, baseUrl = 'https://api.github.com', minRemaining = 25, backoffMs = [1000, 3000] } = {}) {
  let calls = 0;
  let remaining = null;
  // The token's hourly budget as GitHub reports it (x-ratelimit-limit): 1,000 for a workflow's
  // GITHUB_TOKEN, 5,000 for a person's token, 5,000 or more for a GitHub App installation, 60 with
  // no token. It says which budget an audit drew on, and so whether a larger one is available.
  let limit = null;

  async function request(path, { raw = false } = {}) {
    if (remaining !== null && remaining < minRemaining) throw new RateLimitError(remaining, null, limit);
    const headers = {
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ci-wizard',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `${baseUrl}/${path.replace(/^\//, '')}`;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        calls++;
        res = await fetchImpl(url, { headers });
      } catch (err) {
        if (attempt < backoffMs.length) {
          await sleep(backoffMs[attempt]);
          continue;
        }
        throw new GitHubError('network', path, err && err.message);
      }
      const left = res.headers.get('x-ratelimit-remaining');
      if (left !== null) remaining = Number(left);
      const cap = res.headers.get('x-ratelimit-limit');
      if (cap !== null && Number.isFinite(Number(cap))) limit = Number(cap);
      const reset = res.headers.get('x-ratelimit-reset');
      const resetAt = reset ? new Date(Number(reset) * 1000) : null;
      if (res.status === 404) return null;
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
          msg = (await res.json()).message || '';
        } catch {
          // a body that is not JSON adds nothing to the error
        }
        throw new GitHubError(res.status, path, msg);
      }
      // An answer that leaves the token under minRemaining is still returned; the next call stops.
      return raw ? res.text() : res.json();
    }
  }

  return {
    get: (path) => request(path),
    getRaw: (path) => request(path, { raw: true }),
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
