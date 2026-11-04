// The release job publishes whatever scripts/release-notes.mjs prints, so the body a version
// ships is asserted on every pull request, and a version bump with no CHANGELOG section fails
// here, before it reaches main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sectionFor } from '../scripts/release-notes.mjs';

const log = '# Changelog\n\n## Unreleased\n\n## 0.1.20\n\n- twenty\n\n## 0.1.2\n\nPrecision:\n\n- two\n\n## [0.1.1] - 2026-11-03\n\n- one\n';

test('sectionFor: one version, up to the next heading, in either heading style', () => {
  assert.equal(sectionFor(log, '0.1.2'), 'Precision:\n\n- two');
  assert.equal(sectionFor(log, '0.1.20'), '- twenty');
  assert.equal(sectionFor(log, '0.1.1'), '- one');
  assert.equal(sectionFor(log.replace(/\n/g, '\r\n'), '0.1.2'), 'Precision:\n\n- two');
});

test('sectionFor: null for a missing version, a prefix of another, or an empty section', () => {
  assert.equal(sectionFor(log, '0.1.3'), null);
  assert.equal(sectionFor(log, '0.1'), null);
  assert.equal(sectionFor(log, 'Unreleased'), null);
});

test('the version in package.json has its CHANGELOG section', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const notes = sectionFor(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version);
  assert.ok(notes, `CHANGELOG.md needs a "## ${version}" section before ${version} can be released`);
});

// Run as the job runs it, from a path that needs URL escaping, so the main-module check is
// exercised the way a real checkout can hit it.
function runFromAwkwardPath(...args) {
  const root = mkdtempSync(join(tmpdir(), 'ciw notes %20 é-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('../scripts/release-notes.mjs', import.meta.url), join(root, 'scripts', 'release-notes.mjs'));
    writeFileSync(join(root, 'CHANGELOG.md'), log);
    return spawnSync(process.execPath, [join(root, 'scripts', 'release-notes.mjs'), ...args], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the CLI prints the notes for a v-prefixed tag', () => {
  const r = runFromAwkwardPath('v0.1.2');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Precision:\n\n- two\n');
});

test('the CLI fails, rather than printing nothing, for a version with no section', () => {
  const r = runFromAwkwardPath('v9.9.9');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no section for 9\.9\.9/);
});
