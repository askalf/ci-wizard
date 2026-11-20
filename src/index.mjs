// The library: audit a repository, then render the result as markdown or HTML.
import { createClient } from './github.mjs';
import { collect } from './collect.mjs';
import { analyse } from './analyse.mjs';

export { createClient, RateLimitError, GitHubError, NotFoundError } from './github.mjs';
export { collect } from './collect.mjs';
export { analyse, THRESHOLDS } from './analyse.mjs';
export { report } from './report.mjs';
export { html } from './html.mjs';
export { compare, compareData } from './compare.mjs';
export { VERSION } from './version.mjs';

// The most workflow runs an audit reads from its window, and the default. GitHub serves at most 1000
// results for a runs list filtered by date (the `created` filter collect uses), in pages of 100.
export const MAX_RUNS_LIMIT = 1000;
export const MAX_RUNS_DEFAULT = 500;

// owner/name, neither part "." or "..": those would walk the API path to another endpoint.
export const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

/**
 * Audits one repository. Returns null when the window holds no workflow runs.
 * `maxRuns`: the most workflow runs read from the window, a multiple of 100 up to MAX_RUNS_LIMIT. A
 * busy repository fills 500 runs in a day or two; more covers more of it. Each 100 more is one more
 * page of the runs list, and the other calls can rise when the window changes the busiest workflows.
 * @param {{ repo: string, token?: string, fetchImpl?: typeof fetch, days?: number, workflows?: number, perWorkflow?: number, maxRuns?: number, only?: string[], now?: Date, client?: object, onProgress?: (msg: string) => void }} o
 */
export async function audit({ repo, token, fetchImpl, baseUrl, days = 7, workflows = 8, perWorkflow = 5, maxRuns = MAX_RUNS_DEFAULT, only = [], now, client, onProgress } = {}) {
  if (!REPO_RE.test(String(repo))) throw new Error(`not an owner/name repository: ${repo}`);
  if (!Number.isInteger(maxRuns) || maxRuns < 100 || maxRuns > MAX_RUNS_LIMIT || maxRuns % 100 !== 0) {
    throw new Error(`maxRuns must be a multiple of 100 from 100 to ${MAX_RUNS_LIMIT}, got ${maxRuns}`);
  }
  const c = client || createClient({ token, fetchImpl, baseUrl });
  const data = await collect(c, repo, { days, workflows, perWorkflow, only, now, onProgress, maxPages: maxRuns / 100 });
  if (!data) return null;
  const a = analyse(repo, data);
  a.api_calls = c.calls;
  // The budget the audit drew on: the token's hourly limit and what was left after it.
  a.rate_limit = { limit: c.limit ?? null, remaining: c.remaining ?? null };
  return a;
}
