// Patches for a finding, written against the workflow file the audit read: a unified diff that
// `git apply` takes, made only where the change is the whole fix and nothing else in the file has to
// move. Each patch is checked before it is offered: the patched file must parse back to the workflow
// it was, plus the one block added. Where a file is not one this can patch safely, the reason is
// given instead of a patch.
import { isDeepStrictEqual } from 'node:util';
import { isMap, isScalar, parse, parseAllDocuments, parseDocument } from 'yaml';
import { CANCEL_GROUP } from './advice.mjs';
import { triggersOf } from './workflow.mjs';

const PR_TRIGGERS = ['pull_request', 'pull_request_target'];

/** The block, indented by `unit` spaces, as lines. */
function cancelBlock(unit) {
  const pad = ' '.repeat(unit);
  return ['concurrency:', `${pad}group: ${CANCEL_GROUP}`, `${pad}cancel-in-progress: true`];
}

/** The offset of the start of the line holding `offset`. */
const lineStart = (text, offset) => text.lastIndexOf('\n', offset - 1) + 1;

/**
 * A unified diff (git's form) that inserts `insert` (lines, without line ends) before the line that
 * starts at `offset` of `text`, with up to three lines of context on each side. Lines keep their own
 * ends: a file written with CRLF gets CRLF in the inserted lines too (`eol`). Pure.
 */
export function insertionPatch(path, text, offset, insert, eol = '\n') {
  const finalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (finalNewline) lines.pop();
  const at = text.slice(0, offset).split('\n').length - 1;
  const from = Math.max(0, at - 3);
  const to = Math.min(lines.length, at + 3);
  const before = lines.slice(from, at);
  const after = lines.slice(at, to);
  const cr = eol === '\r\n' ? '\r' : '';
  const body = [
    ...before.map((l) => ` ${l}`),
    ...insert.map((l) => `+${l}${cr}`),
    ...after.map((l) => ` ${l}`),
  ];
  // The last context line is the file's last and has no line end: git marks it.
  if (!finalNewline && to === lines.length && after.length) body.push('\\ No newline at end of file');
  const oldCount = before.length + after.length;
  const newCount = oldCount + insert.length;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from + 1},${oldCount} +${from + 1},${newCount} @@`,
    ...body,
    '',
  ].join('\n');
}

/**
 * The patch that adds a top-level concurrency group cancelling a pull request's outdated runs
 * (CANCEL_GROUP), for the workflow file `text` at `path`: { path, patch } or { path, refused } with
 * the reason. It refuses a file it cannot patch safely: one that does not parse, holds more than one
 * document or is not a block mapping at the top; one that already has a top-level concurrency
 * setting (adding cancel-in-progress to it is a change to review by hand); a reusable workflow
 * (workflow_call), whose group would also bind the runs that call it; one with no pull request
 * trigger; one with no top-level `jobs` at the start of a line. The block goes before `jobs`, above
 * any comment lines that sit directly on it, indented as the file indents its jobs. Pure.
 */
export function cancelOutdatedFix(path, text) {
  const no = (refused) => ({ path, refused });
  if (typeof text !== 'string' || !text.trim()) return no('the workflow file was not read');
  if (parseAllDocuments(text).length !== 1) return no('the file holds more than one YAML document');
  const doc = parseDocument(text);
  if (doc.errors.length) return no('the file does not parse as YAML');
  const top = doc.contents;
  if (!isMap(top) || top.flow) return no('the top level is not a block mapping');
  const key = (p) => (isScalar(p.key) ? String(p.key.value) : null);
  if (top.items.some((p) => key(p) === 'concurrency')) return no('the workflow already has a concurrency setting; add cancel-in-progress to it by hand');
  // A document can parse with no error and still fail to convert: an alias that names no anchor
  // (`jobs: *missing`), or more alias expansion than the parser allows.
  let js;
  try { js = doc.toJS(); } catch { return no('the file does not read as a workflow (an alias that resolves to nothing, or too many aliases)'); }
  const triggers = triggersOf(js);
  if (triggers.includes('workflow_call')) return no('a reusable workflow (workflow_call): a concurrency group here also binds the runs that call it');
  if (!triggers.some((t) => PR_TRIGGERS.includes(t))) return no('no pull request trigger');
  const jobs = top.items.find((p) => key(p) === 'jobs');
  const at = jobs?.key?.range?.[0];
  if (!Number.isInteger(at) || lineStart(text, at) !== at) return no('no top-level jobs key at the start of a line to place the group before');

  // Above the comment lines that sit directly on `jobs` (they describe it), below anything else.
  let offset = at;
  for (;;) {
    if (offset === 0) break;
    const prev = lineStart(text, offset - 1);
    if (!/^#/.test(text.slice(prev, offset))) break;
    offset = prev;
  }
  // The jobs' own indent: the column of the first job's key, else two spaces.
  const first = isMap(jobs.value) ? jobs.value.items[0]?.key?.range?.[0] : null;
  const unit = Number.isInteger(first) && first - lineStart(text, first) > 0 ? first - lineStart(text, first) : 2;
  const eol = text.slice(0, at).endsWith('\r\n') || /\r\n/.test(text) ? '\r\n' : '\n';
  const insert = [...cancelBlock(unit), ''];
  const patched = text.slice(0, offset) + insert.map((l) => l + eol).join('') + text.slice(offset);

  // The patched file must read as the workflow it was, plus the group and nothing else.
  let after;
  try { after = parse(patched); } catch { return no('the patched file does not parse; left for a hand edit'); }
  const { concurrency, ...rest } = after ?? {};
  if (!isDeepStrictEqual(rest, js) || !concurrency || concurrency.group !== CANCEL_GROUP || concurrency['cancel-in-progress'] !== true) {
    return no('the patched file does not read as the workflow plus the group; left for a hand edit');
  }
  return { path, patch: insertionPatch(path, text, offset, insert, eol) };
}
