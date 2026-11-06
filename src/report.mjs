// The markdown report: what to start with, what to fix and why, where the time goes, and how
// every number was measured. Wording rules: a saving is always called an estimate, every finding
// carries its evidence and its confidence, and a fix is written as an option with its trade-off.
// Reports saved by older versions lack some fields; every one of them renders without them.
import { fmtS } from './util.mjs';

const CONF = { confirmed: 'confirmed by the workflow file', inferred: 'cause inferred', measured: 'measured' };

// Backslashes first, then pipes: escaping the pipe alone turns `A\|B` into `A\\|B`, an escaped
// backslash followed by a column break.
export const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function shareText(w, n = 3) {
  return Object.entries(w.share || {}).slice(0, n).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ');
}

/** A wait finding saves developer wait; a report from before units existed marks one by a zero saving. */
const isWait = (f) => f.unit === 'wait' || (!f.unit && !(f.saving_min_week >= 1));
const isRisk = (f) => f.unit === 'risk';
const isGuard = (f) => f.unit === 'guard';

export function savingText(f) {
  if (isRisk(f)) return 'a security and stability risk, not minutes';
  if (isGuard(f)) return 'a guard against hung jobs, not minutes';
  if (isWait(f)) return 'saves developer wait, not job minutes';
  const unit = f.unit === 'billed' ? 'billed' : 'job';
  if (!(f.saving_min_week >= 1)) return `under 1 ${unit}-min/week (estimate)`;
  return `about ${Math.round(f.saving_min_week)} ${unit}-min/week (estimate)`;
}

/**
 * A step name as a person reads it: `Run owner/action@<sha or tag>` loses its ref, which says
 * nothing about where the time went and is often a 40-character SHA.
 */
export function stepLabel(name) {
  return String(name).replace(/^(Run |Post Run )?([\w.-]+\/[\w./-]+)@\S+/, (_, run = '', action) => `${run}${action}`);
}

/**
 * The API budget an audit drew on, as one clause: the calls made and what the token had left of its
 * hourly limit, with the App route when the budget is a workflow token's 1,000 or less. Empty when
 * GitHub sent no limit (an old report, or a fake client).
 */
export function budgetText(a) {
  const r = a.rate_limit;
  if (!r || !num(r.limit)) return '';
  // Without a remaining count the limit is all that is known: it is never presented as what is left.
  const left = num(r.remaining) ? `${r.remaining} of ${r.limit} left this hour` : `hourly limit ${r.limit}, remaining not reported`;
  const app = r.limit <= 1000 ? "; a GitHub App's token has its own 5,000 or more" : '';
  return `${num(a.api_calls) ? `${a.api_calls} API calls, ` : ''}${left}${app}`;
}

/** The opening paragraph: what to start with, and what the findings add up to against what was measured. */
export function summary(a) {
  const L = [];
  const risks = a.findings.filter(isRisk);
  const guards = a.findings.filter(isGuard);
  const other = (f) => !isRisk(f) && !isGuard(f);
  const waitOnly = a.findings.filter((f) => other(f) && isWait(f));
  const jobFindings = a.findings.filter((f) => other(f) && !isWait(f) && f.unit !== 'billed');
  const billedFindings = a.findings.filter((f) => other(f) && !isWait(f) && f.unit === 'billed');
  const total = Math.round(a.job_minutes_week_sampled || 0);
  const billed = num(a.billed_minutes_week_sampled) ? Math.round(a.billed_minutes_week_sampled) : null;
  const free = a.visibility === 'public';
  const billedNote = billed !== null && billed > 0
    ? free
      ? ` (${billed} minutes on GitHub-hosted runners as GitHub rounds them, free on a public repository's standard runners)`
      : ` (${billed} billed minutes on GitHub-hosted runners, each job rounded up to a whole minute)`
    : '';
  const usage = `The sampled workflows use about **${total} job-minutes a week**${billedNote}.`;
  if (!a.findings.length) {
    L.push(`${usage} Nothing crossed the thresholds in this sample: no fix is suggested.`);
    return L;
  }
  const top = a.findings[0];
  L.push(`**Start with:** ${top.what} in *${top.workflow}*: ${savingText(top)}.`, '');
  const parts = [];
  if (risks.length) parts.push(`${plural(risks.length, 'finding')} ${risks.length === 1 ? 'is a security risk' : 'are security risks'} to fix before any saving`);
  if (jobFindings.length) {
    const saved = Math.round(a.saving_min_week_total ?? jobFindings.reduce((s, f) => s + f.saving_min_week, 0));
    const share = total > 0 ? ` (${Math.round((100 * saved) / total)}%)` : '';
    parts.push(`${plural(jobFindings.length, 'finding')} would save about ${saved} of them${share}`);
  }
  if (billedFindings.length) {
    const saved = Math.round(billedFindings.reduce((s, f) => s + f.saving_min_week, 0));
    parts.push(`${plural(billedFindings.length, 'finding')} would save about ${saved} billed minutes a week`);
  }
  if (waitOnly.length) parts.push(`${plural(waitOnly.length, 'finding')} would save developer wait rather than minutes`);
  if (guards.length) parts.push(`${plural(guards.length, 'finding')} ${guards.length === 1 ? 'guards' : 'guard'} against hung jobs`);
  const caveat = jobFindings.length || billedFindings.length ? ' Savings are estimates, and fixes can overlap, so they add up to an upper bound.' : '';
  L.push(`${usage} ${parts.join('; ')}.${caveat}`);
  return L;
}

