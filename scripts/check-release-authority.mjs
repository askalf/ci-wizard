// An outside contributor's pull request may not cut a release.
//
// The version bump on main IS the release: the merge runs publish.yml, which tags, cuts the GitHub
// release and publishes to npm with no further step (CONTRIBUTING.md, Releases). Whether and when
// to ship is the maintainer's call, so a pull request whose head lives on a fork, opened by
// someone who is not an OWNER, MEMBER or COLLABORATOR, fails when it changes the version in
// package.json, package-lock.json or src/version.mjs, or adds a release heading to CHANGELOG.md.
// Its notes go under `## Unreleased`, and a maintainer releases afterwards. Same-repository
// branches are exempt: pushing one takes write access. Ported from askalf/dario.
//
// Inputs via env, so it runs by hand too:
//   BASE_SHA            the pull request's base tip (fetched by the workflow)
//   HEAD_SHA            what to judge; in CI the pull_request merge commit
//   HEAD_REPO           owner/repo the pull request head lives in
//   GITHUB_REPOSITORY   owner/repo of this repository
//   AUTHOR_ASSOCIATION  the author's association with this repository
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** True when the pull request is an outside contributor's: a fork head and no maintainer association. */
export function isOutsideContributor({ headRepo, baseRepo, association }) {
  if (headRepo && baseRepo && headRepo === baseRepo) return false;
  return !MAINTAINER_ASSOCIATIONS.has(association ?? '');
}

/** The release headings of a CHANGELOG: `## 0.1.2` or `## [0.1.2]`, by version. */
export function releaseHeadings(text) {
  const out = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^## \[?(\d+\.\d+\.\d+)\]?(?:\s|$)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

/** The VERSION constant in src/version.mjs. */
export function sourceVersion(text) {
  const m = /VERSION\s*=\s*['"]([^'"]+)['"]/.exec(String(text ?? ''));
  return m ? m[1] : undefined;
}

/** Every release-cutting change between two states of the files, as readable lines; empty when the release is left alone. */
export function releaseChanges({ basePkg, headPkg, baseLock, headLock, baseSrc, headSrc, baseLog, headLog }) {
  const out = [];
  const diff = (what, a, b) => {
    if (a !== b) out.push(`${what} ${a} -> ${b}`);
  };
  diff('package.json version', basePkg?.version, headPkg?.version);
  diff('package-lock.json version', baseLock?.version, headLock?.version);
  diff('package-lock.json packages[""].version', baseLock?.packages?.['']?.version, headLock?.packages?.['']?.version);
  diff('src/version.mjs VERSION', sourceVersion(baseSrc), sourceVersion(headSrc));
  const base = releaseHeadings(baseLog);
  for (const v of releaseHeadings(headLog)) if (!base.has(v)) out.push(`CHANGELOG.md adds release heading ${v}`);
  return out;
}

function fileAt(rev, path) {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

export function main(env = process.env, { read = fileAt } = {}) {
  const base = env.BASE_SHA;
  const head = env.HEAD_SHA || 'HEAD';
  if (!base) {
    console.log('check-release-authority: no BASE_SHA, not a pull_request run; nothing to judge.');
    return 0;
  }
  const who = { headRepo: env.HEAD_REPO, baseRepo: env.GITHUB_REPOSITORY, association: env.AUTHOR_ASSOCIATION };
  if (!isOutsideContributor(who)) {
    console.log(`check-release-authority: ${who.association || 'unknown'} on ${who.headRepo || 'this repository'}; may cut a release.`);
    return 0;
  }
  const json = (rev, path) => {
    const text = read(rev, path);
    try {
      return text === undefined ? undefined : JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const changes = releaseChanges({
    basePkg: json(base, 'package.json'), headPkg: json(head, 'package.json'),
    baseLock: json(base, 'package-lock.json'), headLock: json(head, 'package-lock.json'),
    baseSrc: read(base, 'src/version.mjs'), headSrc: read(head, 'src/version.mjs'),
    baseLog: read(base, 'CHANGELOG.md'), headLog: read(head, 'CHANGELOG.md'),
  });
  if (!changes.length) {
    console.log('check-release-authority: outside contributor, no release-cutting change; ok.');
    return 0;
  }
  console.error('FAIL: this pull request would cut a release when it merges:');
  for (const c of changes) console.error(`  ${c}`);
  console.error('');
  console.error('Merging a version bump tags, releases and publishes to npm with no further step, so a maintainer');
  console.error('decides when to ship. Leave the version in package.json, package-lock.json and src/version.mjs as it');
  console.error('is, and put your CHANGELOG notes under `## Unreleased` instead of a new release heading.');
  return 1;
}

// Run when invoked directly; importable by the test without side effects.
let direct = false;
try {
  direct = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
} catch {
  direct = false;
}
if (direct) process.exit(main());
