// Turns collected runs, jobs and workflow files into per-workflow measurements and ranked
// findings. Each finding carries its evidence, a confidence (confirmed: the workflow file shows
// the cause; measured: the numbers show it; inferred: the cause is a likely reading), an
// estimated weekly saving, and a fix written as an option with its trade-off. docs/rules.md
// documents every rule, its threshold and its estimate.
import { concurrencyGroupOf, categoryOf, forkReachableSelfHosted, allJobTimeouts, assignJobRuns, parseWorkflow, pushBranchesOf, stepCommands, triggersOf, withParseCache, workflowFacts } from './workflow.mjs';
import { countBy, fmtS, mean, median, pct, round, secs, sum } from './util.mjs';
import { scanFindings } from './scans.mjs';
import { gateFindings } from './gates.mjs';
import { CANCEL_OUTDATED, ONE_RUN_PER_COMMIT, cacheExample, checkoutAdvice, forkGuardExample, managerOf, triggerExample } from './advice.mjs';

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
  thinSample: 3,
  billedRatio: 2,
  billedExcessWeek: 30,
  minSavingWeek: 1,
  // A timeout this many times a job's longest sampled run leaves room for a slow day; one more than
  // timeoutLoose times it, or GitHub's default, protects nothing.
  timeoutFactor: 3,
  timeoutLoose: 10,
  timeoutFloorMin: 10,
};

// How each run conclusion is costed. Success, failure, cancelled and timed_out are timed from
// their own sampled runs; a conclusion with no run sampled is costed like a success and marked as
// an estimate. Runs that never ran a job cost nothing: skipped, waiting for approval, failed to
// start, stale. Anything else (in progress, neutral) is costed like a success.
const TIMED_OUTCOMES = ['failure', 'cancelled', 'timed_out'];
const NO_JOB_OUTCOMES = new Set(['skipped', 'action_required', 'startup_failure', 'stale']);

// Events a person waits on: a push or a pull request is someone waiting for a check. A schedule,
// a dispatch or a workflow_run is not, so its wall time is not developer wait.
const WAITED_ON = new Set(['push', 'pull_request', 'pull_request_target', 'merge_group']);

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);
// Kinds reported once per repository, listing the workflows, when they repeat.
const GROUPED = new Set(['self-hosted wrap-up tail', 'toolchain setup', 'queue wait', 'short hosted jobs bill a whole minute']);
// What a grouped finding measures, said once before each workflow's own figure (its brief).
const GROUP_LEADS = {
  'self-hosted wrap-up tail': "median time after the last step before a job reports done (GitHub-hosted is about 2 s), by workflow",
  'toolchain setup': 'toolchain setup per job, by workflow',
  'queue wait': 'p90 wait for a runner, by workflow',
  'short hosted jobs bill a whole minute': 'GitHub bills each hosted job rounded up to a whole minute; a week, by workflow',
};

