# Contributing to ci-wizard

Thanks for your interest in improving **ci-wizard**, a read-only audit of where a repository's
GitHub Actions time goes and what to fix first.

## Ground rules

- Be respectful. This project follows our [Code of Conduct](CODE_OF_CONDUCT.md).
- Found a security issue? **Do not open a public issue**: follow [SECURITY.md](SECURITY.md) to
  report it privately.

## Development setup

You need Node.js 20 or later.

```bash
git clone https://github.com/askalf/ci-wizard.git
cd ci-wizard
npm ci
npm test        # node:test, no network
npm run build   # bundles src/ into dist/
```

## Making a change

1. Branch off `main` and keep the change to one concern.
2. A new or changed rule comes with a synthetic fixture it must catch and a near miss it must
   leave alone (see `test/rules.test.mjs`), and an entry in `docs/rules.md`: when it fires, its
   confidence, its estimate formula, and its fix with the trade-off. A finding that names a cause
   must be able to show it from the workflow file or the run history.
3. Fixtures are synthetic. Do not add another project's real run data to the tests or the docs.
4. Run `npm test` and `npm run build`, and commit `dist/` with the change: the action runs from
   it, and CI fails when it does not match `src/`.

## What CI checks

- the tests on Node 20 and 22
- `dist/` rebuilt from `src/` with no difference
- actionlint on the workflow files
- the built action, run on this repository
- CodeQL and OpenSSF Scorecard

Redline, an automated reviewer, also reads each pull request from a branch in this repository
once it is out of draft. It reports as the `review / redline` check and posts its verdict as a
review from `sprayberry-redline`. A pull request that changes `.github/workflows/` is reviewed by
a run of the default branch's workflow files, never its own, so a change to CI cannot shape its
own review. Redline runs on a self-hosted row and only reads the pull request; a pull request
from a fork never runs its own code there.

## Releases

The version bump on `main` is the release, as in askalf/dario. A release pull request moves the
version in `package.json` (and its lockfile) and `src/version.mjs`, rebuilds `dist/`
(`npm run build`), and turns the CHANGELOG's `## Unreleased` notes into a `## <version>` section.
When it merges, `.github/workflows/publish.yml` tags that commit `v<version>`, cuts the GitHub
release with the version's CHANGELOG section as its notes (`scripts/release-notes.mjs`), naming
the pull request that bumped it, and attaches the packed tarball with its keyless Sigstore
attestation. It then runs `npm publish --provenance` with npm trusted publishing, so no npm token
is stored in the repository. Nobody tags or drafts a release by hand.

The workflow is idempotent: each run checks what has already shipped for the version (the GitHub
release, the npm version) and fills only the gaps, so a push that leaves the version alone does
nothing. An hourly run finishes a release whose first run failed part-way, and it can be run from
the Actions tab.

Two checks keep a release from going out by accident. `npm test` fails when `package.json` names a
version with no CHANGELOG section, so a release cannot ship empty notes. CI's release-authority
step (`scripts/check-release-authority.mjs`) fails a pull request from an outside contributor's
fork that changes the version or adds a release heading: whether and when to ship is a
maintainer's call, and such notes go under `## Unreleased`.

**Owner step, once:** on npmjs.com, the `ci-wizard` package's settings need a trusted publisher
for GitHub Actions with repository `askalf/ci-wizard` and workflow filename `publish.yml` (the
bare filename, no environment). Then set the repository variable `NPM_PUBLISH` to `true`: the
publish job is skipped until it is, so a release never ends in a failed publish run. If the package does not exist on npm yet, npm may require its first version to be
published once by the owner before a trusted publisher can be added; check npm's documentation at
the time.

## Conventions

- GitHub Actions are pinned to a full commit SHA with the version in a comment.
- Report wording: a saving is always an estimate; evidence comes before the fix; a fix is an
  option with its trade-off, never an order.
- PRs are squash-merged, so the PR title becomes the commit subject on `main`.
