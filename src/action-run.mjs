// The GitHub Action: audits a repository (by default the one the workflow runs in), writes the
// markdown report to the job summary and to a file, and sets two outputs. An audit never fails
// the job for what it finds; it fails only when it cannot read what it needs.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit, report, RateLimitError, REPO_RE } from './index.mjs';

/** Inputs as the runner passes them: INPUT_<NAME> with the name upper-cased and spaces as underscores. */
export function input(env, name, fallback = '') {
  const v = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined || v === '' ? fallback : String(v).trim();
}

function setOutput(env, name, value) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function command(stdout, kind, msg) {
  // Workflow commands: the message is escaped so a repository name cannot inject another command.
  const m = String(msg).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  stdout.write(`::${kind}::${m}\n`);
}

export async function run({ env = process.env, stdout = process.stdout, fetchImpl, now } = {}) {
  const repo = input(env, 'repository', env.GITHUB_REPOSITORY || '');
  if (!REPO_RE.test(repo)) {
    command(stdout, 'error', `ci-wizard: the repository input is not owner/name: ${repo}`);
    return 1;
  }
  const days = Number(input(env, 'days', '7'));
  const workflows = Number(input(env, 'workflows', '8'));
  const perWorkflow = Number(input(env, 'per-workflow', '5'));
  for (const [k, v] of [['days', days], ['workflows', workflows], ['per-workflow', perWorkflow]]) {
    if (!Number.isFinite(v) || v <= 0) {
      command(stdout, 'error', `ci-wizard: the ${k} input must be a positive number`);
      return 1;
    }
  }
  const token = input(env, 'token', env.GITHUB_TOKEN || '');
  const dir = join(env.RUNNER_TEMP || '.', 'ci-wizard');
  mkdirSync(dir, { recursive: true });
  const mdPath = join(dir, 'report.md');
  let a;
  try {
    const only = input(env, 'only', '').split(',').map((v) => v.trim()).filter(Boolean);
    a = await audit({ repo, token, fetchImpl, days, workflows: Math.floor(workflows), perWorkflow: Math.floor(perWorkflow), only, now });
  } catch (err) {
    if (err instanceof RateLimitError) {
      command(stdout, 'warning', `ci-wizard: ${err.message}; no report this run`);
      setOutput(env, 'findings', '0');
      return 0;
    }
    command(stdout, 'error', `ci-wizard: ${err.message}. The token needs actions: read and contents: read on ${repo}.`);
    return 1;
  }
  const md = a ? report(a) : `# CI audit: ${repo}\n\nNo workflow runs in the last ${days} days, so there is nothing to measure yet.\n`;
  writeFileSync(mdPath, md);
  if (a) writeFileSync(join(dir, 'report.json'), `${JSON.stringify(a, null, 1)}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  setOutput(env, 'report-path', mdPath);
  setOutput(env, 'findings', String(a ? a.findings.length : 0));
  stdout.write(a ? `ci-wizard: ${a.runs_total} runs over ${a.covered_days} d, ${a.findings.length} findings, ${a.api_calls} API calls; report in the job summary and ${mdPath}\n` : `ci-wizard: no runs in the window for ${repo}\n`);
  return 0;
}
