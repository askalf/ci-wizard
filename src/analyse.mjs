// Turns collected runs, jobs and workflow files into per-workflow measurements and ranked
// findings. Each finding carries its evidence, a confidence (confirmed: the workflow file shows
// the cause; measured: the numbers show it; inferred: the cause is a likely reading), an
// estimated weekly saving, and a fix written as an option with its trade-off. docs/rules.md
// documents every rule, its threshold and its estimate.
import { concurrencyGroupOf, categoryOf, parseWorkflow, pushBranchesOf, stepCommands, triggersOf, workflowFacts } from './workflow.mjs';
import { countBy, fmtS, median, pct, round, secs, sum } from './util.mjs';

export const THRESHOLDS = {
  depsPerJobNoCache: 15,
  depsShareWithCache: 0.25,
  depsPerJobWithCache: 45,
  checkoutPerJob: 12,
  toolchainPerJob: 15,
  duplicateCommitsWeek: 3,
  supersededWeek: 2,
  matrixJobs: 8,
  matrixJobMinutes: 5,
  selfHostedTail: 4,
  queueP90: 30,
  shortJobsCount: 6,
  fanOutRunsWeek: 500,
  periodicCount: 3,
};

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);
// Kinds reported once per repository, listing the workflows, when they repeat.
const GROUPED = new Set(['self-hosted wrap-up tail', 'toolchain setup', 'queue wait']);

function ranOnGitHubHosted(job) {
  const runner = String(job.runner_name || '').toLowerCase();
  const labels = (job.labels || []).join(' ').toLowerCase();
  return runner.includes('github actions') || labels.includes('ubuntu-') || labels.includes('windows-') || labels.includes('macos-');
}

/**
 * Times every sampled job: its length, its queue wait, the time before its first step and after
 * its last, and the seconds its steps spent in each category. A step the API reports as a cache
 * step also counts as a cache, whatever the file says.
 */
export function timeJobs(sampledRuns, commands) {
  const t = {
    secondsByCategory: {}, workStepSeconds: new Map(), jobSecondsPerRun: [], queueWaits: [], tails: [], heads: [],
    jobLengths: [], stepsPerJob: [], hostedJobs: 0, jobCount: 0, sawCacheStep: false,
  };
  for (const jobs of sampledRuns) {
    let runSeconds = 0;
    for (const job of jobs) {
      t.jobCount++;
      const length = secs(job.started_at, job.completed_at);
      runSeconds += length;
      t.jobLengths.push(length);
      t.queueWaits.push(secs(job.created_at, job.started_at));
      if (ranOnGitHubHosted(job)) t.hostedJobs++;
      const steps = (job.steps || []).filter((s) => s.started_at && s.completed_at);
      t.stepsPerJob.push(steps.length);
      for (const step of steps) {
        const kind = categoryOf(step.name, commands);
        const seconds = secs(step.started_at, step.completed_at);
        t.secondsByCategory[kind] = (t.secondsByCategory[kind] || 0) + seconds;
        if (kind === 'cache') t.sawCacheStep = true;
        if (kind === 'work') {
          const name = String(step.name).replace(/\s+/g, ' ').slice(0, 60);
          if (!t.workStepSeconds.has(name)) t.workStepSeconds.set(name, []);
          t.workStepSeconds.get(name).push(seconds);
        }
      }
      if (steps.length) {
        const firstStart = steps.map((s) => s.started_at).sort()[0];
        const lastEnd = steps.map((s) => s.completed_at).sort().at(-1);
        t.heads.push(secs(job.started_at, firstStart));
        t.tails.push(secs(lastEnd, job.completed_at));
      }
    }
    t.jobSecondsPerRun.push(runSeconds);
  }
  return t;
}

/** Each category's share of all measured time, including the time before and after the steps, largest first. */
export function timeShares(timing) {
  const total = sum(Object.values(timing.secondsByCategory)) + sum(timing.tails) + sum(timing.heads);
  const shares = {};
  for (const [kind, seconds] of Object.entries(timing.secondsByCategory)) shares[kind] = total ? seconds / total : 0;
  shares.tail = total ? sum(timing.tails) / total : 0;
  shares.head = total ? sum(timing.heads) / total : 0;
  return shares;
}

