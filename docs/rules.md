# Rules

Each rule reads the measurements of one workflow (or of all sampled workflows) and the workflow
file. A finding states its evidence, a confidence and an estimated weekly saving in job-minutes.

**Confidence.** *confirmed*: the workflow file shows the cause. *measured*: the timings or run
history show it; the cause is the plain reading of the numbers. *inferred*: the cause is a likely
reading, and the evidence says what else the time may include.

**Window.** When the window holds every run (fewer than the 500-run cap), it covers the days asked
for, so a repository that ran only on the last day of seven reads as that many runs a week. When
the cap is reached, the window covers its oldest run to now, and the report says so. Runs whose
jobs were all skipped count as runs but cost no job-minutes.

**Thin samples.** A workflow timed from fewer than 3 successful runs is marked † in the table,
and its findings' evidence says how many runs it was timed from.

**Step categories.** A step counts as checkout when it is `actions/checkout` or is named
"Checkout" / "Check out" (not a test suite that mentions checkout), and as a dependency install
for `yarn`, `yarn install` or `yarn --frozen-lockfile`, never `yarn test`. A step whose name has an
expression (`Test on ${{ matrix.node }}`) is matched to its command after GitHub expands it.

**Estimates.** Weekly figures scale the sampled window to 7 days. A saving is a formula over
measured time, never the result of running the fix; the formulas are below. Thresholds live in
`THRESHOLDS` in `src/analyse.mjs`.

**Grouping.** The wrap-up tail, toolchain and queue-wait rules fire per workflow and are reported
once, listing the workflows, with the savings summed and the largest one's evidence shown.

## cache dependencies

- **Fires when** dependency installs take 15 s or more per job and the parsed workflow file has
  no dependency cache: no `actions/cache` step, no setup action whose `cache:` input is on, no
  `cache-dependency-path`, no setup-ruby `bundler-cache`, and no setup-go from v4 (which caches
  unless told not to). A commented-out step, or an input that is `false` or `${{ false }}`, is
  not a cache.
- **Confidence** confirmed.
- **Estimate** 60% of the measured install time, times runs a week.
- **Fix** cache the package manager's store, keyed on the committed lockfile, or on the manifest
  when the repository commits none. *Trade-off:* a cache key that ignores the lockfile serves
  stale trees; one keyed on it misses on every dependency change.

## dependency installs dominate

- **Fires when** a cache is configured but installs are still 25% or more of the workflow's job
  time, or 45 s or more per job.
- **Confidence** confirmed.
- **Estimate** 30% of the install time, times runs a week.
- **Fix** when the workflow runs `npm install` and the repository commits no lockfile, the npm
  cache only saves tarball downloads: npm still resolves the whole tree from the registry on every
  job. `npm install --prefer-offline --no-audit --no-fund` cuts the round trips, or a
  `node_modules` cache keyed on the manifest, the runner OS, the runtime version and the date
  resolves it once a day. Otherwise: check the cache hit rate, and install only what the job
  needs. *Trade-off:* a project that tests against the newest dependencies on purpose keeps
  that policy with either fix; a daily key means a new release reaches CI up to a day later.

## slow checkout

- **Fires when** checkout takes 12 s or more per job.
- **Confidence** measured.
- **Estimate** 50% of checkout time, times runs a week.
- **Fix** `fetch-depth: 1` unless the job needs history; sparse checkout for large monorepos; no
  tags or LFS by default. *Trade-off:* jobs that compute versions from tags or diff against a
  base need the history they use.

## toolchain setup

- **Fires when** toolchain setup takes 15 s or more per job.
- **Confidence** inferred (a setup step that caches dependencies also restores that cache, and
  the evidence says so).
- **Estimate** 50% of setup time, times runs a week.
- **Fix** runtime versions the runner image already has, or an image with the toolchain baked in.
  *Trade-off:* pinning to the image's version ties the job to the image's update schedule.

## the same commit runs twice

- **Fires when** 3 or more commits a week ran the workflow on both a push and a pull request
  event.
