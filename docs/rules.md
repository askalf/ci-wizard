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

**Cost.** A weekly total is a count times a mean, per outcome: successes at the mean of the sampled
successful runs, and failed, cancelled and timed-out runs at the mean of up to two sampled runs of
each, since a failure often stops early and a timeout runs to its limit. An outcome with no run
sampled is costed like a success and marked (`cost_by_outcome`). Runs that ran no job (skipped,
waiting for approval, failed to start, stale) cost nothing. The typical run in the table is the
median successful run; the savings that multiply a per-run cost (duplicates, outdated runs, reruns)
use the mean, because they add up to a total.

**Estimates.** Weekly figures scale the sampled window to 7 days. A saving is a formula over
measured time, never the result of running the fix; the formulas are below. Thresholds live in
`THRESHOLDS` in `src/analyse.mjs`.

**Grouping.** The wrap-up tail, toolchain, queue-wait and short-hosted-jobs rules fire per
workflow and are reported once, listing the workflows, with the savings summed and the largest
one's evidence shown.

**Trade-offs and examples.** Every finding carries the trade-off written below with its rule, and
where a fix is a change to the workflow file, YAML for it: the setup action's cache input for the
package manager the workflow installs with (from its run lines, or the lockfile the repository
commits), the concurrency block, the push trigger, or the checkout step's inputs. Action versions
are left out of the examples: pin the version, or full SHA, the workflow already uses.

