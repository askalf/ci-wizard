// ci-wizard [owner/repo | GitHub URL] [--days 7] [--workflows 8] [--per-workflow 5] [--json] [--html out.html] [--save out.json]
// ci-wizard compare before.json after.json
// With no repository, the audit reads the origin remote of the git checkout it runs in.
// The audit prints the markdown report (or the JSON with --json). The token comes from
// GITHUB_TOKEN or GH_TOKEN, or from `gh auth token` when the GitHub CLI is signed in; it needs
// read access to the repository's Actions and contents, and nothing is written. compare reads two
// saved --json reports and needs no token.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { audit, html, NotFoundError, report, RateLimitError, REPO_RE } from './index.mjs';
import { budgetText } from './report.mjs';
import { compare } from './compare.mjs';
import { VERSION } from './version.mjs';

const USAGE = `usage: ci-wizard [owner/repo] [--days 7] [--workflows 8] [--per-workflow 5] [--only NAME] [--json] [--html out.html] [--save out.json]
       ci-wizard compare before.json after.json
       ci-wizard --version

Reads a repository's GitHub Actions runs, jobs and workflow files (read-only) and reports where
the CI time goes and what to fix first. The repository is owner/repo or a GitHub URL; left out,
it is the origin remote of the git checkout in the current directory.
Token: GITHUB_TOKEN or GH_TOKEN, else \`gh auth token\`.

  --days N           days of runs to read (default 7; up to 500 runs are read)
  --workflows N      busiest workflows to time job by job (default 8)
  --per-workflow N   newest successful runs of each to time (default 5)
  --only NAME        time only these workflows, by the name GitHub shows (repeat it, or
                     separate names with commas); for measuring one workflow before and after
  --json             print the report as JSON instead of markdown
  --save FILE        also save the JSON report, as a baseline for compare
  --html FILE        also write the report as an HTML page

The method: audit and --save before.json, make one change, let it run, audit again with
--save after.json, then \`ci-wizard compare before.json after.json\` shows what moved.`;

// The host part of a github.com URL or remote, anchored at the start: "github.com" anywhere else
// in a URL (another host's path, a subdomain of another host) is not GitHub.
const GITHUB_HOST = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[/:]/;

/**
 * owner/repo from what a person is likely to paste: owner/repo, a github.com URL (with or without
 * a path after the repository, or .git), or an SSH remote. Null when it is none of those.
 */
export function parseRepo(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const m = new RegExp(`^(?:${GITHUB_HOST.source.slice(1)})?([A-Za-z0-9_.-]+)\\/([A-Za-z0-9_.-]+?)(?:\\.git)?(?:[/?#].*)?$`).exec(t);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  return REPO_RE.test(repo) ? repo : null;
}

/** owner/repo from a git remote URL, only when the remote's host is github.com. */
export function repoFromRemote(url) {
  return GITHUB_HOST.test(url) ? parseRepo(url) : null;
}

function repoFromGit(cwd) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return repoFromRemote(url);
  } catch {
    return null;
  }
}