function ranOnGitHubHosted(job) {
  // The runner group is the reliable field: GitHub-hosted jobs report "GitHub Actions". Labels are
  // only a fallback for older payloads, since a self-hosted runner may carry an ubuntu-* label.
  if (job.runner_group_name) return job.runner_group_name === 'GitHub Actions';
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
    jobLengths: [], stepsPerJob: [], hostedJobs: 0, jobCount: 0, sawCacheStep: false, billedPerRun: [], jobDurations: new Map(),
  };
  for (const jobs of sampledRuns) {
    let runSeconds = 0;
    let billed = 0;
    for (const job of jobs) {
      t.jobCount++;
      const length = secs(job.started_at, job.completed_at);
      const jobName = String(job.name || '');
      if (!t.jobDurations.has(jobName)) t.jobDurations.set(jobName, []);
      t.jobDurations.get(jobName).push(length);
      runSeconds += length;
      t.jobLengths.push(length);
      t.queueWaits.push(secs(job.created_at, job.started_at));
      // GitHub bills a hosted job by the minute, each job rounded up on its own; a self-hosted
      // job is not billed by the minute.
      if (ranOnGitHubHosted(job)) {
        t.hostedJobs++;
        if (length > 0) billed += Math.ceil(length / 60);
      }
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
    t.billedPerRun.push(billed);
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
export function measureWorkflow(workflowName, workflowRuns, sampledRuns, fileText, weekFactor, repo = 'owner/repo', outcomeRuns = {}) {
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
  // A run that ran no job (skipped, waiting for approval, failed to start) costs nothing; it still
  // counts as a run.
  const costedRuns = workflowRuns.filter((r) => !NO_JOB_OUTCOMES.has(r.conclusion)).length;
  // The cost of a run, by how it ended: the mean of its outcome's sampled runs (job seconds and
  // billed minutes), or a success's where none of that outcome was sampled. A total is a count
  // times a mean: a median would understate a week whose runs are skewed by a few long ones.
  const successSeconds = mean(timing.jobSecondsPerRun);
  const successBilled = mean(timing.billedPerRun);
  const costOf = (jobsPerRun) => {
    const t = timeJobs(jobsPerRun, new Map());
    return { seconds: mean(t.jobSecondsPerRun), billed: mean(t.billedPerRun), sampled: jobsPerRun.length };
  };
  const byOutcome = {};
  let weekSeconds = 0;
  let weekBilled = 0;
  for (const r of workflowRuns) {
    if (NO_JOB_OUTCOMES.has(r.conclusion)) continue;
    const outcome = TIMED_OUTCOMES.includes(r.conclusion) ? r.conclusion : 'success';
    if (!byOutcome[outcome]) {
      const sampled = outcome === 'success' ? { seconds: successSeconds, billed: successBilled, sampled: sampledRuns.length } : (outcomeRuns[outcome] || []).length ? costOf(outcomeRuns[outcome]) : null;
      byOutcome[outcome] = { runs: 0, ...(sampled || { seconds: successSeconds, billed: successBilled, sampled: 0 }), estimated: outcome !== 'success' && !sampled };
    }
    byOutcome[outcome].runs++;
    weekSeconds += byOutcome[outcome].seconds;
    weekBilled += byOutcome[outcome].billed;
  }
  const perWeek = (n) => round(n * weekFactor, 1);
  const events = countBy(workflowRuns, (r) => r.event);
  const waitedOn = sum(Object.entries(events).filter(([e]) => WAITED_ON.has(e)).map(([, n]) => n)) >= 0.5 * workflowRuns.length;
  const billedPerRun = median(timing.billedPerRun);
  const costByOutcome = Object.fromEntries(Object.entries(byOutcome).map(([k, v]) => [k, {
    runs_week: perWeek(v.runs), sampled: v.sampled, minutes_per_run: round(v.seconds / 60, 2), estimated: v.estimated,
  }]));
  return {
    workflow: workflowName,
    path: String(workflowRuns[0].path || '').split('@')[0],
    runs_week: perWeek(workflowRuns.length),
    sampled_runs: sampledCount,
    thin_sample: sampledCount < THRESHOLDS.thinSample,
    skipped_week: perWeek(workflowRuns.length - costedRuns),
    jobs_per_run: round(timing.jobCount / sampledCount, 1),
    // A typical run (the median), and what a successful run costs on average (the mean), which the
    // per-run savings multiply by.
    job_minutes_per_run: round(medianRunSeconds / 60, 2),
    job_minutes_per_run_mean: round(successSeconds / 60, 2),
    job_minutes_week: round((weekFactor * weekSeconds) / 60, 1),
    billed_minutes_per_run: billedPerRun,
    billed_minutes_week: round(weekFactor * weekBilled, 1),
    cost_by_outcome: costByOutcome,
    job_durations: Object.fromEntries([...timing.jobDurations].map(([k, v]) => [k, { runs: v.length, max_s: Math.max(...v), median_s: median(v) }])),
    jobs_sampled: timing.jobCount,
    waited_on: waitedOn,
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
    events,
    installers: facts.installers,
    fork_reachable: forkReachableSelfHosted(doc, repo),
    job_timeouts: allJobTimeouts(doc),
    checkout: facts.checkout,
    fixed_share: round((shares.overhead || 0) + (shares.head || 0) + (shares.tail || 0) + (shares.checkout || 0), 3),
  };
}

const T = THRESHOLDS;

/**
 * The per-workflow rules. Each returns findings as { saving, workflow, what, evidence, fix,
 * tradeoff, example, confidence, unit }: unit is 'job' (job-minutes), 'billed' (billed minutes)
 * or 'wait' (developer wait, no minutes). The example is YAML for the fix, tailored to the
 * repository.
 */
export function workflowFindings(w, { lockKey, hasLock, lockfiles = [], defaultBranch = null, isPublic = false }) {
  // isPublic: true, false, or 'private' when the repository is known not to be public; the billing
  // rule needs true, and the fork rule skips only a repository known to be private.
  const F = [];
  // A timing from one or two runs can be an outlier; the evidence says so rather than hiding it.
  const thin = w.thin_sample ? ` (timed from only ${w.sampled_runs} successful run${w.sampled_runs === 1 ? '' : 's'})` : '';
  // brief: this workflow's own figure, for a finding groupFindings merges across workflows.
  const add = (saving, what, evidence, fix, { confidence = 'measured', tradeoff = '', example = '', unit = 'job', parts = null, brief = null } = {}) => F.push({
    saving, workflow: w.workflow, what, evidence: evidence + thin, fix, tradeoff, example, confidence, unit, parts,
    brief, thin: w.thin_sample ? w.sampled_runs : null,
  });
  const perRun = w.cats_secs_per_run;
  const jobs = Math.max(1, w.jobs_per_run);
  const manager = managerOf(w.installers, lockfiles);

  const deps = perRun.deps || 0;
  const depsJob = deps / jobs;
  if (depsJob >= T.depsPerJobNoCache && !w.has_cache) {
    add(0.6 * deps * w.runs_week / 60, 'cache dependencies',
      `dependency installs take ${fmtS(depsJob)} per job (${fmtS(deps)} per run, ${Math.round(w.dep_share * 100)}% of the workflow's job time) and the workflow file has no dependency cache`,
      `cache the package manager's store ${lockKey}`,
      {
        confidence: 'confirmed',
        tradeoff: 'a key that ignores the lockfile serves a stale tree; one keyed on it misses on every dependency change, and a cache restore has its own cost on a small install',
        example: cacheExample(manager, lockfiles),
      });
  } else if (w.has_cache && (w.dep_share >= T.depsShareWithCache || depsJob >= T.depsPerJobWithCache)) {
    let why, fix, example = '';
    if (w.npm_install_no_ci && !hasLock && !w.caches_node_modules) {
      why = `dependency installs are ${Math.round(w.dep_share * 100)}% of the workflow's job time (${fmtS(depsJob)} per job) even with setup-node's npm cache: `
        + 'with no lockfile, `npm install` resolves the whole tree from the registry on every job, and the npm cache only saves the tarball downloads';
      fix = 'keep testing the newest dependencies but cut the round trips: `npm install --prefer-offline --no-audit --no-fund`, '
        + 'or cache node_modules keyed on package.json, the runner OS, the Node version and the date, so the tree is resolved once a day per combination';
      example = '- run: npm install --prefer-offline --no-audit --no-fund';
    } else {
      why = `dependency installs are ${Math.round(w.dep_share * 100)}% of the workflow's job time (${fmtS(depsJob)} per job) with a cache configured`;
      fix = "check the cache hit rate and key in the setup step's log; install only what the job needs (workspace filters, --omit=dev where tests allow)";
    }
    add(0.3 * deps * w.runs_week / 60, 'dependency installs dominate', why, fix, {
      confidence: 'confirmed',
      tradeoff: 'a project that tests against the newest dependencies on purpose keeps that policy with either fix; a daily key means a new release reaches CI up to a day later',
      example,
    });
  }

  const co = perRun.checkout || 0;
  if (co / jobs >= T.checkoutPerJob) {
    // actions/checkout fetches one commit by default, so a slow checkout is the file asking for
    // more (history, LFS, submodules, tags), or a large repository. The file says which.
    const { causes, example } = checkoutAdvice(w.checkout);
    const known = w.checkout && w.checkout.inspected && !w.checkout.depthUnknown;
    if (!causes.length && !known) {
      // No actions/checkout step to read (the file is unavailable, or the job checks out another
      // way), or a depth set by an expression: the file does not say what the checkout fetches.
      const why = w.checkout && w.checkout.depthUnknown
        ? 'and its fetch-depth is set by an expression, so the workflow file does not say how much history it fetches'
        : 'and the workflow file shows no actions/checkout step to read, so what it fetches is not known';
      add(0.5 * co * w.runs_week / 60, 'slow checkout', `checkout takes ${fmtS(co / jobs)} per job, ${why}`,
        'check what the checkout fetches: a single commit (`fetch-depth: 1`, the default) unless the job reads history, and LFS objects, submodules and tags only in the jobs that need them',
        { confidence: 'inferred', tradeoff: 'a job that computes a version from tags or diffs against a base branch needs the history it reads' });
    } else if (causes.length) {
      add(0.5 * co * w.runs_week / 60, 'slow checkout', `checkout takes ${fmtS(co / jobs)} per job, and the checkout step asks for more than one commit: ${causes.join('; ')}`,
        'fetch only what the job uses: one commit (or the few the job reads), and LFS objects, submodules and tags only in the jobs that need them',
        { confidence: 'confirmed', tradeoff: 'a job that computes a version from tags or diffs against a base branch needs the history it reads', example });
    } else {
      add(0.5 * co * w.runs_week / 60, 'slow checkout', `checkout takes ${fmtS(co / jobs)} per job though the checkout step already fetches a single commit, so the time is the repository's size`,
        'sparse-checkout the paths the job reads, or move large generated or binary files out of the repository',
        { confidence: 'inferred', tradeoff: 'a sparse checkout breaks a job that reads a path outside its list', example });
    }
  }

  const tc = perRun.toolchain || 0;
  if (tc / jobs >= T.toolchainPerJob) {
    const note = w.setup_cache ? ' (this includes restoring the dependency cache, which the setup step does)' : '';
    add(0.5 * tc * w.runs_week / 60, 'toolchain setup', `toolchain setup takes ${fmtS(tc / jobs)} per job${note}`,
      'use runtime versions the runner image already has, or an image with the toolchain baked in',
      { confidence: 'inferred', tradeoff: "pinning to the image's version ties the job to the image's update schedule", brief: `${fmtS(tc / jobs)}${w.setup_cache ? ' (with its dependency cache restore)' : ''}` });
  }

  if (w.dup_commits_week >= T.duplicateCommitsWeek) {
    // Patterns beyond the default branch (or, when it is unknown, beyond main and master).
    const isDefault = (b) => (defaultBranch ? b === defaultBranch : b === 'main' || b === 'master');
    const extra = w.push_branches.filter((b) => !isDefault(b));
    const cg = w.concurrency_group;
    let why = `${Math.round(w.dup_commits_week)} commits a week run on both push and pull_request`;
    let confidence = 'measured';
    if (extra.length) {
      why += `: the push trigger also matches ${extra.slice(0, 6).join(', ')}, so a branch pushed to this repository with an open pull request runs every commit twice`;
      confidence = 'confirmed';
    }
    if (cg.includes('event.number') || cg.includes('pull_request.number')) {
      why += `; the concurrency group (${cg}) keys pull requests by number and pushes by commit, so neither run cancels the other`;
    }
    const fix = extra.length
      ? 'drop those patterns from the push trigger if every such branch gets a pull request, or key the concurrency group on the commit for both events so the second run cancels the first'
      : 'run on push only for the default branch and on pull_request for everything else, or share one concurrency group per commit';
    add(w.dup_commits_week * (w.job_minutes_per_run_mean ?? w.job_minutes_per_run), 'the same commit runs twice', why, fix, {
      confidence,
      tradeoff: 'a branch pushed without a pull request then runs no CI until one is opened (trigger fix), or one of the two runs is cancelled and shows as such (concurrency fix)',
      example: extra.length ? ONE_RUN_PER_COMMIT : triggerExample(w.push_branches, defaultBranch),
    });
  }

  if (w.superseded_week >= T.supersededWeek && !w.cancels) {
    add(w.superseded_week * (w.job_minutes_per_run_mean ?? w.job_minutes_per_run), 'outdated runs keep going',
      `${Math.round(w.superseded_week)} pull request runs a week were still running when a newer push to the same branch started a new run, and the workflow has no cancel-in-progress`,
      'a concurrency group per branch with cancel-in-progress, so a new push cancels the outdated run (runs on the default branch keep their own group)',
      { tradeoff: 'a workflow whose runs must all finish (a status that counts every run, a deploy) should not cancel, and cancelled runs show in the history', example: CANCEL_OUTDATED });
  }

  if (w.jobs_per_run >= T.matrixJobs && w.job_minutes_per_run >= T.matrixJobMinutes) {
    add(0, 'matrix size',
      `${Math.round(w.jobs_per_run)} jobs a run, ${Math.round(w.job_minutes_per_run)} job-minutes per run (${Math.round(w.job_minutes_week)} a week); the slowest job takes ${fmtS(w.longest_job_s)} against a median of ${fmtS(w.median_job_s)}`,
      'an option, not a fault: run the full matrix on the default branch and nightly, and a smaller set (newest runtime on each OS, oldest supported) on pull requests',
      { tradeoff: 'a combination that breaks is found after merge instead of before', unit: 'wait' });
  }

  if (w.hosted_share < 0.5 && w.tail_p50 >= T.selfHostedTail) {
    add((w.tail_p50 - 2) * w.jobs_per_run * w.runs_week / 60, 'self-hosted wrap-up tail',
      `median ${Math.round(w.tail_p50)} s after the last step before the job reports done (GitHub-hosted is about 2 s)`,
      "fewer steps per job (the runner uploads each step's log before it reports), and a runner close to GitHub's service region",
      { tradeoff: 'merging steps merges their logs', brief: `${Math.round(w.tail_p50)} s` });
  }

  if (w.wait_p90 >= T.queueP90) {
    add(0, 'queue wait', `p90 wait for a runner ${Math.round(w.wait_p90)} s (over ${w.jobs_sampled} sampled jobs)`,
      'more runner capacity at peak, or fewer jobs per event (merge small jobs, skip work by changed paths)',
      { tradeoff: 'path filters on required checks need care, or a skipped check blocks the merge', unit: 'wait', brief: `${Math.round(w.wait_p90)} s over ${w.jobs_sampled} sampled jobs` });
  }

  if (w.jobs_per_run >= T.shortJobsCount && w.job_minutes_per_run / w.jobs_per_run < 1.0) {
    const over = (perRun.overhead || 0) + (perRun.checkout || 0) + (perRun.toolchain || 0) + (perRun.deps || 0);
    add(0.5 * over * w.runs_week / 60, 'many short jobs',
      `${Math.round(w.jobs_per_run)} jobs a run averaging under a minute each, ${fmtS(over)} of setup per run`,
      'merge short jobs that share setup into one job with several steps, or a matrix only where it buys parallel time',
      { tradeoff: 'the merged job reports one status where there were several' });
  }

  // GitHub rounds each hosted job up to a whole minute, so a run of short jobs bills far more
  // than it runs. Only GitHub-hosted jobs count; old reports without billed minutes never fire.
  // A public repository's standard hosted runners are free: its billed minutes cost nothing, so
  // the rule does not fire there.
  const billed = w.billed_minutes_week;
  if (isPublic !== true && typeof billed === 'number' && w.hosted_share >= 0.5 && billed >= T.billedRatio * w.job_minutes_week && billed - w.job_minutes_week >= T.billedExcessWeek) {
    const jobsWeek = w.jobs_per_run * (w.runs_week - (w.skipped_week || 0));
    add(0.5 * (billed - w.job_minutes_week), 'short hosted jobs bill a whole minute',
      `about ${Math.round(jobsWeek)} jobs a week averaging ${fmtS(w.median_job_s)}, but GitHub bills each hosted job rounded up to a whole minute: about ${Math.round(billed)} billed minutes a week for ${Math.round(w.job_minutes_week)} job-minutes`,
      'fewer, longer jobs: merge the short jobs of a run into one, run the workflow less often, or move it to a self-hosted runner',
      { tradeoff: 'a merged job reports one status where there were several; a self-hosted runner is yours to run, patch and secure', unit: 'billed', brief: `${Math.round(billed)} billed minutes for ${Math.round(w.job_minutes_week)} job-minutes, jobs averaging ${fmtS(w.median_job_s)}` });
  }
  // A job with no timeout (GitHub's default is 360 minutes), or one far above anything it has taken,
  // lets a hung run hold its runner, and bill on a hosted one, for hours. The limit to suggest comes
  // from the job's own longest sampled run.
  const durations = w.job_durations || {};
  // Every file job takes part in matching, so a job left out of the advice (an expression timeout,
  // a reusable-workflow call) keeps its own runs; only the judged ones are then advised.
  const timeouts = w.job_timeouts || [];
  const assigned = assignJobRuns(timeouts.map((t) => ({ id: t.id, name: t.name, reusable: Boolean(t.reusable) })), Object.keys(durations));
  const loose = [];
  for (const t of timeouts.filter((x) => x.judged !== false)) {
    const runs = assigned.get(t.id) || [];
    if (!runs.length) continue;
    const maxS = Math.max(...runs.map((n) => durations[n].max_s));
    const sampled = sum(runs.map((n) => durations[n].runs));
    const suggest = Math.max(T.timeoutFloorMin, Math.ceil((T.timeoutFactor * maxS) / 60 / 5) * 5);
    // Only a limit below the one the job already has is a fix: GitHub stops a job at 360 minutes
    // anyway, so a long job whose safe margin reaches that has nothing to tighten.
    if (suggest >= t.minutes) continue;
    if (t.isDefault || t.minutes > T.timeoutLoose * Math.max(maxS / 60, 1)) loose.push({ ...t, maxS, sampled, suggest });
  }
  if (loose.length) {
    // The parts are kept so groupFindings can merge this finding across workflows into one.
    // thin: how many successful runs timed a thinly sampled workflow, so a merged finding can say so.
    const part = { workflow: w.workflow, path: w.path, hosted: w.hosted_share >= 0.5, thin: w.thin_sample ? w.sampled_runs : null, loose };
    const { evidence, example } = timeoutText([part]);
    add(0, 'jobs without a working timeout', evidence, TIMEOUT_FIX,
      { tradeoff: TIMEOUT_TRADEOFF, example, unit: 'guard', parts: [part] });
  }

  // A fork's pull request that reaches a self-hosted runner runs a stranger's code on the host. On
  // a public repository GitHub runs such a pull request without approval once its author has had
  // one merged (the default policy), and the audit cannot read the repository's approval setting.
  const reach = w.fork_reachable || [];
  if (reach.length && isPublic !== 'private') {
    const label = (r) => (typeof r.runsOn === 'string' ? r.runsOn : JSON.stringify(r.runsOn));
    const certain = reach.filter((r) => r.certain);
    const jobsText = reach.slice(0, 5).map((r) => `${r.job} (runs-on ${label(r)}${r.event === 'pull_request_target' ? ', on pull_request_target with the head checked out' : ''}${r.certain ? '' : ', depending on a value the audit cannot resolve'})`).join('; ');
    const example = forkGuardExample(reach[0].runsOn);
    const notPublic = isPublic === true ? '' : ' (if the repository is public; its visibility could not be read)';
    add(0, 'fork pull requests run on self-hosted runners',
      `evaluated for a pull request from a fork, ${reach.length === 1 ? 'job' : 'jobs'} ${jobsText} ${certain.length ? (reach.length === 1 ? 'picks' : 'pick') : 'can pick'} a self-hosted runner, so a fork's code ${certain.length ? 'runs' : 'can run'} on your machine${notPublic}`,
      "send a fork's pull requests to a GitHub-hosted runner and keep the job's own runner selection for everything else" + (example ? '' : ' (this job\'s selection has expressions inside a list or a runner group, so wrap it by hand rather than rewrite it)') + "; GitHub's approval of fork workflows is a second line, not the guard",
      {
        confidence: isPublic === true && certain.length ? 'confirmed' : 'inferred',
        tradeoff: "a fork's checks then run on a GitHub-hosted runner, slower to start or billed on a private repository, and a job that needs something only the self-hosted machine has must skip for forks",
        example,
        unit: 'risk',
      });
  }
  return F;
}

/**
 * Self-hosted runners that took more than one sampled job. An ephemeral (just-in-time) runner
 * registers anew for every job, so its runner id never repeats; a repeated id is a persistent
 * runner, whose workspace, tool cache, processes and files can carry from one job to the next.
 */
export function runnerReuseFinding(samples) {
  const byRunner = new Map();
  let selfHostedJobs = 0;
  for (const [wf, jobsPerRun] of samples) {
    for (const jobs of jobsPerRun) {
      for (const job of jobs) {
        if (ranOnGitHubHosted(job) || job.runner_id == null || !Number(job.runner_id)) continue;
        selfHostedJobs++;
        const id = Number(job.runner_id);
        if (!byRunner.has(id)) byRunner.set(id, { name: String(job.runner_name || id), jobs: 0, workflows: new Set() });
        const r = byRunner.get(id);
        r.jobs++;
        r.workflows.add(wf);
      }
    }
  }
  const reused = [...byRunner.values()].filter((r) => r.jobs > 1).sort((a, b) => b.jobs - a.jobs);
  if (!reused.length) return [];
  const reusedJobs = sum(reused.map((r) => r.jobs));
  const top = reused[0];
  const workflows = [...new Set(reused.flatMap((r) => [...r.workflows]))];
  return [{
    saving: 0, unit: 'risk', confidence: 'measured', what: 'self-hosted runners reused across jobs',
    workflow: workflows.length === 1 ? workflows[0] : `${workflows.length} workflows: ${workflows.slice(0, 5).join(', ')}${workflows.length > 5 ? ' and more' : ''}`,
    evidence: `${reusedJobs} of ${selfHostedJobs} sampled self-hosted jobs ran on ${reused.length === 1 ? 'a runner' : `${reused.length} runners`} that took more than one job (${top.name} took ${top.jobs}), so those runners are persistent: a job can find the workspace, files, processes and tool cache the job before it left`,
    fix: 'ephemeral runners: one job per registration (just-in-time configuration, or config.sh --ephemeral), each starting from a clean directory; keep start latency low with a warm runner waiting for the next job',
    tradeoff: 'every job re-registers (seconds, hidden by a warm runner), and nothing a job leaves on disk survives for the next, so caches go through actions/cache or a read-only tool cache',
    example: '',
  }];
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
        tradeoff: 'a debounced status can lag the newest event by one run',
        example: ONE_RUN_PER_COMMIT,
        confidence: 'measured', unit: 'job',
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
      tradeoff: 'one failing check then shares a job, and a red status, with the others',
      example: '',
      confidence: 'measured', unit: 'job',
    });
  }
  const reruns = sum(workflows.map((w) => w.reruns_raw));
  if (reruns) {
    F.push({
      saving: sum(workflows.map((w) => w.reruns_week * (w.job_minutes_per_run_mean ?? w.job_minutes_per_run))), workflow: 'all workflows', what: 'reruns',
      evidence: `${reruns} re-attempted run${reruns === 1 ? '' : 's'} in the window across the sampled workflows`,
      fix: 'find the flaky step from the failed attempts and fix or quarantine it; each rerun also costs a developer a wait',
      tradeoff: 'quarantining hides a real failure until someone looks',
      example: '',
      confidence: 'measured', unit: 'job',
    });
  }
  return F;
}

