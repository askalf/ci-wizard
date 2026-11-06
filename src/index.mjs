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

// owner/name, neither part "." or "..": those would walk the API path to another endpoint.
export const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

/**
 * Audits one repository. Returns null when the window holds no workflow runs.
 * @param {{ repo: string, token?: string, fetchImpl?: typeof fetch, days?: number, workflows?: number, perWorkflow?: number, only?: string[], now?: Date, client?: object, onProgress?: (msg: string) => void }} o
 */
export async function audit({ repo, token, fetchImpl, baseUrl, days = 7, workflows = 8, perWorkflow = 5, only = [], now, client, onProgress } = {}) {
  if (!REPO_RE.test(String(repo))) throw new Error(`not an owner/name repository: ${repo}`);
  const c = client || createClient({ token, fetchImpl, baseUrl });
  const data = await collect(c, repo, { days, workflows, perWorkflow, only, now, onProgress });
  if (!data) return null;
  const a = analyse(repo, data);
  a.api_calls = c.calls;
  // The budget the audit drew on: the token's hourly limit and what was left after it.
  a.rate_limit = { limit: c.limit ?? null, remaining: c.remaining ?? null };
  return a;
}
