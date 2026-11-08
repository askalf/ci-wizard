// What a workflow file shows that the measurements price: a toolchain setup on a self-hosted
// runner that can carry the runtime itself, whether the file starts a test runner at all (for the
// log rule), the same one-command test step twice, and an artifact of a file another step already
// published. Each reads the parsed file and names the job and step, by the name GitHub gives the
// step (stepCommands in workflow.mjs), so the step timings price the finding.
//
// The two readings that recommend removing a step (the repeat and the duplicate upload) do not
// fire on the file alone: a workflow file cannot establish that the second copy is the first
// (another directory, environment, runtime, configuration, or a destination that fails after the
// artifact went up). The file picks the candidates, and the newest sampled run's own records
// confirm them: the two steps' logs list the same tests (stepSections, testSignature, sameTests
// below), and the artifact holds the one file (zip.mjs). Without that record the rule is silent.
import { runsOnSelfHosted, shellCommands } from './workflow.mjs';

/** Commands that run a test suite, by their first words. */
const TEST_RUNNERS = [
  /^node --test\b/,
  /^(npm|pnpm|yarn|bun) (run )?(test|t)\b/,
  /^(npx |pnpm exec |pnpm dlx |yarn )?(jest|vitest|mocha|ava|tap|uvu)\b/,
  /^(python3? -m )?pytest\b/,
  /^(python3? -m )?unittest\b/,
  /^go test\b/,
  /^cargo (test|nextest run)\b/,
  /^(bundle exec )?rspec\b/,
  /^dotnet test\b/,
  /^(mvn|\.\/mvnw) (verify|test)\b/,
  /^(gradle|\.\/gradlew) (test|check)\b/,
  /^make (test|check)\b/,
  /^ctest\b/,
  /^(vendor\/bin\/)?(phpunit|pest)\b/,
];

/** Words that change how a run reports, not what it runs: two commands that differ only here are the same tests. */
const REPORTING_WITH_VALUE = /^--(test-reporter(-destination)?|reporter)(=|$)/;
const REPORTING_FLAG = /^(--(quiet|verbose|silent|no-color|color)|-(q|v|vv))$/;

/**
 * A test command's words, normalised: shell keywords before it dropped, reporting flags (and
 * their values) removed, a trailing `--` separator dropped. Null for a command that starts no
 * test runner. The words keep the shell's boundaries: `node --test "test/a b.mjs"` is three
 * words and runs one file, `node --test test/a b.mjs` is four and runs two, and only the
 * boundary-keeping key (testCommandKeys) tells them apart.
 */
function testWords(words) {
  const ws = [...words];
  while (ws.length && KEYWORDS.has(ws[0])) ws.shift();
  if (!TEST_RUNNERS.some((rx) => rx.test(ws.join(' ')))) return null;
  const out = [];
  // After a `--` a runner reads every word as an operand: `pytest -- -v` tests a directory named
  // -v, and nothing after it is a reporting flag. A package manager's `--` instead hands the rest
  // to the test script, flags included (`npm test -- --silent`), so only there the stripping
  // goes on past it.
  const forwards = /^(npm|pnpm|yarn|bun)$/.test(ws[0]);
  let literal = false;
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k];
    if (literal) {
      out.push(w);
      continue;
    }
    if (w === '--') {
      if (!forwards) literal = true;
      out.push(w);
      continue;
    }
    if (REPORTING_WITH_VALUE.test(w)) {
      if (!w.includes('=')) k++; // the value is the next word
      continue;
    }
    if (REPORTING_FLAG.test(w)) continue;
    out.push(w);
  }
  // `npm test -- --silent` with its flag gone is `npm test --`: the separator carried nothing else.
  if (out.length && out[out.length - 1] === '--') out.pop();
  return out;
}

const KEY_SEP = '\u0001';
const toKey = (words) => words.join(KEY_SEP);
/** A key's words as a command line, for the report. */
export function commandOfKey(key) {
  return String(key).split(KEY_SEP).join(' ');
}

