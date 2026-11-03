// The markdown report: where the time goes, what to fix first, and how every number was measured.
// Wording rules: a saving is always called an estimate, every finding carries its evidence and
// its confidence, and a fix is written as an option with its trade-off.
import { fmtS } from './util.mjs';

const CONF = { confirmed: 'confirmed by the workflow file', inferred: 'cause inferred', measured: 'measured' };

// Backslashes first, then pipes: escaping the pipe alone turns `A\|B` into `A\\|B`, an escaped
// backslash followed by a column break.
export const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function shareText(w, n = 3) {
  return Object.entries(w.share).slice(0, n).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ');
}

export function savingText(f) {
  return f.saving_min_week >= 1 ? `about ${Math.round(f.saving_min_week)} job-min/week (estimate)` : 'saving: developer wait, not job minutes';
}

export function report(a, { maxFindings = 8 } = {}) {
  const L = [];
  L.push(`# CI audit: ${a.repo}`, '');
  L.push(`Read-only, from GitHub's Actions API: ${a.runs_total} workflow runs over ${a.covered_days} days, the busiest workflows sampled job by job. Weekly figures scale the sampled window to 7 days. Savings are estimates, labelled with the evidence they come from.`, '');
  L.push('## What to fix first', '');
  if (!a.findings.length) L.push('Nothing crossed the thresholds in this sample.');
  a.findings.slice(0, maxFindings).forEach((f, i) => {
    L.push(`${i + 1}. **${f.what}** in *${f.workflow}* (${CONF[f.confidence] || f.confidence}): ${f.evidence}. ${savingText(f)}.  `);
    L.push(`   Fix: ${f.fix}.`);
  });
  L.push('', '## Where the time goes', '');
  L.push('| Workflow | Runs/week | Jobs/run | Job-min/run | Job-min/week | Developer wait p50 / p90 | Queue p50 / p90 | Biggest shares |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const w of a.workflows) {
    L.push(`| ${cell(w.workflow)} | ${Math.round(w.runs_week)} | ${w.jobs_per_run.toFixed(1)} | ${w.job_minutes_per_run.toFixed(1)} | ${Math.round(w.job_minutes_week)} | ${fmtS(w.wall_p50)} / ${fmtS(w.wall_p90)} | ${Math.round(w.wait_p50)} s / ${Math.round(w.wait_p90)} s | ${shareText(w)} |`);
  }
  L.push('', `Sampled workflows total about **${Math.round(a.job_minutes_week_sampled)} job-minutes a week**. Developer wait is a successful run's wall time, start to finish.`, '');
  L.push('### The longest steps', '');
  for (const w of a.workflows.slice(0, 4)) {
    if (!w.top_steps.length) continue;
    const steps = w.top_steps.map((t) => `${t.step} ${fmtS(t.median_s)}`).join('; ');
    const facts = [w.has_cache ? 'caches dependencies' : 'no dependency cache found in the workflow file', w.cancels ? 'cancels outdated runs' : 'no cancel-in-progress'];
    L.push(`- *${w.workflow}* (\`${w.path}\`): ${steps}. Workflow file: ${facts.join(', ')}.`);
  }
  L.push('', '## How it was measured', '');
  L.push('- Job time = completed minus started; queue wait = started minus created; developer wait = a successful run\'s wall time. All from the Actions API, in whole seconds.');
  L.push('- Steps grouped into runner overhead, checkout, toolchain, dependencies, cache, artifacts, docker and work, by the command the workflow file gives each step (its run or uses line) and otherwise by its name; time before the first step and after the last step counted separately.');
  L.push('- Duplicate runs = commits the workflow ran on both a push and a pull request event. Reruns = runs with a run attempt above 1. Outdated runs = a pull request run still going when a newer commit on the same branch started its run.');
  L.push("- Cache and concurrency facts are read from the workflow file itself (actions/cache, a setup action's cache input, concurrency and cancel-in-progress).");
  L.push('- Estimated savings: dependency cache 60% of install time when no cache runs, 30% when one runs but installs still dominate; checkout and toolchain 50%; duplicates, outdated runs and reruns their full job time; self-hosted tail the excess over 2 s; fixed-cost findings half of the fixed share. See docs/rules.md in the ci-wizard repository.');
  return `${L.join('\n')}\n`;
}
