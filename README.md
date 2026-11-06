# ci-wizard

**Where your GitHub Actions time goes, and what to fix first.**

[![CI](https://github.com/askalf/ci-wizard/actions/workflows/ci.yml/badge.svg)](https://github.com/askalf/ci-wizard/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/askalf/ci-wizard/badge)](https://scorecard.dev/viewer/?uri=github.com/askalf/ci-wizard)
[![npm](https://img.shields.io/npm/v/ci-wizard)](https://www.npmjs.com/package/ci-wizard)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

ci-wizard reads a repository's workflow runs, jobs and workflow files from the GitHub API, times
every sampled step, and finds the patterns that cost the most: installs with no cache, the same
commit run twice, outdated runs nobody cancels, a workflow that fires far more often than code
changes. It checks the workflow file for the cause before it says so. It also scans every workflow
file for the security mistakes a supply-chain review starts with.

Every finding carries its evidence, how sure it is, and an estimated weekly saving. Every fix is an
option with its trade-off, and comes with YAML written for that workflow's own steps.

- **Read-only.** It sends only GET requests to the GitHub API and never writes to the repository.
- **No dependencies at run time.** One bundled file. Releases are built in CI with an attested
  provenance.
- **Measured, not guessed.** Each number says how it was measured, and the `compare` command shows
  whether a fix worked.

## Quick start

### As a GitHub Action

```yaml
name: CI audit
on:
  workflow_dispatch:
  schedule:
    - cron: '17 6 * * 1'
permissions:
  actions: read
  contents: read
jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: askalf/ci-wizard@ab1dd192931c91d56058c57f68fe9e3004d362aa # v0.2.0
```

Pin the action to a release commit's full SHA, not to a tag: ci-wizard's own scan flags a tag pin,
because a tag can be moved to other code. This prints the SHA of a release:

```sh
gh api repos/askalf/ci-wizard/commits/v0.2.0 --jq .sha
```

Dependabot or Renovate then propose new pins as releases come.

The report lands in the job summary, and in `$RUNNER_TEMP/ci-wizard/report.md` with `report.json`
beside it. An audit never fails the job for what it finds. It fails only when it cannot read the
repository.

| Input | Default | |
| --- | --- | --- |
| `repository` | the one the workflow runs in | `owner/name` |
| `token` | the job's token | needs `actions: read` and `contents: read` |
| `days` | `7` | days of runs to read (up to 500 runs) |
| `workflows` | `8` | busiest workflows to time job by job |
| `per-workflow` | `5` | newest successful runs of each to time |
| `only` | | workflow names, comma-separated, to time those instead |

Outputs: `report-path`, `findings`.

### From the command line

```sh
npx ci-wizard@0.2.0 owner/repo
npx ci-wizard@0.2.0 owner/repo --save before.json      # keep a baseline
npx ci-wizard@0.2.0 owner/repo --html audit.html       # a self-contained page
npx ci-wizard@0.2.0 owner/repo --only CI --json        # one workflow, as JSON
npx ci-wizard@0.2.0 compare before.json after.json     # did the fix work?
```

You can name the repository as `owner/repo`, a GitHub URL or an SSH remote. Leave it out and the
CLI uses the origin of the checkout you run it in.

The token comes from `GITHUB_TOKEN` or `GH_TOKEN`, otherwise from `gh auth token`. The GitHub
CLI's token usually has write access to all your repositories. ci-wizard sends it only as GET
requests to the API, but a fine-grained token with just **actions: read** and **contents: read**
is the least you can grant.

`ci-wizard --help` lists every option. Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | report written |
| 1 | repository not found or not readable, no runs in the window, or an API error |
| 2 | usage error |
| 3 | stopped near the rate limit |

## What a report looks like

An excerpt of a real run on [askalf/ci](https://github.com/askalf/ci), one of ours, on 2026-11-06
(500 runs over 3.75 days, 70 API calls, 9 seconds):

```text
# CI audit: askalf/ci

Start with: self-hosted wrap-up tail in 4 workflows: about 24 job-min/week (estimate).

The sampled workflows use about 721 job-minutes a week (698 minutes on GitHub-hosted runners
as GitHub rounds them, free on a public repository's standard runners).

1. self-hosted wrap-up tail (measured): median 5 s after the last step before the job
   reports done (GitHub-hosted is about 2 s)
   Fix: fewer steps per job, and a runner close to GitHub's service region.
   Trade-off: merging steps merges their logs.
3. jobs without a working timeout (measured): job analyze (timeout-minutes 20; longest of
   10 sampled runs 82 s): a hung run holds its runner for up to 20 minutes
       jobs:
         analyze:
           timeout-minutes: 10   # 3x its longest sampled run

| Workflow        | Runs/week | Job-min/week | Developer wait p50 / p90 | Biggest shares                 |
| CodeQL          | 112       | 235          | 78 s / 92 s              | work 89%, tail 5%, checkout 3% |
| Redline pin bump| 202       | 125          | -                        | work 50%, tail 13%, overhead 11% |
```

The full result is [docs/samples/askalf-ci.json](docs/samples/askalf-ci.json). The action renders it
as the markdown report in the job summary, and `--html` renders it as a page.

## What it finds

**Security risks come first.** They are ranked before any saving:

| Finding | What it means |
| --- | --- |
| actions not pinned to a commit | a `uses:` on a tag or branch, which its owner (or anyone who takes over the repository) can move to other code |
| untrusted input in a script | a pull request title, branch name, comment or commit message pasted into a `run:` or github-script, directly or through `env:` |
| job token wider than the job | `permissions: write-all`, or no permissions block, so the job gets the repository's default token |
| fork pull requests run on self-hosted runners | a fork's code can reach your runner |
| self-hosted runners reused across jobs | a persistent runner lets a job see what the one before left |
| merges do not wait for any check | pull requests get checks, but the default branch requires none, so a red pull request can merge |
| required checks no pull request reports | a required check bound to GitHub Actions that no recent completed pull request run produced (a renamed job, a path filter): GitHub waits for it forever |
| no workflow checks pull requests | no workflow file triggers on `pull_request`, and none ran on one |
| no code scanning | no CodeQL workflow and no default-setup run |
| no dependency updates | no Dependabot or Renovate configuration, so pinned actions never move to fixed versions |

**Guards** save no minutes, so they are listed after the findings that save time:

| Finding | What it means |
| --- | --- |
| jobs without a working timeout | a hung job holds its runner for up to 6 hours before GitHub stops it |
| pull request checks merges do not wait for | a test, build, analysis or fuzzing check pull requests get that the default branch doesn't require, judged by its name |

**Then the savings.** Each is estimated from measured timings. The cause is confirmed against the
workflow file wherever the file says (*confirmed*), and is labelled *cause inferred* where it
doesn't, such as a checkout step whose depth is set by an expression:

| Finding | |
| --- | --- |
| cache dependencies, dependency installs dominate | installs that run uncached, or dominate the job |
| slow checkout, toolchain setup | full history, LFS, submodules, a setup that could be cached |
| the same commit runs twice, outdated runs keep going | push and pull request both firing; no cancel-in-progress |
| runs far more often than code changes, many small scheduled jobs | fixed cost paid on every run |
| short hosted jobs bill a whole minute, many short jobs, matrix size | GitHub rounds each hosted job up to a minute |
| self-hosted wrap-up tail, queue wait, reruns | time after the last step, waiting for a runner, flaky reruns |

[docs/rules.md](docs/rules.md) gives each rule's threshold, its confidence, how its saving is
estimated, and the near misses it leaves alone.

## Security model

People run this on their own repositories, so it is designed to be safe to point at one, including
one that has a hostile contributor.

- **What it reads.** Through the API only, these endpoints:
  - `GET /repos/{repo}/actions/runs` (up to 500 runs), `/actions/runs/{id}/jobs` and
    `/actions/workflows`;
  - `/contents/.github/workflows`, the workflow files (up to 30), the root listing (to see which
    lockfile is committed) and the `.github` listing (for Dependabot's configuration);
  - `/repos/{repo}` (default branch and visibility);
  - `/rules/branches/{default branch}` and `/branches/{default branch}`, for the checks a merge
    must wait for. These need only the read access every token has.

  Nothing is cloned, and nothing from the repository is run.
- **What it sends, and where.** The token goes only as the `Authorization` header of those GET
  requests. They go to `api.github.com`, or to the https API that `GITHUB_API_URL` names, as on
  GitHub Enterprise Server. The token is not logged, and it is not written to a report or an output.
- **What it writes.** The CLI prints the report (or `--json`) to stdout, and writes only the files
  you name with `--save` or `--html`. The action writes only under `$RUNNER_TEMP/ci-wizard` and to
  the job summary.
- **Hostile input.** Workflow, job and step names, file names and expressions are written by
  whoever can push or open a pull request, and they are treated that way:
  - every report renders them as text: no markup, link, image, mention or terminal control code;
  - the matching ci-wizard does on that text takes linear time, so a crafted name or value can't
    stall the audit (YAML is parsed by the bundled yaml library, with its alias limits);
  - each request has a 30-second deadline and a 20 MB cap.

  [SECURITY.md](SECURITY.md) lists what is in scope, and how to report a vulnerability privately.
- **What you can verify.**
  - Releases are built, tested and packed in GitHub Actions. The tarball carries a Sigstore
    attestation (`gh attestation verify <tarball> --owner askalf`), and the npm package has npm
    provenance.
  - `dist/` is rebuilt in CI and must match `src/` byte for byte.
  - Every action this repository uses is pinned to a commit.

## Reading the report

- **Start with** names the one finding to fix first. The paragraph under it says what all the
  findings add up to, against the job-minutes (and billed minutes) the sampled workflows use.
- **What to fix first.** Each finding gives:
  - where it is and what it saves (job-minutes, billed minutes, or developer wait);
  - how sure it is: *confirmed* by the workflow file, *measured*, or *cause inferred*;
  - the evidence, the fix and the fix's trade-off;
  - the YAML for the fix, where the fix changes the workflow file.
- **Where the time goes.** Per workflow:
  - runs a week, job-minutes, and billed minutes (GitHub rounds each hosted job up to a minute);
  - developer wait (only for workflows somebody waits on), and queue wait;
  - the biggest shares of job time.

  † marks a workflow timed from fewer than 3 runs; ‡ marks one nobody waits on.
- **How it was measured.** The API budget the audit drew on, and how each figure is computed. It
  also says what the security scans don't check, so an empty section isn't over-read.

## The method

1. **Measure.** Each sampled job's steps are timed from the Actions API: queue wait, run time, and
   the time before the first step and after the last.
2. **Diagnose.** Time is split into runner overhead, checkout, toolchain, dependencies, cache,
   artifacts, docker and work. Each step is classified by the command it runs, read from the
   workflow file, not only by its name.
3. **Confirm.** The workflow file is parsed for the cause:
   - triggers and push branch patterns;
   - caches, including a setup action's cache input;
   - concurrency and cancel-in-progress;
   - how dependencies install, and whether a lockfile is committed.

   A commented-out step, or a feature switched off with `false`, never counts.
4. **Prove.** Save the report before the change (`--save before.json`). Let the change run for a
   while, measure again, and run `ci-wizard compare before.json after.json`. For each workflow it
   shows what moved, and which findings disappeared or appeared.

## Requirements and limits

- **Token.** It needs **actions: read** and **contents: read**. A workflow's own `GITHUB_TOKEN`
  is enough for the repository it runs in. A repository the token cannot see reads as not found.
- **Cost.** About 50 to 80 API calls for a busy repository, made up to six at a time. That is
  about 10 seconds for 500 runs.
- **Rate limit.** While GitHub reports the remaining count (api.github.com does), the client sends
  no more requests once the token has 25 calls or fewer left, counting the ones in flight. That
  leaves at least 25 for the repository's own CI, and the report says how many were left. An API
  that reports no count gives the reserve nothing to hold against, so it can't be enforced, and
  the report says so.
- **Behind a proxy** (`HTTPS_PROXY`, as on many self-hosted runners), the CLI and the action use
  it on Node 22.21 and later. On an older Node they warn that the proxy is ignored.
- **Node.** The CLI needs Node 20 or later. The action runs on the runner's Node 24.

### A GitHub App token for a larger budget

A workflow's `GITHUB_TOKEN` has 1,000 requests an hour, shared with every other step that calls the
API. A GitHub App's installation token has its own 5,000 or more, and one App can audit many
repositories. Create a private App with **Actions: read** and **Contents: read**, install it, keep
its client ID as a variable and its key as a secret, and mint a token in the job:

```yaml
    steps:
      - id: app
        uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
        with:
          client-id: ${{ vars.CI_WIZARD_APP_CLIENT_ID }}
          private-key: ${{ secrets.CI_WIZARD_APP_KEY }}
          owner: ${{ github.repository_owner }}
          permission-actions: read
          permission-contents: read
      - uses: askalf/ci-wizard@ab1dd192931c91d56058c57f68fe9e3004d362aa # v0.2.0
        with:
          token: ${{ steps.app.outputs.token }}
```

The token lasts an hour and is revoked when the job ends.

## Limitations

- **Sampled.** The window is up to 500 runs. Job-level timing comes from a few recent successful
  runs of each busy workflow, plus up to two failed, cancelled and timed-out runs each, for their
  cost.
  - Weekly figures scale the window to 7 days. A busy repository's 500 runs can cover less than a
    day, so its figures are noisier, and the report says when the cap cut the window short.
- **Estimates.** Savings come from simple formulas over measured time ([docs/rules.md](docs/rules.md)),
  not from running the fix. Only `compare`, run after the change, proves one.
- **Billed minutes are minutes, not money.** They round each hosted job up as GitHub does. But
  larger runners, Windows and macOS cost more per minute, and a plan's included minutes are not
  subtracted. A public repository's standard runners are free, and the report says so.
- **The scans are a first pass, not an audit.** They don't check:
  - `pull_request_target` or `workflow_run` jobs that run a fork's code or artifacts;
  - composite actions under `.github/actions`;
  - reusable workflows in other repositories.

  Fork exposure and runner reuse are judged from the sampled workflows.
- **Options, not orders.** A fix can disagree with a repository's own history. For example, a
  status job may keep cancel-in-progress off on purpose.

## Development

```sh
npm ci
npm test          # node:test, no network
npm run build     # bundles src/ into dist/ (committed; the action runs from it)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).

## License

MIT
