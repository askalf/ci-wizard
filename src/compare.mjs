// The method's fourth step: measure again after a change and compare. Takes two audit results
// (the JSON the CLI writes with --json) and reports, per workflow, the before, the after and the
// change of each measurement, then the findings that disappeared and the ones that appeared.
import { fmtS, round } from './util.mjs';
import { cell } from './report.mjs';

/** The measurements compared, with how each is shown. Times are seconds; the rest are counts or minutes. */
export const METRICS = [
  { key: 'runs_week', label: 'Runs/week', digits: 0 },
  { key: 'job_minutes_per_run', label: 'Job-min/run', digits: 1 },
  { key: 'job_minutes_week', label: 'Job-min/week', digits: 0 },
  { key: 'wall_p50', label: 'Developer wait p50', time: true },
  { key: 'wall_p90', label: 'Developer wait p90', time: true },
  { key: 'wait_p50', label: 'Queue p50', time: true },
  { key: 'wait_p90', label: 'Queue p90', time: true },
  { key: 'tail_p50', label: 'Tail p50', time: true },
];

// Kinds the audit reports once per repository (grouped across workflows, or repository-wide):
// their workflow text lists the workflows, which changes between runs, so they match by kind.
const REPO_WIDE = new Set(['self-hosted wrap-up tail', 'toolchain setup', 'queue wait', 'reruns', 'many small scheduled jobs']);
const findingKey = (f) => (REPO_WIDE.has(f.what) ? f.what : `${f.what}\u0000${f.workflow}`);

function show(m, v) {
  if (v === undefined || v === null) return '-';
  return m.time ? fmtS(v) : v.toFixed(m.digits);
}

function change(m, before, after) {
  if (before === undefined || after === undefined) return '-';
  const d = after - before;
  const sign = d > 0 ? '+' : d < 0 ? '-' : '';
  const abs = Math.abs(d);
  const amount = m.time ? (abs < 120 ? `${Math.round(abs)} s` : `${(abs / 60).toFixed(1)} min`) : abs.toFixed(m.digits);
  const percent = before > 0 ? ` (${sign}${Math.round((abs / before) * 100)}%)` : '';
  return d === 0 ? 'no change' : `${sign}${amount}${percent}`;
}

/** The comparison as data: workflows in both, in only one, and findings gone and new. */
export function compareData(before, after) {
  const afterByName = new Map(after.workflows.map((w) => [w.workflow, w]));
  const beforeNames = new Set(before.workflows.map((w) => w.workflow));
  const both = before.workflows.filter((w) => afterByName.has(w.workflow)).map((b) => {
    const a = afterByName.get(b.workflow);
    return {
      workflow: b.workflow,
      metrics: METRICS.map((m) => ({ ...m, before: b[m.key], after: a[m.key], delta: a[m.key] !== undefined && b[m.key] !== undefined ? round(a[m.key] - b[m.key], 2) : null })),
    };
  });
  const afterKeys = new Set(after.findings.map(findingKey));
  const beforeKeys = new Set(before.findings.map(findingKey));
  return {
    repos: [before.repo, after.repo],
    sameRepo: before.repo === after.repo,
    windows: [{ days: before.covered_days, runs: before.runs_total }, { days: after.covered_days, runs: after.runs_total }],
    both,
    onlyBefore: before.workflows.filter((w) => !afterByName.has(w.workflow)).map((w) => w.workflow),
    onlyAfter: after.workflows.filter((w) => !beforeNames.has(w.workflow)).map((w) => w.workflow),
    gone: before.findings.filter((f) => !afterKeys.has(findingKey(f))),
    appeared: after.findings.filter((f) => !beforeKeys.has(findingKey(f))),
    totals: { before: before.job_minutes_week_sampled, after: after.job_minutes_week_sampled },
  };
}

/** The comparison as markdown. */
export function compare(before, after) {
  const c = compareData(before, after);
  const L = [];
  L.push(`# CI comparison: ${c.sameRepo ? before.repo : `${before.repo} against ${after.repo}`}`, '');
  if (!c.sameRepo) L.push('These two reports are of different repositories, so the changes below compare two codebases, not a before and after.', '');
  L.push(`Before: ${c.windows[0].runs} runs over ${c.windows[0].days} days. After: ${c.windows[1].runs} runs over ${c.windows[1].days} days. Weekly figures in each are scaled to 7 days, so windows of different lengths compare, but a short window is noisier.`, '');
  const tm = { digits: 0 };
  L.push(`Sampled workflows: ${Math.round(c.totals.before)} job-minutes a week before, ${Math.round(c.totals.after)} after: ${change(tm, c.totals.before, c.totals.after)}.`, '');
  for (const w of c.both) {
    L.push(`## ${w.workflow}`, '');
    L.push('| Measure | Before | After | Change |', '| --- | --- | --- | --- |');
    for (const m of w.metrics) L.push(`| ${m.label} | ${show(m, m.before)} | ${show(m, m.after)} | ${change(m, m.before, m.after)} |`);
    L.push('');
  }
  if (c.onlyBefore.length) L.push(`Sampled only before: ${c.onlyBefore.map(cell).join(', ')}.`, '');
  if (c.onlyAfter.length) L.push(`Sampled only after: ${c.onlyAfter.map(cell).join(', ')}.`, '');
  L.push('## Findings', '');
  if (!c.gone.length && !c.appeared.length) L.push('The same findings before and after.');
  for (const f of c.gone) L.push(`- Gone: **${f.what}** in *${f.workflow}* (was about ${Math.round(f.saving_min_week)} job-min/week, estimate).`);
  for (const f of c.appeared) L.push(`- New: **${f.what}** in *${f.workflow}*: ${f.evidence}.`);
  L.push('', 'A finding that is gone is the change working, or the window no longer holding the pattern: check the runs before calling it fixed.');
  return `${L.join('\n')}\n`;
}