export function report(a, { maxFindings = 8 } = {}) {
  const L = [];
  L.push(`# CI audit: ${a.repo}`, '');
  L.push(...summary(a), '');
  L.push(`Read-only, from GitHub's Actions API: ${a.runs_total} workflow runs over ${a.covered_days} days, and ${a.only && a.only.length ? `the ${plural(a.workflows.length, 'named workflow')}` : `the ${plural(a.workflows.length, 'busiest workflow')}`} timed job by job. Weekly figures scale that window to 7 days.`, '');
  if (a.only && a.only.length) L.push(`Only the workflows named with \`--only\` were timed: ${a.only.join(', ')}. Repository-wide findings look at those alone.`, '');
  if (a.only_missing && a.only_missing.length) L.push(`No runs in the window for ${a.only_missing.join(', ')}: check the workflow's name as GitHub shows it (its \`name:\` line), not its file name.`, '');
  if (a.window_truncated) L.push(`The ${a.runs_total}-run cap was reached, so the window covers ${a.covered_days} days rather than the days asked for; weekly figures are scaled from that shorter window and are noisier.`, '');

  if (a.findings.length) {
    L.push('## What to fix first', '');
    a.findings.slice(0, maxFindings).forEach((f, i) => {
      L.push(`### ${i + 1}. ${f.what}`, '');
      L.push(`**Where:** ${f.workflow}  `);
      L.push(`**Saves** ${savingText(f)} · **Confidence** ${CONF[f.confidence] || f.confidence}  `);
      L.push(`**Why:** ${f.evidence}.  `);
      L.push(`**Fix:** ${f.fix}.${f.tradeoff ? '  ' : ''}`);
      if (f.tradeoff) L.push(`**Trade-off:** ${f.tradeoff}.`);
      if (f.example) L.push('', '```yaml', f.example, '```');
      L.push('');
    });
    if (a.findings.length > maxFindings) L.push(`${plural(a.findings.length - maxFindings, 'smaller finding')} not shown; the JSON report (\`--json\`) lists all of them.`, '');
  }

  L.push('## Where the time goes', '');
  L.push('| Workflow | Runs/week | Job-min/run (typical) | Job-min/week | Billed min/week | Developer wait p50 / p90 | Queue p50 / p90 | Biggest shares |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const w of a.workflows) {
    const marks = `${w.thin_sample ? ' †' : ''}${w.waited_on === false ? ' ‡' : ''}`;
    const wait = w.waited_on === false ? '-' : `${fmtS(w.wall_p50)} / ${fmtS(w.wall_p90)}`;
    const billed = num(w.billed_minutes_week) ? String(Math.round(w.billed_minutes_week)) : '-';
    L.push(`| ${cell(w.workflow)}${marks} | ${Math.round(w.runs_week)} | ${w.job_minutes_per_run.toFixed(1)} | ${Math.round(w.job_minutes_week)} | ${billed} | ${wait} | ${Math.round(w.wait_p50)} s / ${Math.round(w.wait_p90)} s | ${shareText(w)} |`);
  }
  L.push('');
  L.push('- **Job-min/run (typical)** is the median successful run. **Job-min/week** counts every run at what its outcome costs: successes, failures, cancellations and timeouts each at the mean of their own sampled runs.');
  L.push('- **Job-minutes** are the time jobs ran. **Billed minutes** are what GitHub charges for its hosted runners: each job rounded up to a whole minute (self-hosted jobs count 0).'
    + (a.visibility === 'public' ? " This repository is public, so its standard GitHub-hosted runners are free and these minutes cost nothing; they matter for private repositories and larger runners." : ''));
  L.push("- **Developer wait** is a successful run's wall time, start to finish. **Queue** is how long a job waited for a runner.");
  L.push('- **Biggest shares** of job time: *work* is the job\'s own steps (tests, builds, scripts); *deps* dependency installs; *toolchain* runtime setup; *checkout*; *cache* restore and save; *artifacts* uploads and downloads; *overhead* the runner\'s "Set up job" and "Complete job"; *head* the wait before the first step starts; *tail* the time after the last step until the job reports done (log uploads).');
  if (a.workflows.some((w) => w.thin_sample)) L.push('- † Timed from fewer than 3 successful runs in the window, so its per-run figures can be an outlier; a longer `--days` window samples more.');
  if (a.workflows.some((w) => w.waited_on === false)) L.push('- ‡ Runs mostly from a schedule, a dispatch or another workflow: nobody waits on it, so its wall time is not developer wait.');
  L.push('');

  const stepLines = [];
  for (const w of a.workflows.slice(0, 4)) {
    const steps = (w.top_steps || []).filter((t) => t.median_s >= 1).map((t) => `${stepLabel(t.step)} ${fmtS(t.median_s)}`);
    if (!steps.length) continue;
    const facts = [w.has_cache ? 'caches dependencies' : 'no dependency cache', w.cancels ? 'cancels outdated runs' : 'no cancel-in-progress'];
    stepLines.push(`- *${w.workflow}* (\`${w.path}\`): ${steps.join('; ')}. The workflow file: ${facts.join(', ')}.`);
  }
  if (stepLines.length) L.push('### The longest steps (median)', '', ...stepLines, '');

  if (a.findings.length) {
    L.push('## Next step: prove the fix', '');
    L.push('1. Keep this report as the baseline: `ci-wizard owner/repo --save before.json` (the action writes `report.json` beside this report).');
    L.push('2. Make one change, the first finding above, and let it run for a few days.');
    L.push('3. Measure again with `--save after.json` and run `ci-wizard compare before.json after.json`: per workflow, what moved, and which findings are gone.');
    L.push('');
  }
  L.push('## How it was measured', '');
  const budget = budgetText(a);
  // The reserve is enforced against the remaining count GitHub reports; without one the client
  // has nothing to hold it against, and the report says so instead of promising it.
  if (budget) {
    const known = num(a.rate_limit && a.rate_limit.remaining);
    L.push(`- API budget: ${budget}. ${known
      ? "An audit sends no request once the token has 25 calls or fewer left, so it always leaves at least 25 for the repository's own CI."
      : 'GitHub reported no remaining count, so the 25-call reserve an audit normally keeps could not be enforced.'}`);
  }
  L.push("- Job time = completed minus started; queue wait = started minus created; developer wait = a successful run's wall time. All from the Actions API, in whole seconds.");
  const estimated = a.workflows.filter((w) => Object.values(w.cost_by_outcome || {}).some((c) => c.estimated && c.runs_week > 0)).map((w) => w.workflow);
  L.push(`- Weekly cost is a count times a mean, per outcome: successes from the sampled successful runs, and failed, cancelled and timed-out runs from up to two sampled runs of each (\`cost_by_outcome\` in the JSON).${estimated.length ? ` Where an outcome had no sampled run, it is costed like a success: ${estimated.slice(0, 5).join(', ')}${estimated.length > 5 ? ' and more' : ''}.` : ''} Runs that ran no job (skipped, waiting for approval, failed to start) cost nothing.`);
  L.push('- Per-run figures are medians over the sampled successful runs of each workflow; queue and wait percentiles are over the sampled jobs and runs, so a p90 over a handful of them is close to the slowest one.');
  L.push('- Billed minutes round each GitHub-hosted job up to a whole minute, as GitHub bills it; a job counts as GitHub-hosted when its runner group is "GitHub Actions".');
  L.push('- Steps grouped into the categories above by the command the workflow file gives each step (its run or uses line) and otherwise by its name.');
  L.push('- Runs whose jobs were all skipped count as runs but cost no job-minutes. Duplicate runs = commits the workflow ran on both a push and a pull request event. Reruns = runs with a run attempt above 1. Outdated runs = a pull request run still going when a newer commit on the same branch started its run.');
  L.push("- Cache, checkout and concurrency facts are read from the parsed workflow file (actions/cache, a setup action's cache input, the checkout step's inputs, concurrency and cancel-in-progress), so a commented-out line never counts.");
  L.push('- Estimated savings: dependency cache 60% of install time when no cache runs, 30% when one runs but installs still dominate; checkout and toolchain 50%; duplicates, outdated runs and reruns their full job time; self-hosted tail the excess over 2 s; fixed-cost findings half of the fixed share; short hosted jobs half of the billed minutes above the job-minutes. See docs/rules.md in the ci-wizard repository.');
  return `${L.join('\n')}\n`;
}