/** A condition that runs the step after an earlier failure: exactly always() or !cancelled(), nothing compound (always() && success() does not). */
export function survivesFailure(condition) {
  return /^(\$\{\{\s*)?(always\(\)|!\s*cancelled\(\))(\s*\}\})?$/.test(String(condition ?? '').trim());
}

/** Shell commands a test step may carry beside its tests without changing what the tests are or where and how they run (an export changes the environment, a cd the directory: neither is here; `set` is read apart). */
const HARMLESS = new Set(['echo', 'true', ':', 'pwd']);

/**
 * Whether a `set` line only sets shell options (`set -e`, `set -euo pipefail`, `set -o pipefail`,
 * `set +x`). `set -- --base-url=…` assigns the positional parameters a following `pytest "$@"`
 * reads, and a bare `set` prints the environment: neither is an aside.
 */
function setsOptionsOnly(words) {
  const rest = words.slice(1);
  if (!rest.length) return false;
  // Only the options that stop or trace the script (e, u, x; pipefail, errexit, nounset, xtrace):
  // `set -f` turns globbing off and changes what `node --test test/*.mjs` receives, and the rest
  // are not known not to.
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    if (/^[-+][eux]+$/.test(w)) continue;
    if (/^[-+][eux]*o$/.test(w)) {
      if (!/^(pipefail|errexit|nounset|xtrace)$/.test(rest[k + 1] ?? '')) return false;
      k++;
      continue;
    }
    return false;
  }
  return true;
}