- **Confidence** confirmed when the push trigger matches branches beyond the default branch
  (the evidence names them), measured otherwise. A concurrency group keyed on the pull request
  number is named too: it puts the push run (keyed by commit) and the pull request run in
  different groups, so neither cancels the other.
- **Estimate** the duplicate commits a week, times job-minutes per run.
- **Fix** drop the extra patterns from the push trigger when every such branch gets a pull
  request, or key the concurrency group on the commit for both events, so the second run cancels
  the first. *Trade-off:* a branch pushed without a pull request then runs no CI until one is
  opened (first fix), or one of the two runs is cancelled and shows as such (second fix).

## outdated runs keep going

- **Fires when** 2 or more pull request runs a week were still running when a newer commit on
  the same branch started its run, and no concurrency block in the workflow (top level or per
  job) has `cancel-in-progress` on. `false` and `${{ false }}` are off; `true` and any other
  expression (a condition such as "pull requests only") are on.
- **Confidence** measured.
- **Estimate** those runs a week, times job-minutes per run.
- **Fix** a concurrency group per branch with `cancel-in-progress: true`. *Trade-off:* a
  workflow whose runs must all finish (a status that counts every run, a deploy) should not
  cancel; queued runs can pile up as cancelled.

## matrix size

- **Fires when** a run has 8 or more jobs and 5 or more job-minutes.
- **Confidence** measured. Reported with no saving: it is an option, not a fault.
- **Fix** the full matrix on the default branch and nightly, a smaller set on pull requests
  (the newest runtime on each OS and the oldest supported). *Trade-off:* a combination that
  breaks is found after merge instead of before.

## self-hosted wrap-up tail

- **Fires when** most of the workflow's jobs ran on self-hosted runners and the median time
  between the last step and the job reporting done is 4 s or more (GitHub-hosted is about 2 s).
- **Confidence** measured.
- **Estimate** the excess over 2 s, times jobs a run, times runs a week.
- **Fix** fewer steps per job (the runner uploads each step's log one after another before it
  reports), and a runner close to GitHub's service region. *Trade-off:* merging steps merges
  their logs.

## queue wait

- **Fires when** the p90 wait for a runner is 30 s or more.
- **Confidence** measured. Reported with no job-minute saving: it costs developer wait.
- **Fix** more runner capacity at peak, or fewer jobs per event (merge small jobs, skip work by
  changed paths). *Trade-off:* path filters on required checks need care, or a skipped check
  blocks the merge.

## many short jobs

- **Fires when** a run has 6 or more jobs averaging under a minute.
- **Confidence** measured.
- **Estimate** half of the per-run setup (overhead, checkout, toolchain, dependencies), times runs
  a week.
- **Fix** merge short jobs that share setup into one job with several steps. *Trade-off:* the
  merged job reports one status where there were several.

## runs far more often than code changes

- **Fires when** a workflow runs 500 or more times a week and at least half of its runs come
  from `workflow_run`, `schedule`, `repository_dispatch` or `workflow_dispatch`.
- **Confidence** measured.
- **Estimate** half of its fixed-cost share (overhead, the time before and after the steps,
  checkout), times its job-minutes a week.
- **Fix** trigger it from fewer upstream workflows or events, debounce it to one run per commit,
  or fold it into the workflow that triggers it. *Trade-off:* a debounced status can lag the
  newest event by one run.

## many small scheduled jobs

- **Fires when** 3 or more sampled workflows run mostly on a clock (`schedule`, or a dispatch
  that arrives on one) and each runs a job of under 30 s.
- **Confidence** measured.
- **Estimate** their fixed cost, times (n - 1) / n: one job would pay it once per tick.
- **Fix** run them as steps of one scheduled job. *Trade-off:* one failing check then shares a
  job, and a red status, with the others.

## reruns

- **Fires when** any sampled run was re-attempted (run attempt above 1). One finding for the
  repository.
- **Confidence** measured.
- **Estimate** re-attempted runs a week, times each workflow's job-minutes per run.
- **Fix** find the flaky step from the failed attempts and fix or quarantine it. *Trade-off:*
  quarantining hides a real failure until someone looks.