function tokenFromEnv(env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try {
    // execFile, no shell: the command line is fixed.
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function positiveNumber(name, v, { integer = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw new Error(`--${name} must be a positive ${integer ? 'integer' : 'number'}, got ${v}`);
  return n;
}

function readReport(path) {
  let a;
  try {
    a = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`);
  }
  // Every workflow and finding must be an object, and every field compare prints must be a plain
  // value: an object there (`{"toString": null}`) cannot be turned into text and would throw.
  const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const plain = (x) => x === null || typeof x !== 'object';
  const ok = object(a) && Array.isArray(a.workflows) && Array.isArray(a.findings)
    && a.workflows.every(object) && a.findings.every(object)
    && ['repo', 'covered_days', 'runs_total', 'job_minutes_week_sampled'].every((k) => plain(a[k]))
    && a.workflows.every((w) => plain(w.workflow))
    && a.findings.every((f) => ['what', 'workflow', 'evidence', 'saving_min_week'].every((k) => plain(f[k])));
  if (!ok) throw new Error(`${path} is not a ci-wizard --json report`);
  return a;
}

function runCompare(paths, { stdout, stderr }) {
  if (paths.length !== 2) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  let before, after;
  try {
    before = readReport(paths[0]);
    after = readReport(paths[1]);
  } catch (err) {
    stderr.write(`ci-wizard: ${err.message}\n`);
    return 1;
  }
  stdout.write(compare(before, after));
  return 0;
}

export async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl, cwd = process.cwd(), token: givenToken } = {}) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        days: { type: 'string', default: '7' },
        workflows: { type: 'string', default: '8' },
        only: { type: 'string', multiple: true, default: [] },
        'per-workflow': { type: 'string', default: '5' },
        json: { type: 'boolean', default: false },
        html: { type: 'string' },
        save: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    stderr.write(`${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals[0] === 'compare') return runCompare(positionals.slice(1), { stdout, stderr });
  if (positionals.length > 1) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  let repo;
  if (positionals.length) {
    repo = parseRepo(positionals[0]);
    if (!repo) {
      stderr.write(`ci-wizard: ${positionals[0]} is not owner/repo or a GitHub repository URL\n\n${USAGE}\n`);
      return 2;
    }
  } else {
    repo = repoFromGit(cwd);
    if (!repo) {
      stderr.write(`ci-wizard: name a repository (owner/repo), or run inside a checkout whose origin is on GitHub\n\n${USAGE}\n`);
      return 2;
    }
    stderr.write(`ci-wizard: auditing ${repo} (the origin of this checkout)\n`);
  }
  let days, workflows, perWorkflow;
  try {
    days = positiveNumber('days', values.days);
    workflows = positiveNumber('workflows', values.workflows, { integer: true });
    perWorkflow = positiveNumber('per-workflow', values['per-workflow'], { integer: true });
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }
  const token = givenToken !== undefined ? givenToken : tokenFromEnv(env);
  if (!token) {
    stderr.write('ci-wizard: no token found (GITHUB_TOKEN, GH_TOKEN or `gh auth login`); unauthenticated calls are limited to 60 an hour, and a private repository reads as not found\n');
  }
  // Progress only on a terminal: a redirected stderr or a CI log gets the one summary line.
  const live = Boolean(stderr.isTTY);
  const onProgress = live ? (msg) => stderr.write(`\r\x1b[Kci-wizard: ${msg}...`) : undefined;
  let a;
  try {
    const only = values.only.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    a = await audit({ repo, token, fetchImpl, days, workflows, perWorkflow, only, onProgress });
  } catch (err) {
    if (live) stderr.write('\r\x1b[K');
    stderr.write(`ci-wizard: ${err.message}\n`);
    if (err instanceof NotFoundError && !token) stderr.write('ci-wizard: with no token only public repositories can be read\n');
    return err instanceof RateLimitError ? 3 : 1;
  }
  if (live) stderr.write('\r\x1b[K');
  if (!a) {
    stderr.write(`ci-wizard: ${repo} has no workflow runs in the last ${days} days\n`);
    return 1;
  }
  if (values.html) writeFileSync(values.html, html([a], { title: `CI audit: ${repo}` }));
  if (values.save) writeFileSync(values.save, `${JSON.stringify(a, null, 1)}\n`);
  stdout.write(values.json ? `${JSON.stringify(a, null, 1)}\n` : report(a));
  const budget = budgetText(a);
  stderr.write(`ci-wizard: ${a.runs_total} runs over ${a.covered_days} d, ${a.workflows.length} workflows sampled, ${a.findings.length} findings, ${budget || `${a.api_calls} API calls`}\n`);
  if (values.save) stderr.write(`ci-wizard: saved ${values.save}; after a change has run a while, save another report and run \`ci-wizard compare ${values.save} <after>.json\`\n`);
  return 0;
}