/** Commits this workflow ran for on both a push and a pull request event. */
export function duplicateCommits(workflowRuns) {
  const eventsByCommit = new Map();
  for (const r of workflowRuns) {
    if (!eventsByCommit.has(r.head_sha)) eventsByCommit.set(r.head_sha, new Set());
    eventsByCommit.get(r.head_sha).add(r.event);
  }
  return [...eventsByCommit.values()].filter((events) => events.has('push') && (events.has('pull_request') || events.has('pull_request_target'))).length;
}

/** Pull request runs still going when a newer commit on the same branch started its run, and not cancelled. */
export function outdatedRuns(workflowRuns) {
  const runsByBranch = new Map();
  for (const r of workflowRuns) {
    if (!PR_EVENTS.has(r.event) || !r.run_started_at) continue;
    if (!runsByBranch.has(r.head_branch)) runsByBranch.set(r.head_branch, []);
    runsByBranch.get(r.head_branch).push(r);
  }
  let outdated = 0;
  for (const branchRuns of runsByBranch.values()) {
    branchRuns.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (let i = 0; i + 1 < branchRuns.length; i++) {
      const older = branchRuns[i];
      const newer = branchRuns[i + 1];
      if (older.head_sha !== newer.head_sha && Date.parse(newer.created_at) < Date.parse(older.updated_at) && older.conclusion !== 'cancelled') outdated++;
    }
  }
  return outdated;
}

/** The three longest work steps by median, ties broken by name then by how often each was seen. */
export function longestSteps(workStepSeconds) {
  return [...workStepSeconds.entries()]
    .map(([step, seconds]) => ({ step, median_s: median(seconds), seen: seconds.length }))
    .sort((a, b) => b.median_s - a.median_s || (a.step < b.step ? 1 : a.step > b.step ? -1 : 0) || b.seen - a.seen)
    .slice(0, 3)
    .map((s) => ({ ...s, median_s: Math.round(s.median_s) }));
}

/** Measures one workflow from its runs, its sampled jobs and its file. */
export function measureWorkflow(workflowName, workflowRuns, sampledRuns, fileText, weekFactor) {
  const doc = parseWorkflow(fileText);
  const facts = workflowFacts(doc);
  const timing = timeJobs(sampledRuns, stepCommands(doc));
  const shares = timeShares(timing);
  const sampledCount = sampledRuns.length;
  const medianRunSeconds = median(timing.jobSecondsPerRun);
  const successfulWalls = workflowRuns
    .filter((r) => r.status === 'completed' && r.conclusion === 'success' && r.run_started_at)
    .map((r) => secs(r.run_started_at, r.updated_at));
  const reruns = workflowRuns.filter((r) => (r.run_attempt || 1) > 1).length;
  const failures = workflowRuns.filter((r) => r.conclusion === 'failure').length;
  const perWeek = (n) => round(n * weekFactor, 1);
  return {
    workflow: workflowName,
    path: String(workflowRuns[0].path || '').split('@')[0],
    runs_week: perWeek(workflowRuns.length),
    sampled_runs: sampledCount,
    jobs_per_run: round(timing.jobCount / sampledCount, 1),
    job_minutes_per_run: round(medianRunSeconds / 60, 2),
    job_minutes_week: round((workflowRuns.length * weekFactor * medianRunSeconds) / 60, 1),
    wait_p50: pct(timing.queueWaits, 0.5),
    wait_p90: pct(timing.queueWaits, 0.9),
    tail_p50: pct(timing.tails, 0.5),
    hosted_share: timing.jobCount ? round(timing.hostedJobs / timing.jobCount, 2) : 0,
    steps_per_job: median(timing.stepsPerJob),
    share: Object.fromEntries(Object.entries(shares).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, round(v, 3)])),
    cats_secs_per_run: Object.fromEntries(Object.entries(timing.secondsByCategory).map(([k, v]) => [k, round(v / sampledCount, 1)])),
    has_cache: facts.hasCache || timing.sawCacheStep,
    reruns_week: perWeek(reruns),
    failed_week: perWeek(failures),
    dup_commits_week: perWeek(duplicateCommits(workflowRuns)),
    wall_p50: pct(successfulWalls, 0.5),
    wall_p90: pct(successfulWalls, 0.9),
    superseded_week: perWeek(outdatedRuns(workflowRuns)),
    has_concurrency: facts.hasConcurrency,
    cancels: facts.cancels,
    top_steps: longestSteps(timing.workStepSeconds),
    longest_job_s: timing.jobLengths.length ? Math.max(...timing.jobLengths) : 0,
    median_job_s: median(timing.jobLengths),
    reruns_raw: reruns,
    npm_install_no_ci: facts.npmInstallNoCi,
    prefer_offline: facts.preferOffline,
    caches_node_modules: facts.cachesNodeModules,
    setup_cache: facts.setupCache,
    dep_share: round(shares.deps || 0, 3),
    triggers: triggersOf(doc),
    push_branches: pushBranchesOf(doc),
    concurrency_group: concurrencyGroupOf(doc),
    events: countBy(workflowRuns, (r) => r.event),
    fixed_share: round((shares.overhead || 0) + (shares.head || 0) + (shares.tail || 0) + (shares.checkout || 0), 3),
  };
}