**Billed minutes.** GitHub bills a hosted job by the minute, each job rounded up on its own. Billed
minutes are that rounded figure for GitHub-hosted jobs (a job whose runner group is "GitHub
Actions"); self-hosted jobs count 0. They sit beside job-minutes in the table, in `compare`, and
in the short-hosted-jobs rule.

**Risks first.** Two rules report a security and stability risk rather than a saving (unit
`risk`): they rank before every saving and lead the report. They measure the method askalf/pitlane
documents for self-hosted runners: a fork's pull request never reaches a self-hosted runner, and
no two jobs share a runner.

**Noise floor.** A finding whose estimated saving is under 1 minute a week is left out. Queue
wait and matrix size save developer wait, not minutes, and always stay; the report says so.

**Workflows.** Runs are grouped by workflow (its id, then its file), not by the run's name: runs a
pull request makes for a workflow it adds can carry the pull request's title. A workflow is
labelled with the name most of its runs carry.

**Developer wait.** A run's wall time is developer wait only for a workflow somebody waits on: one
that runs mostly on `push`, `pull_request`, `pull_request_target` or `merge_group`. For a workflow
that runs on a clock, a dispatch or another workflow, the report shows no wait.

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
- **Confidence** confirmed when the checkout step asks for more than one commit (`fetch-depth: 0`,
  a `fetch-depth` above 1, `lfs: true`, `submodules`, `fetch-tags: true`; the evidence names
  which). Inferred otherwise: `actions/checkout` fetches a single commit by default, so with none
  of those the time is the repository's size, and the report does not tell such a workflow to set
  `fetch-depth: 1`. When the file has no `actions/checkout` step to read (it is unavailable, or the
  job checks out another way) or sets the depth by an expression, the report says the cause is not
  known rather than guessing.
- **Estimate** 50% of checkout time, times runs a week.
- **Fix** fetch only what the job uses: one commit (or the few it reads), and LFS objects,
  submodules and tags only in the jobs that need them; for a default checkout, sparse-checkout the
  paths the job reads. *Trade-off:* jobs that compute versions from tags or diff against a base
  need the history they use; a sparse checkout breaks a job that reads a path outside its list.

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
- **Branches** "beyond the default branch" uses the repository's default branch as the API reports
  it, or main and master when it cannot be read. The push-trigger example names that branch, and
  when it is unknown says to fill it in, rather than guessing `main`.
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

## short hosted jobs bill a whole minute

- **Fires when** the repository is not public (standard GitHub-hosted runners are free for public
  repositories, so their billed minutes cost nothing there), most of the workflow's jobs ran on
  GitHub-hosted runners, its billed minutes are
  at least twice its job-minutes, and the difference is 30 minutes a week or more. GitHub bills
  each hosted job rounded up to a whole minute, so a job of 8 s bills as 60 s.
- **Confidence** measured. Grouped across workflows like the wrap-up tail.
- **Estimate** half of the billed minutes above the job-minutes, in **billed** minutes (the report
  says so), not job-minutes.
- **Fix** fewer, longer jobs: merge the short jobs of a run into one, run the workflow less often,
  or move it to a self-hosted runner. *Trade-off:* a merged job reports one status where there
  were several; a self-hosted runner is yours to run, patch and secure.

## jobs without a working timeout

- **Fires when** a job the sample ran has no `timeout-minutes` (GitHub stops a job after 360
  minutes), or one more than 10 times its longest sampled run, and the suggested limit is below the
  one it has (GitHub stops a job at 360 minutes, so a long job whose margin reaches that has nothing
  to tighten). A job's runs are matched by the name GitHub shows, matrix legs included ("test
  (20)"); a name with expressions matches on all of its literal text, a run two jobs match equally
  is given to neither, and a name that is all expression matches nothing. A timeout set by an expression, and a job that
  calls a reusable workflow, are left alone: the file does not say the limit.
- **Confidence** measured. Reported as a guard against hung jobs, not a saving.
- **Fix** `timeout-minutes` on each job: 3 times its longest sampled run, rounded up to 5 minutes,
  at least 10. *Trade-off:* a run slower than the limit (a cold cache, a busy runner) is cancelled
  and must be re-run, so set it from the slowest legitimate runs and raise it as the job grows.

## fork pull requests run on self-hosted runners

- **Fires when** a sampled workflow on `pull_request` has a job that, evaluated as GitHub would for
  a pull request from a fork, runs (its `if` is not false) and picks a self-hosted runner (its
  `runs-on` comes to a label list, string or label object naming `self-hosted`). The `if` and
  `runs-on` expressions are evaluated (`src/expr.mjs`) against what every pull request from a fork
  shares (the event, the base repository, a head repository that is a fork and is not the base);
  the action, branches, author, draft state and the fork's own name vary and stay unknown. Status
  functions are known only for a job without `needs` (`success()` true, `failure()` false);
  comparisons of different types coerce to numbers as GitHub's do; a label object's labels are
  evaluated too. So a guard counts by what it does, not by what it mentions: `head.repo.full_name != github.repository
  && 'ubuntu-latest' || …` is safe, the same with its branches reversed is not, `if:
  github.event.pull_request.head.repo.fork` runs the job for forks, and a job behind `if:
  github.event_name == 'push'` or `if: false` never runs for one. A `github.repository` check is no
  guard: a fork's pull_request run happens in the base repository. On `pull_request_target` a job
  counts only when a checkout step whose own `if` lets it run for a fork fetches the fork's code,
  judged from its `ref` and `repository` together: a commit is the same code from any repository
  (the head commit is the fork's, the base commit is not), and a branch name (the head's, the
  base's, a literal, or the default branch) is whatever that branch holds in the repository it is
  fetched from, so the fork's code from the fork. A string built around a value the audit cannot
  know (the fork owner's login) is unknown.
- **Confidence** confirmed on a public repository when the evaluation resolves; inferred when a
  value the audit cannot know (a `vars`, `matrix` or `inputs` value) decides it, or when the
  visibility could not be read. Not reported on a private or internal repository. GitHub's approval
  of fork workflows (by default only a first-time contributor's) is a second line the audit cannot
  read, not the guard.
- **Estimate** none: a risk, ranked first.
- **Fix** send a fork's pull requests to a GitHub-hosted runner and keep the job's own runner
  selection for everything else. The guard requires a pull request first (`github.event.pull_request
  && …`), so push, schedule and dispatch runs keep their own runners. The example wraps the job's
  `runs-on` unchanged (a whole
  expression in parentheses, a static label or list through `fromJSON`); a list with expressions
  inside or a runner group cannot be carried over unchanged, so then there is no example.
  *Trade-off:* a fork's checks then start slower, or are billed on a private repository, and a
  job that needs the self-hosted machine must skip for forks.

## self-hosted runners reused across jobs

- **Fires when** one self-hosted runner registration (one runner id) took two or more of the sampled
  jobs. An ephemeral, just-in-time runner registers anew for every job, so its id never repeats,
  even when its name does; a repeated id is a persistent runner.
- **Confidence** measured. One finding for the repository, listing the workflows.
- **Estimate** none: a risk, ranked first. A job on a persistent runner can find the workspace,
  files, processes and tool cache the job before it left.
- **Fix** ephemeral runners: one job per registration (just-in-time configuration, or
  `config.sh --ephemeral`), each from a clean directory, with a warm runner waiting so the start
  stays fast. *Trade-off:* every job re-registers, and nothing a job leaves on disk survives for
  the next, so caches go through `actions/cache` or a read-only tool cache.

## actions not pinned to a commit

- **Fires when** a workflow file (every workflow file, not only the sampled ones, up to 30) has a
  step `uses:` or a reusable-workflow job `uses:` pinned to a tag or branch rather than a full
  40-character commit SHA. A tag or branch can be moved to other code by its owner, or by anyone who
  takes over the repository. Local actions (`./`) and Docker images are not references. One finding
  for the repository; the evidence separates third-party actions from GitHub's own (`actions/`,
  `github/`).
- **Confidence** confirmed. A risk, ranked first.
- **Fix** the full commit SHA of the release, with the tag in a comment, and Dependabot or Renovate
  to propose new pins. *Trade-off:* a new release becomes a pull request to review instead of
  arriving with a moved tag.

## untrusted input in a script

- **Fires when** a `run:` script, or actions/github-script's `script` input, interpolates a field an
  outside contributor writes, per GitHub's security-hardening guide: an issue, pull request or
  discussion title or body; a comment or review body; a commit message or author; a head branch name
  or label (`github.head_ref`, `pull_request.head.ref`); a page name. The expression has to carry
  the text into the script: the field itself, an object that holds it (`toJSON(github.event)`, `toJSON(github.event.commits[0])`), or
  `format`, `join`, `||` and the right side of `&&` passing it on. A boolean result (`contains(...)`,
  a comparison, a negation), a field that only picks a branch (`title && 'yes' || 'no'`) and a field
  name inside a quoted literal are not text from outside. Property names match in any case, as
  GitHub reads them (`github.event.issue.TITLE` is the title). An expression in
  `env:` or an `if:` is not a script, and passing the value through `env:` is the fix.
- **Confidence** confirmed. A risk, ranked first. The evidence names the file, job and step.
- **Fix** an environment variable for the value, read quoted where the expression was: `"$VAR"`
  for bash and sh, `$env:VAR` for PowerShell, `process.env.VAR` for github-script. The example is
  that pattern, labelled as one, on the step it names: the expression in `env:` and the variable in
  the step's language. It is not a rewrite of the step, since a rewrite that is safe for any script
  would need a full parser for each language and every command's options. The fix also names what a
  variable does not fix: a command string or program that parses the value again (`bash -c`,
  `eval`, `ssh`, a github-script `exec`, `awk`, `sed`, `jq`), an option that runs a program
  (`tar --checkpoint-action`, `git --upload-pack`), a line written to `$GITHUB_ENV`, `$GITHUB_PATH`
  or `$GITHUB_OUTPUT` (a newline in it sets another variable; write it with a random multiline
  delimiter), and an argument that starts with a dash (put `--` before it). *Trade-off:* none to
  speak of: the step reads the same value, and only the shell no longer runs it.

## job token wider than the job

- **Fires when** a workflow or job sets `permissions: write-all` (confirmed), or a workflow has no
  top-level `permissions:` and a job without its own (inferred: the job gets the repository's
  default token, which the audit cannot read; write access on many repositories created before
  February 2023). A job that calls a reusable workflow counts the same way: with no permissions of
  its own it hands the called workflow the caller's token, which that workflow can narrow but the
  audit does not read.
- **Fix** a read-only default at the top of each workflow (`contents: read`) and each job granted
  only what it uses. *Trade-off:* a job that needs more must name it, so a missing grant shows as a
  403 the first time it runs.

## reruns

- **Fires when** any sampled run was re-attempted (run attempt above 1). One finding for the
  repository.
- **Confidence** measured.
- **Estimate** re-attempted runs a week, times each workflow's job-minutes per run.
- **Fix** find the flaky step from the failed attempts and fix or quarantine it. *Trade-off:*
  quarantining hides a real failure until someone looks.
