# ci-wizard

Where your GitHub Actions time goes, and what to fix first. ci-wizard reads a repository's
workflow runs, jobs and workflow files from the GitHub API, times every sampled step, finds the
patterns that cost the most (installs with no cache, the same commit run twice, outdated runs
nobody cancels, a workflow that fires far more often than code changes), and checks the
workflow file for the cause before it says so. Every finding carries its evidence, a confidence
and an estimated weekly saving, and every fix is written as an option with its trade-off. It is
read-only: nothing is written to the repository.

```sh
npx github:askalf/ci-wizard#v0.1.2 owner/repo
```

```text
# CI audit: askalf/dario   (500 runs over 0.71 days, 8 workflows sampled, 54 API calls)
1. many small scheduled jobs (measured): 5 periodic workflows each run a job of under
   30 s, and each pays its own setup, checkout and wrap-up. about 109 job-min/week (estimate)
2. self-hosted wrap-up tail in 7 workflows (measured): median 4 s after the last step
   before the job reports done (GitHub-hosted is about 2 s). about 104 job-min/week (estimate)
3. runs far more often than code changes in Fleet status (measured): 1746 runs a week,
   79% of its job time fixed cost. about 104 job-min/week (estimate)
| Workflow      | Runs/week | Job-min/week | Developer wait p50 / p90 | Biggest shares          |
| Fleet status  | 1746      | 262          | 21 s / 43 s              | tail 42%, overhead 21%  |
```

That is an abridged run on [askalf/dario](https://github.com/askalf/dario), one of ours, on
2026-11-03 at 12:35 UTC, from `ci-wizard askalf/dario --json` (v0.1.1, run from a checkout as
`node bin/ci-wizard.mjs askalf/dario --json`). The full result is
[docs/samples/askalf-dario.json](docs/samples/askalf-dario.json); `ci-wizard` renders it as the
markdown report shown in the job summary. A run takes a few seconds on a small repository (4 s
and 12 API calls on this one) and about half a minute on a busy one (26 s and 54 calls for
dario's 500 runs).

## Quick start

### As a GitHub Action

```yaml
name: CI audit
on:
  workflow_dispatch:
  schedule:
    - cron: '0 6 * * 1'
permissions:
  actions: read
  contents: read
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: askalf/ci-wizard@v0.1.2
```

Pin it to the release commit's full SHA in your workflows. The report lands in the job summary
and in `$RUNNER_TEMP/ci-wizard/report.md` (with `report.json` beside it). Inputs: `repository`
(default: the one the workflow runs in), `token` (default: the job's token), `days` (7),
`workflows` (8), `per-workflow` (5). Outputs: `report-path`, `findings`. The audit never fails
the job for what it finds; it fails only when it cannot read the repository.

### From the command line

```sh
npx github:askalf/ci-wizard#v0.1.2 owner/repo
npx github:askalf/ci-wizard#v0.1.2 https://github.com/owner/repo --save before.json
npx github:askalf/ci-wizard#v0.1.2 owner/repo --days 14 --json > before.json
npx github:askalf/ci-wizard#v0.1.2 owner/repo --html audit.html
npx github:askalf/ci-wizard#v0.1.2 compare before.json after.json
npx github:askalf/ci-wizard#v0.1.2 --version
```

The token comes from `GITHUB_TOKEN` or `GH_TOKEN`, or from `gh auth token` when the GitHub CLI is
signed in. The repository is `owner/repo`, a GitHub URL or an SSH remote; left out, it is the
origin of the git checkout you run in. Options: `--days`, `--workflows`, `--per-workflow`,
`--json`, `--save <file>` (the JSON report beside the markdown, as a baseline for `compare`),
`--html <file>`, `--version`. Exit codes: 0 report written, 1 the repository was not found or not readable, no
runs in the window, or an API error, 2 usage, 3 stopped near the rate limit.

## The method

1. **Measure.** Each sampled job's steps, timed from the Actions API: queue wait, run time, and
   the time before the first step and after the last.
2. **Diagnose.** Time split into runner overhead, checkout, toolchain, dependencies, cache,
   artifacts, docker and work, by the command each step runs (read from the workflow file), not
   only by its name.
3. **Confirm.** The workflow file is parsed for the cause: triggers and push branch patterns,
   caches (including a setup action's cache input), concurrency and cancel-in-progress, how
   dependencies install, whether a lockfile is committed. A commented-out step or a feature
   switched off with `false` never counts.
4. **Prove.** Save the report with `--save before.json` (or `--json`) before the change. After the change has run for a
   while, measure again and run `ci-wizard compare before.json after.json`: per workflow, the
   runs a week, job-minutes, developer wait, queue wait and wrap-up tail before and after, with
   the change, and the findings that disappeared or appeared.

## What it reads and what it needs

- Up to 500 workflow runs from the window, the jobs and steps of the newest successful runs of
  the busiest workflows, those workflows' files, and the repository's root listing (to see which
  lockfile it commits). About 50 API calls for the defaults on a busy repository.
- A token with **actions: read** and **contents: read**. The job's own `GITHUB_TOKEN` is enough
  for the repository a workflow runs in; a fine-grained token with those two permissions works
  from the command line. A repository the token cannot see reads as not found.
- The client stops before the token's rate limit runs out and says how many calls were left, so
  an audit never spends the budget a team's own CI needs.
- `compare` reads two saved reports and needs no token.

## Limitations

- **Sampled.** The window is up to 500 runs, and job-level timing comes from a few recent
  successful runs of each busy workflow. A busy repository's 500 runs may cover less than a day;
  weekly figures scale the window to 7 days, so a short window is noisier, and the report says
  when the cap cut the window short. A workflow timed from fewer than 3 runs is marked †.
- **Estimates.** Savings come from simple formulas over measured time (see
  [docs/rules.md](docs/rules.md)), not from running the fix. `compare` on a run after the change
  is what proves one.
- **GitHub-hosted and self-hosted differ.** The wrap-up tail and queue-wait rules mean different
  things on each; the report says which runners a workflow used. Self-hosted runners far from
  GitHub's service region pay more per uploaded log.
- **Names and files.** A step is classified by its command when the workflow file gives one, by
  its name otherwise; reusable workflows and composite actions are read only as far as their
  calling step.
- **Options, not orders.** A fix can disagree with a repository's own history: dario keeps
  cancel-in-progress off for its status job on purpose, because cancelled queued runs piled up
  there before.

## Development

```sh
npm ci
npm test          # node:test, no network
npm run build     # bundles src/ into dist/ (committed; the action runs from it)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

MIT