const T = THRESHOLDS;

/** The per-workflow rules. Each returns findings as { saving, workflow, what, evidence, fix, confidence }. */
export function workflowFindings(w, { lockKey, hasLock }) {
  const F = [];
  const add = (saving, what, evidence, fix, confidence = 'measured') => F.push({ saving, workflow: w.workflow, what, evidence, fix, confidence });
  const perRun = w.cats_secs_per_run;
  const jobs = Math.max(1, w.jobs_per_run);

  const deps = perRun.deps || 0;
  const depsJob = deps / jobs;
  if (depsJob >= T.depsPerJobNoCache && !w.has_cache) {
    add(0.6 * deps * w.runs_week / 60, 'cache dependencies',
      `dependency installs take ${fmtS(depsJob)} per job (${fmtS(deps)} per run, ${Math.round(w.dep_share * 100)}% of the workflow's job time) and the workflow file has no dependency cache`,
      `cache the package manager's store with actions/cache ${lockKey}`, 'confirmed');
  } else if (w.has_cache && (w.dep_share >= T.depsShareWithCache || depsJob >= T.depsPerJobWithCache)) {
    let why, fix;
    if (w.npm_install_no_ci && !hasLock && !w.caches_node_modules) {
      why = `dependency installs are ${Math.round(w.dep_share * 100)}% of the workflow's job time (${fmtS(depsJob)} per job) even with setup-node's npm cache: `
        + 'with no lockfile, `npm install` resolves the whole tree from the registry on every job, and the npm cache only saves the tarball downloads';
      fix = 'keep testing the newest dependencies but cut the round trips: `npm install --prefer-offline --no-audit --no-fund`, '
        + 'or cache node_modules keyed on package.json, the runner OS, the Node version and the date, so the tree is resolved once a day per combination';
    } else {
      why = `dependency installs are ${Math.round(w.dep_share * 100)}% of the workflow's job time (${fmtS(depsJob)} per job) with a cache configured`;
      fix = "check the cache hit rate and key in the setup step's log; install only what the job needs (workspace filters, --omit=dev where tests allow)";
    }
    add(0.3 * deps * w.runs_week / 60, 'dependency installs dominate', why, fix, 'confirmed');
  }

  const co = perRun.checkout || 0;
  if (co / jobs >= T.checkoutPerJob) {
    add(0.5 * co * w.runs_week / 60, 'slow checkout', `checkout takes ${fmtS(co / jobs)} per job`,
      'fetch-depth: 1 unless history is needed; sparse-checkout for large monorepos; avoid fetching tags and LFS by default');
  }

  const tc = perRun.toolchain || 0;
  if (tc / jobs >= T.toolchainPerJob) {
    const note = w.setup_cache ? ' (this includes restoring the dependency cache, which the setup step does)' : '';
    add(0.5 * tc * w.runs_week / 60, 'toolchain setup', `toolchain setup takes ${fmtS(tc / jobs)} per job${note}`,
      'use runtime versions the runner image already has, or an image with the toolchain baked in', 'inferred');
  }

  if (w.dup_commits_week >= T.duplicateCommitsWeek) {
    const extra = w.push_branches.filter((b) => b !== 'main' && b !== 'master');
    const cg = w.concurrency_group;
    let why = `${Math.round(w.dup_commits_week)} commits a week run on both push and pull_request`;
    let conf = 'measured';
    if (extra.length) {
      why += `: the push trigger also matches ${extra.slice(0, 6).join(', ')}, so a branch pushed to this repository with an open pull request runs every commit twice`;
      conf = 'confirmed';
    }
    if (cg.includes('event.number') || cg.includes('pull_request.number')) {
      why += `; the concurrency group (${cg}) keys pull requests by number and pushes by commit, so neither run cancels the other`;
    }
    const fix = extra.length
      ? 'drop those patterns from the push trigger if every such branch gets a pull request, or key the concurrency group on the commit for both events '
        + '(for example `${{ github.workflow }}-${{ github.event.pull_request.head.sha || github.sha }}`) so the second run cancels the first'
      : 'run on push only for the default branch and on pull_request for everything else, or share one concurrency group per commit';
    add(w.dup_commits_week * w.job_minutes_per_run, 'the same commit runs twice', why, fix, conf);
  }

  if (w.superseded_week >= T.supersededWeek && !w.cancels) {
    add(w.superseded_week * w.job_minutes_per_run, 'outdated runs keep going',
      `${Math.round(w.superseded_week)} pull request runs a week were still running when a newer push to the same branch started a new run, and the workflow has no cancel-in-progress`,
      'add `concurrency: { group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}, cancel-in-progress: true }` so a new push cancels the outdated run');
  }

  if (w.jobs_per_run >= T.matrixJobs && w.job_minutes_per_run >= T.matrixJobMinutes) {
    add(0, 'matrix size',
      `${Math.round(w.jobs_per_run)} jobs a run, ${Math.round(w.job_minutes_per_run)} job-minutes per run (${Math.round(w.job_minutes_week)} a week); the slowest job takes ${fmtS(w.longest_job_s)} against a median of ${fmtS(w.median_job_s)}`,
      'an option, not a fault: run the full matrix on the default branch and nightly, and a smaller set (newest runtime on each OS, oldest supported) on pull requests');
  }

  if (w.hosted_share < 0.5 && w.tail_p50 >= T.selfHostedTail) {
    add((w.tail_p50 - 2) * w.jobs_per_run * w.runs_week / 60, 'self-hosted wrap-up tail',
      `median ${Math.round(w.tail_p50)} s after the last step before the job reports done (GitHub-hosted is about 2 s)`,
      "fewer steps per job (each step is an uploaded log), and a runner close to GitHub's service region");
  }

  if (w.wait_p90 >= T.queueP90) {
    add(0, 'queue wait', `p90 wait for a runner ${Math.round(w.wait_p90)} s`,
      'more runner capacity at peak, or fewer jobs per event (merge small jobs, skip by changed paths)');
  }

  if (w.jobs_per_run >= T.shortJobsCount && w.job_minutes_per_run / w.jobs_per_run < 1.0) {
    const over = (perRun.overhead || 0) + (perRun.checkout || 0) + (perRun.toolchain || 0) + (perRun.deps || 0);
    add(0.5 * over * w.runs_week / 60, 'many short jobs',
      `${Math.round(w.jobs_per_run)} jobs a run averaging under a minute each, ${fmtS(over)} of setup per run`,
      'merge short jobs that share setup into one job with several steps, or a matrix only where it buys parallel time');
  }
  return F;
}

