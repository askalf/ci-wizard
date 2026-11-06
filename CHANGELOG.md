# Changelog

## Unreleased

Security scans of every workflow file (up to 30, not only the sampled workflows'):

- **actions not pinned to a commit**: a step or reusable-workflow `uses:` on a tag or branch, which
  can be moved to other code, with third-party and GitHub's own actions told apart. The fix pins
  the full SHA with the tag in a comment.
- **untrusted input in a script**: a `run:` script or github-script `script` that interpolates a
  title, body, comment, commit message or author, or a head branch name, per GitHub's hardening
  guide. The expression is parsed, so only one whose value carries that text counts: a
  `contains(...)` test, a comparison, a field that only picks a branch (`title && 'yes' || 'no'`) or a
  quoted field name does not, and property names match in any case. The example is the step
  itself with each expression moved to `env:`, read as the step's shell (or github-script) reads it,
  and is left out where that rewrite cannot be certain, including a value handed to a second parser
  (`bash -c`, `eval`, `ssh`, `jq`), where the fix says the inner program must read it as data too.
- **job token wider than the job**: `permissions: write-all` (confirmed), or no permissions block,
  leaving the repository's default token (inferred), including a reusable-workflow call that hands
  the caller's token on. The fix is a read-only default, widened per job.
- All three are risks, ranked first. The report says how many workflow files the scans read, of how
  many listed, and names any that could not be read; when the directory cannot be listed it says the
  total is unknown.

Measurement precision:

- A weekly total is now a count times a mean, never a median: run times are skewed by a few long
  runs, and the median understated the week. The table's per-run figure stays the median, labelled
  typical; the savings that multiply a per-run cost (duplicates, outdated runs, reruns) use the mean.
- Every outcome is costed at its own measured cost: up to two failed, cancelled and timed-out runs
  per sampled workflow are timed beside the successes (`cost_by_outcome` in the JSON), since a
  failure often stops early and a timeout runs to its limit. An outcome with no sampled run is
  costed like a success and named in the report. Runs that ran no job (skipped, waiting for
  approval, failed to start, stale) cost nothing.

Recommendations:

- New rule **jobs without a working timeout**: a job with no `timeout-minutes` (GitHub's default is
  360 minutes), or one more than 10 times its longest sampled run, gets a limit from its own runs:
  3 times the longest, rounded up to 5 minutes, at least 10. Matrix legs are matched to their job.
  Reported as a guard against hung jobs (`guard` unit), not a saving.

Self-hosted runners (the askalf/pitlane method, measured):

- New rule **fork pull requests run on self-hosted runners**: each job's `if` and `runs-on` are
  evaluated as GitHub would for a pull request from a fork (a small evaluator for the expression
  language, `src/expr.mjs`), so a guard counts by what it does: a job that picks a self-hosted
  runner for a fork is a risk, one whose `if` is false for it or whose `runs-on` sends it to a
  GitHub-hosted runner is not. A value the audit cannot resolve (`vars`, `matrix`) makes it
  possible, not confirmed. The example wraps the job's own runner selection unchanged.
- New rule **self-hosted runners reused across jobs**: a runner id that took two or more sampled
  jobs is a persistent runner, whose workspace and state carry between jobs. An ephemeral row that
  keeps its name but registers anew each job is not reuse.
- Both carry a `risk` unit: they rank before every saving, lead the report under "Start with", and
  the summary counts them as risks to fix before any saving.

API budget:

- When GitHub sends its `x-ratelimit-limit` header, the report states the budget the audit drew on: the calls
  made and what the token had left of its hourly limit ("41 API calls, 959 of 1000 left this
  hour"), in the CLI's summary line, the action's log, the report's "How it was measured" and the
  JSON (`rate_limit`). On a budget of 1,000 or less it names the larger one: a GitHub App's
  installation token, 5,000 or more an hour.
- A stop near the rate limit says the hourly limit it hit and how to get a larger budget.
- The README's "Rate limits" section sets up a GitHub App token for the action, with the pinned
  `actions/create-github-app-token` step and the two read permissions an audit needs.

Expert guidance:

- Every finding now carries its trade-off in the report, as docs/rules.md always described, and,
  where the fix is a change to the workflow file, the YAML for it: the setup action's cache input
  for the package manager the workflow installs with (npm, pnpm, yarn, pip, poetry, pipenv, uv,
  go, bundler) or an actions/cache step keyed on the lockfile (cargo, bun, npm with no lockfile),
  the concurrency block, the push trigger, or the checkout inputs.
- slow checkout reads the checkout step: `fetch-depth: 0`, a `fetch-depth` above 1, `lfs`,
  `submodules` or `fetch-tags` are named as the cause (confirmed); a default checkout, which
  already fetches one commit, is no longer told to set `fetch-depth: 1`, and gets sparse-checkout
  instead (inferred); with no checkout step to read, or a depth set by an expression, the cause is
  reported as unknown.
- The same-commit-twice rule reads the repository's default branch (one more API call): the push
  trigger example names it, and when it cannot be read says to fill it in, instead of assuming
  `main`, which would switch off push CI on a repository whose default branch is develop.
- `compare` reports a finding that is gone in its own unit (job-minutes, billed minutes or
  developer wait), not always as job-minutes.
- The outdated-runs fix no longer suggests an inline `{ group: ${{ ... }} }` concurrency mapping,
  which is not valid YAML; the example is a block.

Measurement:

- Runs are grouped by workflow id, not by run name. A pull request that adds a workflow gives its
  runs the pull request's title, which split one workflow into two rows (this repository's Fuzz
  appeared twice, once as "[hold] Fuzz the workflow, …"). Each workflow is labelled with the name
  most of its runs carry; two workflows sharing a name get their path appended.
- A finding that saves under 1 minute a week is left out. Queue wait and matrix size carry a
  `wait` unit and stay, reported as developer wait; before, any saving that rounded below 1 was
  mislabelled as developer wait.
- **Billed minutes**: GitHub bills each hosted job rounded up to a whole minute. Each workflow
  gets `billed_minutes_week` (self-hosted jobs count 0), the table a Billed min/week column, and
  `compare` a billed row and total.
- New rule **short hosted jobs bill a whole minute**: hosted workflows whose billed minutes are at
  least twice their job-minutes, by 30 minutes a week or more. Its saving is in billed minutes,
  and the report says so. It does not fire on a public repository, whose standard hosted runners
  are free; the report says so beside the billed figure (`visibility` in the JSON, read from the
  repository's metadata).
- Developer wait is shown only for workflows somebody waits on (mostly push, pull request or merge
  group runs); a scheduled or chained workflow shows none (`waited_on` in the JSON).
- The queue-wait evidence says how many sampled jobs its p90 is over.

Ease of use and understanding:

- The report opens with **Start with** (the first finding and its saving), then what the findings
  add up to. A finding that saves developer wait is no longer summed as "0 job-minutes".
- Each finding is its own section: where, saves, confidence, why, fix, trade-off, YAML.
- A legend explains the table: job-minutes against billed minutes, developer wait, queue, and each
  share (work, deps, overhead, head, tail and the rest).
- Step names drop their action ref (`Run actions/checkout@3d3c42e…` reads `Run actions/checkout`),
  and steps under a second are left out of the longest steps.
- `--only NAME` (CLI, repeatable or comma-separated) and the action's `only` input time just the
  named workflows, for measuring one workflow before and after a change. Names match what GitHub
  shows, so two workflows that share a name are both selected; a name with no runs is reported.
- The HTML page carries the same: billed minutes, trade-offs, examples, the legend, and a
  developer-wait tile taken from a workflow somebody waits on.

- Fuzzing: three Jazzer.js targets run weekly and on every pull request that touches them
  (`.github/workflows/fuzz.yml`), over workflow files, API run history and saved report files, with
  a persistent corpus. Jazzer is installed from `.clusterfuzzlite/`, so the package keeps no
  dependencies. `.clusterfuzzlite/` also builds the targets for a weekly ClusterFuzzLite coverage
  report.
- `ci-wizard compare` no longer crashes on two kinds of hand-edited report: a measurement that is not
  a number shows as `-`, and a report whose workflows or findings are not objects, or whose
  printed fields (the repository, a workflow name, a finding's text) are objects, is rejected with
  the usual "is not a ci-wizard --json report" message. Found by the new fuzzing.
- A workflow file whose job lists `steps` as something other than a list, or whose top level is a
  list, no longer stops the audit: it yields no steps or facts, as an unparseable file does.
- Releases are automatic, as in askalf/dario: the version bump on `main` is the release.
  `publish.yml` tags the merge commit, cuts the GitHub release with that version's CHANGELOG
  section, attaches the attested tarball (`.sigstore.json` and `.intoto.jsonl` beside it), and
  publishes to npm (still gated on `NPM_PUBLISH`). It fills only what is missing, and an hourly
  run finishes a release that failed part-way.
- `npm test` fails a version with no CHANGELOG section; CI fails an outside contributor's pull
  request that changes the version (`scripts/check-release-authority.mjs`).

## 0.1.2

Precision:

- Weekly figures no longer read high for a quiet repository: when the window holds every run, it
  covers the days asked for, not the span from the oldest run to now (which turned 10 runs on the
  last of seven days into 70 a week). Only a window cut short by the 500-run cap scales from its
  oldest run, and the report says when that happened (`window_truncated` in the JSON). `compare`
  warns when one side is a report from 0.1.1 or earlier.
- `yarn test`, `yarn lint` and other yarn scripts are work, not dependency installs; only `yarn`,
  `yarn install` and `yarn --frozen-lockfile`-style lines count as installs.
- A step that only mentions checkout (`Run checkout e2e tests`) is work; checkout means
  `actions/checkout` or a step named "Checkout" / "Check out".
- Step names with expressions (`Test on ${{ matrix.node }}`) are matched to their command, so a
  matrix job's install steps are classified by what they run.
- Runs whose jobs were all skipped no longer count toward job-minutes (`skipped_week` in the JSON).
- GitHub-hosted is read from the job's runner group; a self-hosted runner with an `ubuntu-*` label
  no longer counts as hosted (which hid its wrap-up tail).
- A workflow timed from fewer than 3 successful runs is marked † in the table and its findings say
  so (`thin_sample` in the JSON).

Ease of use and process:

- The repository can be a GitHub URL or an SSH remote, or left out inside a checkout whose origin
  is on GitHub.
- `--save file.json` keeps the JSON report while printing the markdown, as the baseline for
  `compare`; the CLI then says the command to run after the change.
- The report opens with a one-line summary (findings, their estimated total against the measured
  job-minutes) and ends with the next step: how to prove a fix with `compare`.
- With no token, the CLI warns about GitHub's anonymous limit, and a not-found repository says
  that only public ones can be read without one.
- Progress on a terminal while runs and jobs are read; the usage lists every option.

## 0.1.1

- **compare**, the method's fourth step: `ci-wizard compare before.json after.json` (and `compare`
  in the library) shows, per workflow, runs a week, job-minutes per run and per week, developer
  wait p50 and p90, queue wait p50 and p90 and the wrap-up tail, before, after and the change,
  with the findings that disappeared and the ones that appeared.
- Cache, concurrency and cancel-in-progress are read from the parsed workflow file, not from its
  raw text: `cancel-in-progress: ${{ false }}` no longer counts as cancelling, a commented-out
  `actions/cache` step no longer counts as a cache, and setup actions' cache inputs (and
  setup-go's default cache from v4) still count.
- A repository that does not exist, or that the token cannot read, now says so ("was not found,
  or the token cannot read it", exit 1) instead of reporting no runs.
- Fixed: a workflow name with a backslash before a pipe broke the report's table; backslashes
  are escaped before pipes.
- `--version`; the usage lists it and `compare`.
- README leads with the one-line install and a dated sample; issue and pull request templates,
  CODEOWNERS, and an npm publish workflow (trusted publishing, provenance, a build attestation of
  the tarball) that runs on a published release.

## 0.1.0

First release.

- Read-only audit of a repository's GitHub Actions: up to 500 runs from a window, step timings of
  the newest successful runs of the busiest workflows, the workflow files and the committed
  lockfiles.
- Time split into runner overhead, checkout, toolchain, dependencies, cache, artifacts, docker and
  work, by the command each step runs, with the time before the first step and after the last
  measured separately.
- Rules: cache dependencies, dependency installs dominate (with the no-lockfile `npm install`
  case explained), slow checkout, toolchain setup, the same commit runs twice (with the cause
  read from the push trigger and the concurrency group), outdated runs keep going, matrix size,
  self-hosted wrap-up tail, queue wait, many short jobs, runs far more often than code changes,
  many small scheduled jobs, reruns. Each finding has evidence, a confidence (confirmed,
  measured, inferred) and an estimated weekly saving; repeated kinds are grouped.
- A GitHub Action (report in the job summary, `report-path` and `findings` outputs) and a CLI
  (`ci-wizard owner/repo`, with `--json` and `--html`), bundled with no runtime dependencies.