/** One finding per kind where a kind repeats across workflows: the workflows listed, savings summed, the largest one's evidence shown. */
const TIMEOUT_FIX = `set timeout-minutes on each job from its own longest runs, ${T.timeoutFactor} times the longest sampled, rounded up to 5 minutes and at least ${T.timeoutFloorMin}`;
const TIMEOUT_TRADEOFF = 'a run slower than the limit (a cold cache, a busy runner) is cancelled and must be re-run, so set it from the slowest legitimate runs and raise it when a job grows; a timed-out run shows as timed out, which says what happened';

/**
 * The evidence and example for jobs without a working timeout, from one or more workflows' parts
 * ({ workflow, path, hosted, thin, loose }). Across workflows each job is named with its workflow,
 * and the example gives each file its own YAML document. The evidence names up to five jobs (six
 * across workflows) and counts the rest; the example sets up to three and names the ones it leaves
 * out in a closing comment. For one workflow, add() appends its thin-sample note; across workflows
 * each thinly sampled workflow is named here.
 */
function timeoutText(parts) {
  const many = parts.length > 1;
  const jobs = parts.flatMap((p) => p.loose.map((t) => ({ ...t, workflow: p.workflow, path: p.path })));
  const one = (t) => `${many ? `${t.workflow}: ` : ''}${t.id} (${t.isDefault ? 'no timeout-minutes, so GitHub\'s 360' : `timeout-minutes ${t.minutes}`}; longest of ${t.sampled} sampled run${t.sampled === 1 ? '' : 's'} ${fmtS(t.maxS)})`;
  const shown = jobs.slice(0, many ? 6 : 5).map(one).join('; ') + (jobs.length > (many ? 6 : 5) ? `; and ${jobs.length - (many ? 6 : 5)} more` : '');
  const where = many ? ` in ${parts.length} workflows` : '';
  const thinNote = many
    ? parts.filter((p) => p.thin !== null).map((p) => `; ${p.workflow} was timed from only ${p.thin} successful run${p.thin === 1 ? '' : 's'}`).join('')
    : '';
  const evidence = `${jobs.length === 1 ? 'job' : `${jobs.length} jobs${where}:`} ${shown}: a hung run holds its runner${parts.every((p) => p.hosted) ? ', billing every minute,' : parts.some((p) => p.hosted) ? ' (a GitHub-hosted one billing every minute)' : ''} for up to ${Math.max(...jobs.map((t) => t.minutes))} minutes before GitHub stops it${thinNote}`;
  // Up to three jobs in the example; across workflows, one YAML document per file, headed by its
  // path. The jobs it leaves out are named in a comment, so none is silently dropped.
  const block = (ts) => `jobs:\n${ts.map((t) => `  ${t.id}:\n    timeout-minutes: ${t.suggest}   # ${T.timeoutFactor}x its longest sampled run`).join('\n')}`;
  const blocks = [];
  let left = 3;
  for (const p of parts) {
    if (left <= 0) break;
    const ts = p.loose.slice(0, left);
    left -= ts.length;
    blocks.push(many ? `# ${p.path || p.workflow}\n${block(ts)}` : block(ts));
  }
  const rest = jobs.slice(3).map((t) => (many ? `${t.workflow}: ${t.id}` : t.id));
  const more = rest.length
    ? `\n# and ${rest.length} more job${rest.length === 1 ? '' : 's'} (${rest.slice(0, 8).join(', ')}${rest.length > 8 ? `, and ${rest.length - 8} others` : ''}): the same rule, each from its own longest sampled run`
    : '';
  return { evidence, example: blocks.join('\n---\n') + more };
}

