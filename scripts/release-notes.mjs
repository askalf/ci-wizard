#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md, for the GitHub release notes.
//
//   node scripts/release-notes.mjs 0.1.2      (or v0.1.2)
//
// Exits 1 when the version has no section, so a release without a CHANGELOG entry fails the
// release job instead of publishing empty notes. Line-based on purpose, as in the other askalf
// repositories: no regular expression whose `$` can match the blank line after the heading.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when this file is the script node was asked to run. Compared as resolved paths, not as a
 * string glued onto `file://`: a URL percent-encodes spaces, `%` and non-ASCII, so the string form
 * can miss and the script would exit 0 with no output.
 */
export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

/** Whether a line is the heading of this version: `## 0.1.2` or `## [0.1.2]`, with an optional date after. */
function isHeading(line, version) {
  for (const head of [`## ${version}`, `## [${version}]`]) {
    if (line === head || line.startsWith(`${head} `)) return true;
  }
  return false;
}

/** The body of one version's section, up to the next `## ` heading; null when it is missing or empty. */
export function sectionFor(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => isHeading(l.trimEnd(), version));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body || null;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const version = (process.argv[2] || '').replace(/^v/, '');
  const notes = version && sectionFor(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version);
  if (!notes) {
    console.error(`release-notes: CHANGELOG.md has no section for ${version || '(no version given)'}`);
    process.exit(1);
  }
  process.stdout.write(`${notes}\n`);
}