/** Words a shell reads as structure before the command: a command after one is still that command. */
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', '{', '(', '!', 'time', 'exec']);

/**
 * The test commands a run script starts, each normalised: shell keywords before it dropped,
 * reporting flags removed, whitespace collapsed. A script with none returns an empty list.
 */
export function testCommands(script) {
  return testCommandKeys(script).map(commandOfKey);
}

/** The same commands as boundary-keeping keys (testWords): what a repeat's identity compares. */
export function testCommandKeys(script) {
  const out = [];
  for (const words of shellCommands(script)) {
    const ws = testWords(words);
    if (ws) out.push(toKey(ws));
  }
  return out;
}

/**
 * Whether a script runs the one test command and nothing else (set and echo aside; a cd moves the
 * tests to another directory and an export changes their environment, neither is aside). Only such
 * a step is a repeat of another such step: a step with another suite, a build or an export beside
 * it keeps work that must stay.
 */
export function onlyCommand(script, command) {
  // A pipe feeds the tests their input or hands their output on (`echo postgres | npm test`,
  // `npm test | tee out.txt`), and a command or process substitution runs a command of its own
  // wherever it sits, an echo's argument included (`echo "$(cp fixtures/postgres.conf
  // backend.conf)"` picks the backend), and an input redirection of any kind feeds the tests
  // (`npm test <<EOF` with the backend in the here-document, `npm test < input`, a here-string):
  // shellCommands keeps none of them apart, so the script is read for them, and a script with any
  // of them is not one command. Nor is one with any `$`: shellCommands drops the quotes, and
  // `node --test '$FILE'` (a file named $FILE) and `node --test "$FILE"` (the file FILE names)
  // would read alike. Nor one with a backslash: it escapes a brace from expanding, and inside
  // double quotes it is an escape where inside single quotes it is a character, and the words
  // keep none of that.
  if (/\||\$|`|<|>\(|\\/.test(String(script))) return false;
  // Quotes decide whether a brace, glob or tilde expands: `node --test test/{a,b}.mjs` runs two
  // files and `node --test 'test/{a,b}.mjs'` one, and the words read alike once the quotes are
  // gone. A script with such a character beside a quote is not established as one command.
  if (/['"]/.test(String(script)) && /[{}*?[\]~]/.test(String(script))) return false;
  const commands = shellCommands(script);
  if (!commands.length) return false;
  let hits = 0;
  // `command` is the step's own test command, as a key or as a line: the step's one test command
  // must be it, with nothing else beside.
  const wanted = commandOfKey(command);
  for (const words of commands) {
    const ws = [...words];
    while (ws.length && KEYWORDS.has(ws[0])) ws.shift();
    if (!ws.length) continue;
    const tw = testWords(ws);
    if (tw) {
      if (tw.join(' ') !== wanted) return false;
      hits++;
      continue;
    }
    if (ws[0] === 'set') {
      if (!setsOptionsOnly(ws)) return false;
      continue;
    }
    // A command aside only while it touches nothing: a redirection or a pipe writes a file or
    // feeds another command (`echo postgres > backend.conf` picks the backend under test), and an
    // expansion can assign (`echo "${BACKEND:=postgres}"` sets what the tests then read), so an
    // aside carries no `$` at all.
    if (!HARMLESS.has(ws[0]) || ws.some((w) => w.includes('$') || /^(<|>|>>|\|)/.test(w) || /[<>|]/.test(w) && !/^['"]/.test(w) && w !== ws[0])) return false;
  }
  return hits > 0;
}

function jobsOf(doc) {
  return Object.entries(doc.jobs || {}).filter(([, j]) => j && typeof j === 'object');
}

function stepsOf(job) {
  return Array.isArray(job.steps) ? job.steps.filter((st) => st && typeof st === 'object') : [];
}

/** A step's name as GitHub shows it: its own, else "Run <uses>" or "Run <first line of run>". */
export function stepName(st, i = 0) {
  if (st.name) return String(st.name).trim();
  if (st.uses) return `Run ${st.uses}`;
  if (st.run !== undefined) return `Run ${String(st.run).trim().split('\n')[0]}`;
  return `step ${i + 1}`;
}

/** The text GitHub opens a run step's log group with: the script's first line, whatever the step is named. */
export function logHeader(st) {
  if (st.run === undefined) return null;
  return String(st.run).trim().split('\n')[0].trim();
}

/**
 * The same test step twice, as far as the file shows: two steps whose scripts are one and the
 * same test command and nothing else, under the same condition, in the same declared working
 * directory, with the same step environment. In one job (scope "job"), next to each other, so no
 * step between them changes the runtime, the files or the environment; or in two jobs of the run
 * (scope "workflow") that also share runs-on, job environment, container, services, run defaults,
 * and every step before the test step (the same setup leads into the same tests), with no matrix.
 * A matrix leg is one job to GitHub; the same tests on two runners, in two directories, against
 * two environments, after two setups, or under two conditions are two results, and nothing else
 * the file could tell apart is called a repeat. Each match carries the steps' log headers, so the
 * sampled run's log can say whether the same tests ran (sameTests below); the file's word alone
 * is a candidate, not a finding.
 */
export function repeatedTests(doc) {
  const found = [];
  const byCommand = new Map();
  const used = new Set();
  const key = (job, index) => `${job}\u0000${index}`;
  const text = (x) => JSON.stringify(x ?? null);
  const cond = (x) => String(x?.if ?? '').replace(/\s+/g, ' ').trim();
  const dirOf = (st, job) => String(st['working-directory'] ?? job.defaults?.run?.['working-directory'] ?? doc.defaults?.run?.['working-directory'] ?? '').trim();
  // Names compare as GitHub shows them (whitespace collapsed); a step whose shown name another step
  // of the job shares (two unnamed `run: npm test` steps) pools its timings with that step's.
  const shown = (x) => String(x).replace(/\s+/g, ' ').trim();
  for (const [id, job] of jobsOf(doc)) {
    const inJob = new Map();
    const all = stepsOf(job);
    all.forEach((st, i) => {
      if (st.run === undefined) return;
      // The command as a boundary-keeping key: `node --test "test/a b.mjs"` (one file) and
      // `node --test test/a b.mjs` (two files) read alike as a line and are two commands.
      const keys = new Set(testCommandKeys(st.run));
      if (keys.size !== 1) return;
      const [key] = keys;
      if (!onlyCommand(st.run, key)) return;
      // Everything the file says about where and how the step runs is part of its identity, and
      // none of it may be an expression: `env: SEED: ${{ steps.first.outputs.seed || 'initial' }}`
      // reads alike on two steps and resolves apart once the first has run.
      const stepKey = [key, cond(st), dirOf(st, job), text(st.env), text(st.shell)].join('\u0000');
      if (stepKey.includes('${{')) return;
      if (!inJob.has(stepKey)) inJob.set(stepKey, []);
      const name = stepName(st, i);
      const shared = name.includes('${{') || all.filter((x, k) => shown(stepName(x, k)) === shown(name)).length > 1;
      // The step's own script travels with the match: the report's example repeats it as written,
      // quoting and all, never a line rebuilt from the key's words.
      inJob.get(stepKey).push({ index: i, name, header: logHeader(st), command: commandOfKey(key), script: String(st.run).trim(), shared });
    });
    for (const [stepKey, steps] of inJob) {
      // Within the job only steps next to each other: a step between two test steps (a setup, a
      // build, a write) can change what the second one tests.
      const runs = [];
      for (const o of steps) {
        const last = runs[runs.length - 1];
        if (last && o.index === last[last.length - 1].index + 1) last.push(o);
        else runs.push([o]);
      }
      for (const run of runs) {
        if (run.length > 1) {
          found.push({ scope: 'job', jobs: [id], steps: run.map((o) => o.name), headers: run.map((o) => o.header), shared: run.map((o) => o.shared), command: run[0].command, script: run[0].script });
          for (const o of run) used.add(key(id, o.index));
        }
      }
      // The job's own identity, and every step before the test step, join the step's for the
      // cross-job scope: the same setup leads into the same tests.
      const first = steps[0];
      // A preparation step that differs only in its directory or shell (`cp backend.conf .` from
      // fixtures/sqlite against fixtures/postgres) prepares different tests.
      const before = text(all.slice(0, first.index).map((st) => ({ uses: st.uses ?? null, run: st.run ?? null, with: st.with ?? null, env: st.env ?? null, if: st.if ?? null, dir: st['working-directory'] ?? null, shell: st.shell ?? null })));
      // The deployment environment too: two jobs alike in every line, one in staging and one in
      // production, resolve the same `${{ secrets.API_URL }}` to two endpoints, and their identical
      // test listings are two results.
      const jobKey = [stepKey, text(job['runs-on']), text(job.environment), text(job.env), text(job.container), text(job.services), text(job.defaults), cond(job), before].join('\u0000');
      // An expression in any of that reads the same in two jobs and can resolve apart (`environment:
      // ${{ github.job }}` is each job's own name, and each name's own secrets): the equal text
      // establishes nothing, so such a job is no cross-job candidate. Within one job the context is
      // one, and the job's own two steps still compare.
      if (jobKey.includes('${{')) continue;
      if (!byCommand.has(jobKey)) byCommand.set(jobKey, []);
      byCommand.get(jobKey).push({ job: id, step: first.name, header: first.header, shared: first.shared, index: first.index, command: first.command, script: first.script, matrix: Boolean(job.strategy && job.strategy.matrix) });
    }
  }
  for (const where of byCommand.values()) {
    const ws = where.filter((w) => !w.matrix && !used.has(key(w.job, w.index)));
    if (ws.length > 1) {
      found.push({ scope: 'workflow', jobs: ws.map((w) => w.job), steps: ws.map((w) => w.step), headers: ws.map((w) => w.header), shared: ws.map((w) => w.shared), command: ws[0].command, script: ws[0].script });
      for (const w of ws) used.add(key(w.job, w.index));
    }
  }
  return found;
}

/** The artifact name an upload-artifact step gives: its literal `name` input, else the action's default; null for a name set by an expression. */
export function artifactNameOf(st) {
  const w = st.with && typeof st.with === 'object' ? st.with : {};
  const name = w.name === undefined || w.name === null ? 'artifact' : String(w.name).trim();
  return name.includes('${{') ? null : name;
}

/**
 * An actions/upload-artifact step whose one literal path another action step of the same job
 * already publishes with the same literal input: a SARIF file sent to code scanning
 * (github/codeql-action/upload-sarif), or a file attached to the release
 * (softprops/action-gh-release). Both actions read their input against the workspace, as
 * upload-artifact does. An upload that runs only on failure is a crash's files kept for a look,
 * not a duplicate. `after` says the destination comes after the artifact step: it can then fail
 * after the artifact went up, so that order's fix moves the artifact behind it under failure()
 * rather than dropping it. The file's word is a candidate: the sampled run's artifact must hold
 * that one file before anything is called a duplicate (analyse.mjs).
 */
export function duplicateUploads(doc) {
  const found = [];
  // An artifact another job of the workflow downloads is the workflow's own transport, whatever
  // else the file was sent to: a download-artifact step with that literal name consumes it, and
  // one with no name, a pattern, or an expression may consume any artifact of the run, so no
  // candidate stands beside it. A consumer outside the file (another workflow, a script) is not
  // visible here; the advice says so.
  let consumesAll = false;
  const consumed = new Set();
  for (const [, job] of jobsOf(doc)) {
    for (const st of stepsOf(job)) {
      if (!/^actions\/download-artifact@/.test(String(st.uses || ''))) continue;
      const w = st.with && typeof st.with === 'object' ? st.with : {};
      const name = w.name === undefined || w.name === null ? '' : String(w.name).trim();
      if (!name || name.includes('${{') || w.pattern !== undefined) consumesAll = true;
      else consumed.add(name);
    }
  }
  if (consumesAll) return found;
  for (const [id, job] of jobsOf(doc)) {
    const steps = stepsOf(job);
    steps.forEach((st, i) => {
      if (!/^actions\/upload-artifact@/.test(String(st.uses || ''))) return;
      const artifactName = artifactNameOf(st);
      if (artifactName === null || consumed.has(artifactName)) return;
      // An artifact step that runs after a failure (failure(), always(), !cancelled()) keeps a
      // failed run's file for a look, and would be the only copy when the destination is what
      // failed: never a duplicate.
      if (/failure\(\)|always\(\)|cancelled\(\)/.test(String(st.if ?? ''))) return;
      const raw = st.with && typeof st.with === 'object' ? String(st.with.path ?? '') : '';
      const paths = raw.split('\n').map((p) => p.trim()).filter(Boolean);
      if (paths.length !== 1 || /[*?[]/.test(paths[0]) || paths[0].includes('${{')) return;
      const path = paths[0].replace(/^\.\//, '');
      // A path that names one file: a directory given to upload-sarif sends its SARIF files and the
      // artifact keeps everything in it, so only a path with a file's extension and no trailing
      // slash is compared, and the artifact itself must then hold that one file (zip.mjs).
      if (!/\.[A-Za-z0-9]+$/.test(path) || path.endsWith('/')) return;
      const alsoTo = new Set();
      const same = (p) => String(p ?? '').split('\n').map((x) => x.trim().replace(/^\.\//, '')).includes(path);
      // The other destination must run whenever the artifact step runs, and a condition does not
      // establish that: a release upload behind `if: startsWith(github.ref, 'refs/tags/')` leaves
      // the artifact the only copy on every other run, and the same text on both steps can hold
      // on one and not the other (`steps.saved.outputs.artifact-id == ''` turns once the artifact
      // step has published). So the artifact step carries no condition, and a destination counts
      // with none (or, later than next, with exactly always() or !cancelled(), below): in a run
      // that succeeded, a step without a condition ran and passed.
      const guard = (s) => String(s.if ?? '').replace(/\s+/g, ' ').trim();
      if (guard(st) !== '') return;
      // The artifact step runs on success alone (above). A destination before it that fails fails
      // the job, and the artifact never goes up; a destination with no condition after it counts
      // only when it comes next, since a step between them that fails skips the destination
      // (implicit success()) after the artifact already went up, and a later destination under a
      // condition of its own counts only when that condition is exactly always() or !cancelled().
      // Whether a counted destination comes after the artifact step: it can then fail after the
      // artifact went up, so the fix for that order moves the artifact behind it under failure().
      let after = false;
      steps.forEach((other, j) => {
        if (j === i) return;
        if (guard(other) !== '' && !survivesFailure(guard(other))) return;
        // A destination allowed to fail (continue-on-error) can leave the artifact the only copy.
        if (other['continue-on-error'] !== undefined && String(other['continue-on-error']).trim().toLowerCase() !== 'false') return;
        // A destination counts only next to the artifact step, in either direction: a step between
        // them (a second scanner writing the same results.sarif) can rewrite the file, so a
        // destination before would send a report the artifact does not hold, and one after, even
        // under always(), would receive a report the artifact never held. The zip's entry name
        // says what the artifact is called, not that the file stayed the same.
        if (Math.abs(j - i) !== 1) return;
        const uses = String(other.uses || '');
        const w = other.with && typeof other.with === 'object' ? other.with : {};
        const hit = (/^github\/codeql-action\/upload-sarif@/.test(uses) && same(w.sarif_file)) ? 'code scanning' : (/^softprops\/action-gh-release@/.test(uses) && same(w.files)) ? 'the release' : null;
        if (!hit) return;
        alsoTo.add(hit);
        if (j > i) after = true;
        // A `gh release upload` in a run script is not read: whether the shell reaches it (a
        // `test ... || exit 0`, an if, a here-document) and from which directory (working-directory,
        // a cd) is not the file's to establish, and a wrong "duplicate" deletes the only copy.
      });
      if (alsoTo.size) found.push({ job: id, step: stepName(st, i), path, name: artifactNameOf(st), alsoTo: [...alsoTo], after });
    });
  }
  return found;
}

/**
 * A job's log split into its steps. The runner opens every step with `##[group]Run <text>`: the
 * action for a `uses:` step, the script's first line for a `run:` step, whatever the step is
 * named. Each section is that header and the lines up to the next step's header, timestamps and
 * colour codes stripped. A step's own output can print such a line (`::group::Run x` becomes
 * one): signaturesOf counts the sections a header opens and reads nothing when the count is not
 * the file's.
 */
export function stepSections(logText) {
  const sections = [];
  let cur = null;
  for (const raw of String(logText).split(/\r?\n/)) {
    const line = raw.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, '').replace(/\u001b\[[0-9;]*m/g, '');
    const m = /^##\[group\]Run (.*)$/.exec(line);
    if (m) {
      cur = { header: m[1].trim(), lines: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  return sections.map((s) => ({ header: s.header, text: s.lines.join('\n') }));
}

/** Lines that name one test each, by runner: TAP (node --test, tap, prove), go test -v, pytest -v, and the tick a jest, vitest or mocha listing prints before each passing test. */
const NAME_LINES = [
  /^\s*(?:ok|not ok) \d+ - (.+?)(?: # (?:SKIP|TODO)\b.*)?$/,
  /^\s*--- (?:PASS|FAIL|SKIP): (\S+)/,
  /^(\S+::\S+) (?:PASSED|FAILED|SKIPPED|XFAIL|XPASS)\b/,
  /^\s*[✓✔√] (.+?)(?: \(\d+ ?m?s\))?$/,
];

/**
 * Summary lines that count the tests a run reports, by runner. A `whole` line is the section's
 * one total (node --test, jest, vitest, pytest, mocha, maven's total, phpunit, rspec): two of
 * them in one section are two suites, and the count is unknown. A `part` line counts one unit
 * (cargo prints one per test binary and one for the doctests, with no total; dotnet one per
 * project), and the parts add up. A section with both kinds is unknown too.
 */
const COUNT_LINES = [
  { rx: /^# tests (\d+)$/, whole: true }, // node --test's TAP summary
  { rx: /^Tests:\s+(?:.*?, )?(\d+) total/, whole: true }, // jest
  { rx: /^\s*Tests\s+(?:.*?\| )?\d+ \w+ \((\d+)\)/, whole: true }, // vitest: "Tests  12 passed (12)"
  { rx: /^=+ (\d+ \w+(?:, \d+ \w+)*) in [\d.]+s(?: \([^)]*\))? =+$/, whole: true, pytest: true }, // pytest: every outcome counted, warnings not
  { rx: /^\s*(\d+) passing\b/, whole: true }, // mocha
  { rx: /^test result: \w+\. (\d+) passed; (\d+) failed/, whole: false, both: true }, // cargo test, one line per binary
  { rx: /^\[INFO\] Tests run: (\d+), Failures: \d+, Errors: \d+, Skipped: \d+$/, whole: true }, // maven's total (a per-class line carries "-- in <class>")
  { rx: /^OK \((\d+) tests?/, whole: true }, // phpunit
  { rx: /^(\d+) examples?, \d+ failures?/, whole: true }, // rspec
  { rx: /^\s*Passed!\s+-\s+Failed:\s+\d+,\s+Passed:\s+\d+,\s+Skipped:\s+\d+,\s+Total:\s+(\d+)/, whole: false }, // dotnet test, one line per project
];

/** pytest's totals: "1 passed, 1 failed, 2 skipped, 3 warnings": the outcomes that are tests, summed. */
function pytestCount(summary) {
  let n = 0;
  for (const m of summary.matchAll(/(\d+) (passed|failed|errors?|skipped|xfailed|xpassed)\b/g)) n += Number(m[1]);
  return n;
}

/**
 * What a test step's log says ran: the tests by name where the runner lists them, else the count
 * its summary gives (COUNT_LINES); null for a log that shows neither. Names come from every line
 * that names a test (a subtest's indented line included).
 */
export function testSignature(sectionText) {
  const names = [];
  let whole = null;
  let wholes = 0;
  let parts = 0;
  let hasParts = false;
  for (const line of String(sectionText).split('\n')) {
    for (const rx of NAME_LINES) {
      const m = rx.exec(line);
      if (m) {
        names.push(m[1].trim());
        break;
      }
    }
    for (const c of COUNT_LINES) {
      const m = c.rx.exec(line);
      if (!m) continue;
      const n = c.pytest ? pytestCount(m[1]) : c.both ? Number(m[1]) + Number(m[2]) : Number(m[1]);
      if (c.whole) {
        wholes++;
        whole = n;
      } else {
        hasParts = true;
        parts += n;
      }
      break;
    }
  }
  const count = wholes > 1 || (wholes === 1 && hasParts) ? null : wholes === 1 ? whole : hasParts ? parts : null;
  // Where the names are listed they are the identity, and their number the count (a summary that
  // counts only the passing tests says less than the list).
  if (names.length) return { names, count: names.length };
  if (count !== null && count > 0) return { names: null, count };
  return null;
}

/**
 * Whether two test steps' logs show the same tests: by name when both list them (the same names,
 * in any order, each as often), else by count when both give one. Null when either log shows
 * neither: nothing is then established, and the rule stays silent.
 */
export function sameTests(a, b) {
  if (!a || !b) return null;
  if (a.names && b.names) {
    const sorted = (xs) => [...xs].sort().join('\n');
    return { same: a.names.length === b.names.length && sorted(a.names) === sorted(b.names), by: 'name', count: a.names.length };
  }
  if (a.count > 0 && b.count > 0) return { same: a.count === b.count, by: 'count', count: a.count };
  return null;
}

/**
 * The signatures of the steps a repeat names, read from one job's log: the k-th candidate step
 * with a header takes the k-th section that header opens. Null when the log opens a different
 * number of sections for a header than the file has such steps (an output that printed a header
 * of its own, a step the runner never ran), or when a step has no header.
 */
export function signaturesOf(logText, headers) {
  const sections = stepSections(logText);
  const wanted = new Map();
  for (const h of headers) {
    if (h === null || h === undefined) return null;
    wanted.set(h, (wanted.get(h) || 0) + 1);
  }
  for (const [h, n] of wanted) if (sections.filter((s) => s.header === h).length !== n) return null;
  const taken = new Map();
  return headers.map((h) => {
    const k = taken.get(h) || 0;
    taken.set(h, k + 1);
    return testSignature(sections.filter((s) => s.header === h)[k].text);
  });
}

/** Whether any step of the workflow starts a test runner. The bytes of a log are not read, so this is the file's word on what a large log is likely to be. */
export function startsTests(doc) {
  return jobsOf(doc).some(([, job]) => stepsOf(job).some((st) => st.run !== undefined && testCommands(st.run).length > 0));
}

/** A runtime setup action, setting up the runtime and nothing else, on a job that runs on self-hosted runners, where the host can carry the runtime. */
export function selfHostedSetups(doc) {
  const found = [];
  for (const [id, job] of jobsOf(doc)) {
    // A literal self-hosted label: an expression that mentions self-hosted may pick a hosted runner
    // (`${{ false && 'self-hosted' || 'ubuntu-latest' }}`), and is not established.
    if (!runsOnSelfHosted(job['runs-on']) || JSON.stringify(job['runs-on'] ?? null).includes('${{')) continue;
    // A job in a container runs its steps inside that image, not on the host: the host's runtime is
    // not this job's, so the advice does not apply.
    if (job.container !== undefined && job.container !== null) continue;
    stepsOf(job).forEach((st, i) => {
      // setup-java is not here: with only a distribution and a version it still writes a Maven
      // settings.xml with the job's credentials, which a runtime baked into the host does not.
      const m = /^actions\/setup-(node|python|go|dotnet|ruby)@/.exec(String(st.uses || ''));
      if (!m) return;
      // A setup that also restores a dependency cache or signs the job in to a registry does more
      // than state a version: dropping it would lose that work, so it is not this rule's.
      const w = st.with && typeof st.with === 'object' ? st.with : {};
      const off = (k) => String(w[k] ?? '').trim().toLowerCase() === 'false';
      if (Object.keys(w).some((k) => /^(cache|cache-dependency-path|bundler-cache|registry-url|scope|always-auth|server-id|server-username|server-password|gpg-private-key|source-url|package-manager-cache)$/.test(k) && !((k === 'cache' || k === 'package-manager-cache') && off(k)))) return;
      // setup-go caches by default (v4 and later; the version is not checked, which only ever
      // keeps a step): only an explicit `cache: false` makes it a runtime-only setup.
      if (m[1] === 'go' && !off('cache')) return;
      // setup-node caches the package manager's store by itself from v5 when package.json names
      // one; a version that is not a known v4 or earlier (a SHA pin, a branch) is taken to be that
      // new, so only an explicit `package-manager-cache: false` makes it runtime-only.
      const major = /@v(\d+)(\.|$)/.exec(String(st.uses));
      if (m[1] === 'node' && !(major && Number(major[1]) <= 4) && !off('package-manager-cache')) return;
      // A step name that another step of the job shares cannot be priced from the sample (the
      // timings of both would pool): `unique` says the name is this step's alone.
      const name = stepName(st, i);
      // Names compare as GitHub shows them (whitespace collapsed), and a name with an expression
      // reaches the API expanded, so it is never established as this step's alone.
      const shown = (x) => String(x).replace(/\s+/g, ' ').trim();
      const unique = !name.includes('${{') && stepsOf(job).filter((x, k) => shown(stepName(x, k)) === shown(name)).length === 1;
      found.push({ job: id, step: name, action: `setup-${m[1]}`, unique });
    });
  }
  return found;
}