/**
 * The evidence of a finding merged across workflows: what it measures, then each workflow's own
 * figure, its saving, and whether it was thinly sampled, largest saving first. A finding without a
 * figure for each workflow keeps the largest one's evidence and says so.
 */
function groupedEvidence(what, members, largest) {
  if (!GROUP_LEADS[what] || members.some((m) => !m.brief)) return `${largest} (shown for the largest; the same holds in the others)`;
  // Every member's saving is shown, as the report's own saving text puts it ("under 1" below a minute):
  // a group can pass the reporting threshold on members that are each under it.
  const saved = (m) => {
    if (m.unit !== 'job' && m.unit !== 'billed') return '';
    return m.saving >= 1 ? `, about ${Math.round(m.saving)} ${m.unit}-min/week` : `, under 1 ${m.unit}-min/week`;
  };
  const thin = (m) => (m.thin === null || m.thin === undefined ? '' : `, timed from only ${m.thin} successful run${m.thin === 1 ? '' : 's'}`);
  const shown = members.slice(0, 6).map((m) => `${m.workflow} ${m.brief}${saved(m)}${thin(m)}`);
  const more = members.length > 6 ? `; and ${members.length - 6} more` : '';
  return `${GROUP_LEADS[what]}: ${shown.join('; ')}${more}`;
}

