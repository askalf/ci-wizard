# Changelog

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
