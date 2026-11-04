// Fuzz `ci-wizard compare before.json after.json`: two report files a person hands to the CLI,
// which may be hand-edited, truncated, from another tool or from a different ci-wizard version.
// The input is the "before" file, a NUL byte, then the "after" file (JSON cannot hold a raw NUL,
// so the split never lands inside a document); with no NUL the one document is both sides. The
// run goes through the real command, files and all, so the report check in the CLI is part of
// what is tested. Contract: main returns an exit code (0 for a comparison, 1 for a file it
// rejects) and never throws; a comparison prints a markdown report on stdout.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'ci-wizard-fuzz-'));
const beforePath = path.join(dir, 'before.json');
const afterPath = path.join(dir, 'after.json');

function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

export async function fuzz(data) {
  const nul = data.indexOf(0);
  const before = nul === -1 ? data : data.subarray(0, nul);
  const after = nul === -1 ? data : data.subarray(nul + 1);
  writeFileSync(beforePath, before);
  writeFileSync(afterPath, after);

  const stdout = sink();
  const stderr = sink();
  const code = await main(['compare', beforePath, afterPath], { stdout, stderr, env: {} });
  if (code !== 0 && code !== 1) throw new Error(`compare exited with ${code}`);
  if (code === 0 && !stdout.text().startsWith('# CI comparison')) throw new Error('a comparison did not print the report');
  if (code === 1 && !stderr.text().startsWith('ci-wizard: ')) throw new Error('a rejected file did not print a ci-wizard error');
}
