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

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Audits one repository. Returns null when the window holds no workflow runs.
 * @param {{ repo: string, token?: string, fetchImpl?: typeof fetch, days?: number, workflows?: number, perWorkflow?: number, now?: Date, client?: object }} o
 */
export async function audit({ repo, token, fetchImpl, days = 7, workflows = 8, perWorkflow = 5, now, client } = {}) {
  if (!REPO_RE.test(String(repo))) throw new Error(`not an owner/name repository: ${repo}`);
  const c = client || createClient({ token, fetchImpl });
  const data = await collect(c, repo, { days, workflows, perWorkflow, now });
  if (!data) return null;
  const a = analyse(repo, data);
  a.api_calls = c.calls;
  return a;
}