/** The rules that look across workflows: fan-out, small periodic jobs, reruns. */
export function repoFindings(workflows) {
  const F = [];
  for (const w of workflows) {
    const ev = w.events;
    const chained = (ev.workflow_run || 0) + (ev.schedule || 0) + (ev.repository_dispatch || 0) + (ev.workflow_dispatch || 0);
    const total = sum(Object.values(ev)) || 1;
    if (w.runs_week >= T.fanOutRunsWeek && chained / total >= 0.5) {
      const topEv = Object.entries(ev).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ');
      F.push({
        saving: w.fixed_share * w.job_minutes_week * 0.5, workflow: w.workflow, what: 'runs far more often than code changes',
        evidence: `${Math.round(w.runs_week)} runs a week (${topEv} in the window); ${Math.round(w.fixed_share * 100)}% of its job time is fixed cost (setup, checkout, wrap-up)`,
        fix: 'trigger it from fewer upstream workflows or events, debounce it (one run per commit with a concurrency group and cancel-in-progress), or fold it into the workflow that triggers it',
        confidence: 'measured',
      });
    }
  }
  const periodic = workflows.filter((w) => {
    const ev = w.events;
    return ((ev.schedule || 0) + (ev.workflow_dispatch || 0) + (ev.repository_dispatch || 0)) >= 0.5 * sum(Object.values(ev)) && w.job_minutes_per_run < 0.5;
  });
  if (periodic.length >= T.periodicCount) {
    const fixedMin = sum(periodic.map((w) => w.fixed_share * w.job_minutes_week));
    F.push({
      saving: (fixedMin * (periodic.length - 1)) / periodic.length, workflow: 'scheduled workflows', what: 'many small scheduled jobs',
      evidence: `${periodic.length} periodic workflows (scheduled or dispatched on a clock) each run a job of under 30 s (${periodic.slice(0, 6).map((w) => w.workflow).join(', ')}); each pays its own setup, checkout and wrap-up`,
      fix: 'run them as steps of one scheduled job, or as one job with a step per check, so the fixed cost is paid once per tick',
      confidence: 'measured',
    });
  }
  const reruns = sum(workflows.map((w) => w.reruns_raw));
  if (reruns) {
    F.push({
      saving: sum(workflows.map((w) => w.reruns_week * w.job_minutes_per_run)), workflow: 'all workflows', what: 'reruns',
      evidence: `${reruns} re-attempted run${reruns === 1 ? '' : 's'} in the window across the sampled workflows`,
      fix: 'find the flaky step from the failed attempts and fix or quarantine it; each rerun also costs a developer a wait',
      confidence: 'measured',
    });
  }
  return F;
}

