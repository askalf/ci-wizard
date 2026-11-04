// The version bump on main is the release, so an outside contributor's pull request may not
// carry one (scripts/check-release-authority.mjs, run by ci.yml on pull requests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOutsideContributor, main, releaseChanges, releaseHeadings, sourceVersion } from '../scripts/check-release-authority.mjs';

const pkg = (version) => ({ name: 'ci-wizard', version });
const lock = (version) => ({ name: 'ci-wizard', version, packages: { '': { version } } });
const src = (version) => `// The package version\nexport const VERSION = '${version}';\n`;
const log = (...versions) => `# Changelog\n\n## Unreleased\n\n- pending\n\n${versions.map((v) => `## ${v}\n\n- notes\n`).join('\n')}`;
const state = (v, ...logged) => ({ pkg: pkg(v), lock: lock(v), src: src(v), log: log(...logged) });
const changes = (a, b) => releaseChanges({
  basePkg: a.pkg, headPkg: b.pkg, baseLock: a.lock, headLock: b.lock, baseSrc: a.src, headSrc: b.src, baseLog: a.log, headLog: b.log,
});

test('isOutsideContributor: a fork head without a maintainer association', () => {
  assert.equal(isOutsideContributor({ headRepo: 'someone/ci-wizard', baseRepo: 'askalf/ci-wizard', association: 'CONTRIBUTOR' }), true);
  assert.equal(isOutsideContributor({ headRepo: 'someone/ci-wizard', baseRepo: 'askalf/ci-wizard', association: 'NONE' }), true);
  assert.equal(isOutsideContributor({ headRepo: 'someone/ci-wizard', baseRepo: 'askalf/ci-wizard', association: 'COLLABORATOR' }), false);
  assert.equal(isOutsideContributor({ headRepo: 'askalf/ci-wizard', baseRepo: 'askalf/ci-wizard', association: 'NONE' }), false);
});

test('releaseHeadings and sourceVersion read both heading styles and the VERSION constant', () => {
  assert.deepEqual([...releaseHeadings('## Unreleased\n## 0.1.2\n## [0.1.1] - 2026-11-03\n### 1.0.0 not a release\n')], ['0.1.2', '0.1.1']);
  assert.equal(sourceVersion(src('0.1.2')), '0.1.2');
  assert.equal(sourceVersion('nothing here'), undefined);
});

test('releaseChanges: a bump is every version field and the new heading; notes under Unreleased are not', () => {
  const base = state('0.1.2', '0.1.2', '0.1.1');
  assert.deepEqual(changes(base, { ...base, log: base.log.replace('- pending', '- pending\n- another') }), []);
  const bumped = changes(base, state('0.1.3', '0.1.3', '0.1.2', '0.1.1'));
  assert.equal(bumped.length, 5, bumped.join('\n'));
  assert.ok(bumped.includes('package.json version 0.1.2 -> 0.1.3'));
  assert.ok(bumped.includes('src/version.mjs VERSION 0.1.2 -> 0.1.3'));
  assert.ok(bumped.includes('CHANGELOG.md adds release heading 0.1.3'));
  // A heading added on its own still cuts a release's notes, and is caught.
  assert.deepEqual(changes(base, { ...base, log: log('0.1.3', '0.1.2', '0.1.1') }), ['CHANGELOG.md adds release heading 0.1.3']);
});

function run(env, files) {
  const read = (rev, path) => files[rev][path];
  const lines = { out: [], err: [] };
  const log0 = console.log;
  const err0 = console.error;
  console.log = (m) => lines.out.push(m);
  console.error = (m) => lines.err.push(m);
  try {
    return { code: main(env, { read }), ...lines };
  } finally {
    console.log = log0;
    console.error = err0;
  }
}
const files = (s) => ({ 'package.json': JSON.stringify(s.pkg), 'package-lock.json': JSON.stringify(s.lock), 'src/version.mjs': s.src, 'CHANGELOG.md': s.log });
const fork = { BASE_SHA: 'base', HEAD_SHA: 'head', HEAD_REPO: 'someone/ci-wizard', GITHUB_REPOSITORY: 'askalf/ci-wizard', AUTHOR_ASSOCIATION: 'CONTRIBUTOR' };

test('main: an outside contributor bumping the version fails and says what to do instead', () => {
  const r = run(fork, { base: files(state('0.1.2', '0.1.2')), head: files(state('0.1.3', '0.1.3', '0.1.2')) });
  assert.equal(r.code, 1);
  assert.match(r.err.join('\n'), /would cut a release/);
  assert.match(r.err.join('\n'), /## Unreleased/);
});

test('main: the same bump from a maintainer, or a fork leaving the version alone, passes', () => {
  const bump = { base: files(state('0.1.2', '0.1.2')), head: files(state('0.1.3', '0.1.3', '0.1.2')) };
  assert.equal(run({ ...fork, AUTHOR_ASSOCIATION: 'OWNER' }, bump).code, 0);
  assert.equal(run({ ...fork, HEAD_REPO: 'askalf/ci-wizard', AUTHOR_ASSOCIATION: 'NONE' }, bump).code, 0);
  const same = files(state('0.1.2', '0.1.2'));
  assert.equal(run(fork, { base: same, head: same }).code, 0);
  assert.equal(run({}, {}).code, 0);
});