export function groupFindings(F) {
  // Jobs without a working timeout, found in several workflows, are one finding naming each job.
  const timeouts = F.filter((f) => f.what === 'jobs without a working timeout' && f.parts);
  if (timeouts.length > 1) {
    const parts = timeouts.flatMap((f) => f.parts);
    const { evidence, example } = timeoutText(parts);
    const names = parts.map((p) => p.workflow);
    const merged = {
      ...timeouts[0], evidence, example, parts: null,
      workflow: `${names.length} workflows: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' and more' : ''}`,
    };
    F = [...F.filter((f) => !timeouts.includes(f)), merged];
  }
  const grouped = new Map();
  for (const f of [...F].sort((a, b) => b.saving - a.saving)) {
    if (GROUPED.has(f.what)) {
      if (!grouped.has(f.what)) grouped.set(f.what, { ...f, members: [] });
      const g = grouped.get(f.what);
      if (g.members.length) g.saving += f.saving;
      g.members.push(f);
    } else {
      grouped.set(`${f.what}\u0000${f.workflow}`, { ...f, members: [f] });
    }
  }
  const out = [];
  for (const g of grouped.values()) {
    const ms = g.members;
    const wfs = ms.map((m) => m.workflow);
    const where = wfs.length === 1 ? wfs[0] : `${wfs.length} workflows: ${wfs.slice(0, 5).join(', ')}${wfs.length > 5 ? ' and more' : ''}`;
    out.push({ ...g, workflow: where, evidence: ms.length === 1 ? g.evidence : groupedEvidence(g.what, ms, g.evidence), members: undefined, brief: undefined, thin: undefined });
  }
  // A security risk comes before any saving: it is the first thing to fix whatever the minutes say.
  const risk = (f) => (f.unit === 'risk' ? 1 : 0);
  return out.sort((a, b) => risk(b) - risk(a) || b.saving - a.saving);
}

