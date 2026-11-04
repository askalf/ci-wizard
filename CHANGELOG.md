# Changelog

## Unreleased

- Releases are automatic: a version bump merged to `main` creates the tag `v<version>` and the
  GitHub release, with that version's CHANGELOG section as the notes, and then runs the npm
  publish (still gated on `NPM_PUBLISH`). `npm test` fails a version with no CHANGELOG section.

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