/** One finding per kind where a kind repeats across workflows: the workflows listed, savings summed, the largest one's evidence shown. */
export function groupFindings(F) {
  const grouped = new Map();
  for (const f of [...F].sort((a, b) => b.saving - a.saving)) {
    if (GROUPED.has(f.what)) {
      if (!grouped.has(f.what)) grouped.set(f.what, { ...f, workflows: [] });
      const g = grouped.get(f.what);
      if (g.workflows.length) g.saving += f.saving;
      g.workflows.push(f.workflow);
    } else {
      grouped.set(`${f.what}\u0000${f.workflow}`, { ...f, workflows: [f.workflow] });
    }
  }
  const out = [];
  for (const g of grouped.values()) {
    const wfs = g.workflows;
    const where = wfs.length === 1 ? wfs[0] : `${wfs.length} workflows: ${wfs.slice(0, 5).join(', ')}${wfs.length > 5 ? ' and more' : ''}`;
    const evidence = wfs.length === 1 ? g.evidence : `${g.evidence} (shown for the largest; the same holds in the others)`;
    out.push({ saving: g.saving, workflow: where, what: g.what, evidence, fix: g.fix, confidence: g.confidence });
  }
  return out.sort((a, b) => b.saving - a.saving);
}

/**
 * @param {string} repo
 * @param {Awaited<ReturnType<import('./collect.mjs').collect>>} data
 */
export function analyse(repo, data) {
  const week = 7 / data.coveredDays;
  const hasLock = data.lockfiles.length > 0;
  const lockKey = hasLock
    ? `keyed on ${data.lockfiles[0]}`
    : 'keyed on package.json (the repository commits no lockfile, so the key must come from the manifest)';
  const workflows = [];
  for (const [wf, jobsPerRun] of data.samples) {
    if (!jobsPerRun.length) continue;
    const rs = data.byWf.get(wf);
    const path = String(rs[0].path || '').split('@')[0];
    workflows.push(measureWorkflow(wf, rs, jobsPerRun, data.files.get(path) || '', week));
  }
  workflows.sort((a, b) => b.job_minutes_week - a.job_minutes_week);
  const raw = [...workflows.flatMap((w) => workflowFindings(w, { lockKey, hasLock })), ...repoFindings(workflows)];
  const findings = groupFindings(raw).map((f) => ({
    saving_min_week: round(f.saving, 1), workflow: f.workflow, what: f.what, evidence: f.evidence, fix: f.fix, confidence: f.confidence,
  }));
  return {
    repo,
    covered_days: round(data.coveredDays, 2),
    runs_total: data.runs.length,
    lockfiles: data.lockfiles,
    workflows,
    job_minutes_week_sampled: round(sum(workflows.map((w) => w.job_minutes_week)), 1),
    findings,
  };
}
