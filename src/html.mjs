// One self-contained HTML page for one or more audits: verdict tiles, ranked findings, then the
// evidence tables. Every value from GitHub (workflow and step names, file text) is escaped.
import { fmtS } from './util.mjs';
import { savingText, stepLabel } from './report.mjs';

const CONF = { confirmed: ['good', 'confirmed in the workflow file'], measured: ['info', 'measured'], inferred: ['warn', 'cause inferred'] };

export function esc(x) {
  return String(x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Code blocks: escaped like any other text, but without the inline-code rewrite.
const escPre = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v) => typeof v === 'number' && Number.isFinite(v);

function section(a) {
  const id = slug(a.repo);
  const total = a.job_minutes_week_sampled;
  const saves = a.saving_min_week_total ?? a.findings.filter((f) => !f.unit || f.unit === 'job').reduce((s, f) => s + f.saving_min_week, 0);
  // Developer wait only means something for a workflow somebody waits on (push, pull request).
  const waited = a.workflows.find((w) => w.waited_on !== false);
  const tiles = [
    [Math.round(total).toLocaleString('en-US'), 'job-minutes a week', 'busiest workflows, sampled'],
    ...(num(a.billed_minutes_week_sampled) && a.billed_minutes_week_sampled > 0
      ? [[Math.round(a.billed_minutes_week_sampled).toLocaleString('en-US'), 'billed minutes a week', 'GitHub-hosted, each job rounded up']] : []),
    [Math.round(saves).toLocaleString('en-US'), 'job-minutes a week', 'estimated recoverable'],
    [String(a.findings.length), 'findings', 'ranked by estimated saving'],
    [waited ? fmtS(waited.wall_p50) : '-', 'developer wait', waited ? `median run of ${esc(waited.workflow)}` : 'no workflow anyone waits on'],
  ].map(([v, l, s]) => `<div class="tile"><div class="v num">${v}</div><div class="l">${l}</div><div class="s">${s}</div></div>`).join('');
  const finds = a.findings.slice(0, 8).map((f, i) => {
    const [cls, label] = CONF[f.confidence] || ['info', f.confidence];
    const trade = f.tradeoff ? `<p class="trade"><b>Trade-off</b> ${esc(f.tradeoff)}.</p>` : '';
    const example = f.example ? `<pre class="example"><code>${escPre(f.example)}</code></pre>` : '';
    return `<li class="find"><div class="rank num">${i + 1}</div><div class="fbody"><div class="fhead"><h4>${esc(f.what)}</h4><span class="chip ${cls}">${label}</span><span class="save">${esc(savingText(f))}</span></div><div class="where">${esc(f.workflow)}</div><p>${esc(f.evidence)}.</p><p class="fix"><b>Fix</b> ${esc(f.fix)}.</p>${trade}${example}</div></li>`;
  }).join('') || '<li class="find"><div class="fbody"><p>Nothing crossed the thresholds in this sample.</p></div></li>';
  const rows = a.workflows.map((w) => {
    const marks = `${w.thin_sample ? ' <span title="timed from fewer than 3 successful runs">†</span>' : ''}${w.waited_on === false ? ' <span title="runs from a schedule, a dispatch or another workflow: nobody waits on it">‡</span>' : ''}`;
    const wait = w.waited_on === false ? '-' : `${fmtS(w.wall_p50)} / ${fmtS(w.wall_p90)}`;
    const billed = num(w.billed_minutes_week) ? Math.round(w.billed_minutes_week).toLocaleString('en-US') : '-';
    return `<tr><td>${esc(w.workflow)}${marks}</td><td class="n">${Math.round(w.runs_week)}</td><td class="n">${w.job_minutes_per_run.toFixed(1)}</td><td class="n">${Math.round(w.job_minutes_week).toLocaleString('en-US')}</td><td class="n">${billed}</td><td class="n">${wait}</td><td class="n">${Math.round(w.wait_p50)} s / ${Math.round(w.wait_p90)} s</td><td>${Object.entries(w.share || {}).slice(0, 3).map(([k, v]) => `${esc(k)} ${Math.round(v * 100)}%`).join(', ')}</td></tr>`;
  }).join('');
  const steps = a.workflows.slice(0, 4).map((w) => [w, (w.top_steps || []).filter((t) => t.median_s >= 1)]).filter(([, t]) => t.length)
    .map(([w, t]) => `<li><b>${esc(w.workflow)}</b>: ${t.map((x) => `${esc(stepLabel(x.step))} ${fmtS(x.median_s)}`).join('; ')} <span class="muted">(${w.has_cache ? 'caches dependencies' : 'no dependency cache in the workflow file'}, ${w.cancels ? 'cancels outdated runs' : 'no cancel-in-progress'})</span></li>`).join('');
  return `
<section class="repo" id="${id}" aria-labelledby="${id}-h">
  <div class="rhead"><h2 id="${id}-h">${esc(a.repo)}</h2>
  <div class="meta">${a.runs_total} runs over ${a.covered_days} days · ${a.workflows.length} workflows sampled job by job · ${a.api_calls || 0} read-only API calls</div></div>
  <div class="tiles">${tiles}</div>
  <h3>What to fix first</h3>
  <ol class="finds">${finds}</ol>
  <h3>Where the time goes</h3>
  <div class="tbl"><table><thead><tr><th>Workflow</th><th>Runs/wk</th><th>Job-min/run</th><th>Job-min/wk</th><th>Billed min/wk</th><th>Developer wait p50 / p90</th><th>Queue p50 / p90</th><th>Biggest shares</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="legend muted">Billed minutes round each GitHub-hosted job up to a whole minute, as GitHub bills it. Shares: <i>work</i> the job's own steps, <i>deps</i> installs, <i>overhead</i> the runner's set-up and wrap-up steps, <i>head</i> the wait before the first step, <i>tail</i> the time after the last step until the job reports done. † fewer than 3 runs timed. ‡ nobody waits on it (a schedule, a dispatch or another workflow).</p>
  ${steps ? `<h3>The longest steps</h3>\n  <ul class="steps">${steps}</ul>` : ''}
</section>`;
}

const STYLE = `
:root {
  --paper: #f4f6f5; --sheet: #ffffff; --ink: #15201c; --muted: #5a6762; --rule: #d6ddd9;
  --signal: #0f6e5c; --signal-soft: #e1f1ec;
  --good: #1f7a4d; --good-soft: #e3f2ea; --warn: #9a6a00; --warn-soft: #fbf1d9; --info: #2c5a8a; --info-soft: #e5eef8;
  --display: "IBM Plex Sans Condensed", "Arial Narrow", Arial, sans-serif;
  --body: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #0e1412; --sheet: #151d1a; --ink: #e4ebe8; --muted: #98a6a0; --rule: #26312d;
    --signal: #4fc9ae; --signal-soft: #15292a; --good: #5cc795; --good-soft: #15291f;
    --warn: #e2b54a; --warn-soft: #2b2414; --info: #86b4e6; --info-soft: #172433; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #0e1412; --sheet: #151d1a; --ink: #e4ebe8; --muted: #98a6a0; --rule: #26312d;
  --signal: #4fc9ae; --signal-soft: #15292a; --good: #5cc795; --good-soft: #15291f;
  --warn: #e2b54a; --warn-soft: #2b2414; --info: #86b4e6; --info-soft: #172433; color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--paper); color: var(--ink); font: 16px/1.6 var(--body); }
.wrap { max-width: 1080px; margin: 0 auto; padding: 40px 20px 72px; display: grid; gap: 36px; }
header { display: grid; gap: 12px; border-bottom: 3px solid var(--ink); padding-bottom: 20px; }
.eyebrow { font: 500 13px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--signal); }
h1 { font: 700 clamp(30px, 5vw, 44px)/1.05 var(--display); margin: 0; text-wrap: balance; }
h2 { font: 700 28px/1.1 var(--display); margin: 0; }
h3 { font: 600 18px/1.3 var(--display); margin: 8px 0 0; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
h4 { font: 600 18px/1.3 var(--display); margin: 0; }
p { margin: 0; max-width: 72ch; }
.lede { font-size: 18px; color: var(--muted); }
.method { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.method div { background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 12px 14px; font-size: 14.5px; }
.method b { display: block; font: 600 13px/1.4 var(--mono); color: var(--signal); text-transform: uppercase; letter-spacing: .05em; }
nav { display: flex; flex-wrap: wrap; gap: 8px; }
nav a { font: 500 14px/1 var(--mono); color: var(--ink); background: var(--sheet); border: 1px solid var(--rule); border-radius: 999px; padding: 8px 12px; text-decoration: none; }
nav a:hover, nav a:focus-visible { border-color: var(--signal); color: var(--signal); outline: none; }
.repo { display: grid; gap: 14px; border-top: 1px solid var(--rule); padding-top: 28px; }
.rhead { display: grid; gap: 4px; }
.meta { font: 13px/1.4 var(--mono); color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.tile { background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 14px; display: grid; gap: 2px; }
.tile .v { font: 500 26px/1.1 var(--mono); }
.tile .l { font-weight: 600; font-size: 14px; }
.tile .s { font-size: 13px; color: var(--muted); }
.num { font-variant-numeric: tabular-nums; }
.finds { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.find { display: grid; grid-template-columns: 40px 1fr; gap: 12px; background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 14px 16px; }
.find:first-child { border-color: var(--signal); box-shadow: inset 4px 0 0 var(--signal); }
.rank { font: 700 26px/1 var(--display); color: var(--muted); }
.find:first-child .rank { color: var(--signal); }
.fbody { display: grid; gap: 6px; min-width: 0; }
.fhead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; }
.where { font: 13px/1.4 var(--mono); color: var(--muted); }
.save { font: 500 13px/1.4 var(--mono); color: var(--ink); margin-left: auto; }
.save em { font-style: normal; color: var(--muted); }
.fix { border-top: 1px dashed var(--rule); padding-top: 6px; }
.fix b, .trade b { color: var(--signal); margin-right: 6px; }
.trade { color: var(--muted); }
pre.example { margin: 8px 0 0; padding: 10px 12px; background: var(--paper); border: 1px solid var(--rule); border-radius: 6px; overflow-x: auto; }
pre.example code { border: 0; padding: 0; background: none; white-space: pre; overflow-wrap: normal; }
.legend { font-size: 13px; margin-top: 8px; }
.chip { font: 500 12px/1 var(--mono); padding: 4px 8px; border-radius: 999px; white-space: nowrap; }
.chip.good { background: var(--good-soft); color: var(--good); }
.chip.warn { background: var(--warn-soft); color: var(--warn); }
.chip.info { background: var(--info-soft); color: var(--info); }
code { font: 13px/1.4 var(--mono); background: var(--paper); border: 1px solid var(--rule); border-radius: 4px; padding: 1px 4px; overflow-wrap: anywhere; }
.tbl { overflow-x: auto; background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { font: 600 11.5px/1.3 var(--mono); text-transform: uppercase; letter-spacing: .05em; color: var(--muted); background: var(--paper); }
tr:last-child td { border-bottom: 0; }
td.n { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.steps { margin: 0; padding-left: 20px; display: grid; gap: 6px; font-size: 14.5px; max-width: 90ch; }
.muted { color: var(--muted); }
footer { font: 13px/1.6 var(--mono); color: var(--muted); border-top: 1px solid var(--rule); padding-top: 16px; display: grid; gap: 6px; }
@media (max-width: 560px) { .find { grid-template-columns: 1fr; gap: 4px; } .save { margin-left: 0; } }
`;

/** @param {object[]} audits analyse() results, each with api_calls set */
export function html(audits, { title = 'CI Wizard Audit' } = {}) {
  const nav = audits.length > 1 ? `<nav aria-label="Repositories">${audits.map((a) => `<a href="#${slug(a.repo)}">${esc(a.repo)}</a>`).join('')}</nav>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="eyebrow">CI wizard · read-only audit</div>
  <h1>Where the CI time goes, and what to fix first</h1>
  <p class="lede">Audited from GitHub's Actions API alone. Every finding is measured, and where the workflow file shows the cause, it says so. Savings are estimates.</p>
  <div class="method">
    <div><b>1 · Measure</b>Every sampled job's steps, timed from the jobs API. Wait, run, and the time before and after the steps.</div>
    <div><b>2 · Diagnose</b>Time split into setup, checkout, toolchain, dependencies, cache and work, by the command each step runs.</div>
    <div><b>3 · Confirm</b>The workflow file read for the cause: triggers, caches, concurrency, how dependencies install.</div>
    <div><b>4 · Prove</b>A fix is measured the same way before and after. This page is the before.</div>
  </div>
  ${nav}
</header>
${audits.map(section).join('')}
<footer>
  <span>Job time = completed minus started; queue wait = started minus created; developer wait = a successful run's wall time. Weekly figures scale each repository's sampled window to 7 days.</span>
  <span>Estimated savings: dependency cache 60% of install time when no cache runs, 30% when one runs but installs still dominate; checkout and toolchain 50%; duplicates, outdated runs and reruns their full job time; self-hosted tail the excess over 2 s; fixed-cost findings half of the fixed share; short hosted jobs half of the billed minutes above the job-minutes. Nothing is written to any repository.</span>
</footer>
</div>
</body>
</html>
`;
}