/**
 * @param {string} repo
 * @param {Awaited<ReturnType<import('./collect.mjs').collect>>} data
 */
export function analyse(repo, data) {
  // One parse per workflow file for the whole audit: the measurements, scans and gate checks share it.
  return withParseCache(() => analyseParsed(repo, data));
}

function analyseParsed(repo, data) {
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
    workflows.push(measureWorkflow(wf, rs, jobsPerRun, data.files.get(path) || '', week, repo, (data.outcomeSamples && data.outcomeSamples.get(wf)) || {}));
  }
  workflows.sort((a, b) => b.job_minutes_week - a.job_minutes_week);
  const raw = [...workflows.flatMap((w) => workflowFindings(w, { lockKey, hasLock, lockfiles: data.lockfiles, defaultBranch: data.defaultBranch || null, isPublic: data.visibility === 'public' ? true : data.visibility ? 'private' : false })), ...repoFindings(workflows), ...runnerReuseFinding(data.samples || new Map()), ...scanFindings(data.scanFiles || new Map(), { repo }), ...gateFindings(data.gates, { scanFiles: data.scanFiles || new Map(), scanned: data.scanned, visibility: data.visibility })];
  // A finding that saves under a minute a week is noise next to the rest; one that saves developer
  // wait has no minutes to compare and always stays.
  const findings = groupFindings(raw).filter((f) => f.unit === 'wait' || f.unit === 'risk' || f.unit === 'guard' || f.saving >= T.minSavingWeek).map((f) => ({
    saving_min_week: round(f.saving, 1), unit: f.unit || 'job', workflow: f.workflow, what: f.what, evidence: f.evidence,
    fix: f.fix, tradeoff: f.tradeoff || '', example: f.example || '', confidence: f.confidence,
  }));
  return {
    repo,
    covered_days: round(data.coveredDays, 2),
    window_truncated: Boolean(data.truncated),
    visibility: data.visibility || null,
    // The scans read every workflow file collect listed (scanFiles); an audit built without that
    // listing (a caller's own data) runs no scans and says so by reporting none read.
    scanned: data.scanned || { read: (data.scanFiles || new Map()).size, of: null, unreadable: [] },
    // What guards a merge into the default branch, as read (null where it could not be read).
    gates: data.gates ? { branch: data.gates.branch, required: data.gates.required, required_complete: data.gates.required_complete, pr_checks: data.gates.pr_checks, pr_runs_read: data.gates.pr_runs_read, pr_jobs_complete: data.gates.pr_jobs_complete } : null,
    only: data.only || [],
    only_missing: data.onlyMissing || [],
    runs_total: data.runs.length,
    lockfiles: data.lockfiles,
    workflows,
    job_minutes_week_sampled: round(sum(workflows.map((w) => w.job_minutes_week)), 1),
    findings,
    saving_min_week_total: round(sum(findings.filter((f) => f.unit === 'job').map((f) => f.saving_min_week)), 1),
    billed_minutes_week_sampled: round(sum(workflows.map((w) => w.billed_minutes_week)), 1),
    billed_saving_min_week_total: round(sum(findings.filter((f) => f.unit === 'billed').map((f) => f.saving_min_week)), 1),
  };
}
