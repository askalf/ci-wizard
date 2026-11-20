// A job that calls a reusable workflow (`jobs.<id>.uses`) runs that workflow's jobs: what such a
// call scans, and how it scopes the job token, are in the called file. A local call
// (./.github/workflows/x.yml) names a file of the same repository, which the audit already read;
// a call into another repository is read from that repository at the called ref, by collect.
import { parseWorkflow } from './workflow.mjs';

const FILE = String.raw`\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml`;
const LOCAL = new RegExp(String.raw`^\./(${FILE})$`);
// The ref is any literal Git ref (a tag such as v1.0.0+build included): no whitespace, no second @.
// collect URL-encodes it in the request.
const REMOTE = new RegExp(String.raw`^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/(${FILE})@([^\s@]+)$`);
// How deep a chain of calls is followed: GitHub runs at most four levels of reusable workflows.
export const MAX_CALL_DEPTH = 4;

/**
 * The file a job's `uses:` calls, as a key: a path of this repository ('.github/workflows/x.yml'),
 * or 'owner/repo/.github/workflows/x.yml@ref' for another repository. `base` is the repository
 * and ref a remote file came from, so a local call inside it names that repository's file. Null
 * for anything else (an expression, a malformed reference). Pure.
 */
export function callKey(uses, base = null) {
  const s = String(uses ?? '').trim();
  const local = LOCAL.exec(s);
  if (local) return base ? `${base.owner}/${base.repo}/${local[1]}@${base.ref}` : local[1];
  const remote = REMOTE.exec(s);
  return remote ? `${remote[1]}/${remote[2]}/${remote[3]}@${remote[4]}` : null;
}

/** Whether a key names another repository's file. Pure. */
export const isRemoteKey = (key) => typeof key === 'string' && !key.startsWith('.github/');

/** The parts of a remote key: { owner, repo, path, ref }, or null. Pure. */
export function remoteParts(key) {
  const m = isRemoteKey(key) ? /^([^/]+)\/([^/]+)\/(\.github\/workflows\/[^@]+)@(.+)$/.exec(key) : null;
  return m ? { owner: m[1], repo: m[2], path: m[3], ref: m[4] } : null;
}

/** Every job of a workflow text that calls a reusable workflow: [{ job, uses, key }]. Pure. */
export function callsOf(text, base = null) {
  const doc = typeof text === 'string' ? parseWorkflow(text) : {};
  return Object.entries(doc.jobs || {})
    .filter(([, j]) => j && typeof j === 'object' && typeof j.uses === 'string')
    .map(([job, j]) => ({ job, uses: j.uses, key: callKey(j.uses, base) }));
}

/**
 * The text a key names: the file's text, null when it was asked for and could not be read, and
 * undefined when it is no file this audit holds (a remote call collect did not read). Pure.
 */
export function calledText(key, { files = new Map(), remote = new Map() } = {}) {
  if (!key) return undefined;
  return isRemoteKey(key) ? remote.get(key) : files.get(key);
}

/** The base a called file's own local calls resolve against: its repository and ref, or none for this repository. Pure. */
export const baseOf = (key) => (isRemoteKey(key) ? remoteParts(key) : null);
