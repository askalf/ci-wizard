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

## Releases

A release is a version bump in `package.json`, `src/version.mjs` and `CHANGELOG.md` on `main`,
then a GitHub release with the tag `v<version>`. Publishing that release runs
`.github/workflows/publish.yml`, which checks the tag against `package.json`, runs the tests,
rebuilds `dist/`, packs the tarball, attests it, and runs `npm publish --provenance` with npm
trusted publishing: no npm token is stored in the repository.

**Owner step, once:** on npmjs.com, the `ci-wizard` package's settings need a trusted publisher
for GitHub Actions with repository `askalf/ci-wizard` and workflow filename `publish.yml` (the
bare filename, no environment). Until it is set, the publish step fails with an authentication
error. If the package does not exist on npm yet, npm may require its first version to be
published once by the owner before a trusted publisher can be added; check npm's documentation at
the time.

## Conventions

- GitHub Actions are pinned to a full commit SHA with the version in a comment.
- Report wording: a saving is always an estimate; evidence comes before the fix; a fix is an
  option with its trade-off, never an order.
- PRs are squash-merged, so the PR title becomes the commit subject on `main`.
