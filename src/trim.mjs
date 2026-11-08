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

/** Flags that change how a run reports, not what it runs: two commands that differ only here are the same tests. */
const REPORTING = [
  /\s--test-reporter(-destination)?(=\S+|\s+\S+)/g,
  /\s--reporter(=\S+|\s+\S+)/g,
  /\s--(quiet|verbose|silent|no-color|color)\b/g,
  /\s-(q|v|vv)\b/g,
];

/** A condition that runs the step after an earlier failure: exactly always() or !cancelled(), nothing compound (always() && success() does not). */
export function survivesFailure(condition) {
  return /^(\$\{\{\s*)?(always\(\)|!\s*cancelled\(\))(\s*\}\})?$/.test(String(condition ?? '').trim());
}

/** Shell commands a test step may carry beside its tests without changing what the tests are or where and how they run (an export changes the environment, a cd the directory: neither is here). */
const HARMLESS = new Set(['set', 'echo', 'true', ':', 'pwd']);

/** Words a shell reads as structure before the command: a command after one is still that command. */
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', '{', '(', '!', 'time', 'exec']);

/**
 * The test commands a run script starts, each normalised: shell keywords before it dropped,
 * reporting flags removed, whitespace collapsed. A script with none returns an empty list.
 */
export function testCommands(script) {
  const out = [];
  for (const words of shellCommands(script)) {
    const ws = [...words];
    while (ws.length && KEYWORDS.has(ws[0])) ws.shift();
    let cmd = ws.join(' ');
    if (!TEST_RUNNERS.some((rx) => rx.test(cmd))) continue;
    for (const rx of REPORTING) cmd = cmd.replace(rx, '');
    // `npm test -- --silent` with its flag gone is `npm test --`: the separator carried nothing else.
    out.push(cmd.replace(/\s+/g, ' ').replace(/\s--$/, '').trim());
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
  // `npm test | tee out.txt`): shellCommands drops the operator, so the script is read for it.
  if (/\|/.test(String(script))) return false;
  const commands = shellCommands(script);
  if (!commands.length) return false;
  let hits = 0;
  for (const words of commands) {
    const ws = [...words];
    while (ws.length && KEYWORDS.has(ws[0])) ws.shift();
    if (!ws.length) continue;
    let cmd = ws.join(' ');
    if (TEST_RUNNERS.some((rx) => rx.test(cmd))) {
      for (const rx of REPORTING) cmd = cmd.replace(rx, '');
      if (cmd.replace(/\s+/g, ' ').replace(/\s--$/, '').trim() !== command) return false;
      hits++;
      continue;
    }
    // A command aside only while it touches nothing: a redirection or a pipe writes a file or
    // feeds another command (`echo postgres > backend.conf` picks the backend under test).
    if (!HARMLESS.has(ws[0]) || ws.some((w) => /^(<|>|>>|\|)/.test(w) || /[<>|]/.test(w) && !/^['"]/.test(w) && w !== ws[0])) return false;
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
      const commands = new Set(testCommands(st.run));
      if (commands.size !== 1) return;
      const [command] = commands;
      if (!onlyCommand(st.run, command)) return;
      // Everything the file says about where and how the step runs is part of its identity.
      const stepKey = [command, cond(st), dirOf(st, job), text(st.env), text(st.shell)].join('\u0000');
      if (!inJob.has(stepKey)) inJob.set(stepKey, []);
      const name = stepName(st, i);
      const shared = name.includes('${{') || all.filter((x, k) => shown(stepName(x, k)) === shown(name)).length > 1;
      inJob.get(stepKey).push({ index: i, name, header: logHeader(st), command, shared });
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
          found.push({ scope: 'job', jobs: [id], steps: run.map((o) => o.name), headers: run.map((o) => o.header), shared: run.map((o) => o.shared), command: run[0].command });
          for (const o of run) used.add(key(id, o.index));
        }
      }
      // The job's own identity, and every step before the test step, join the step's for the
      // cross-job scope: the same setup leads into the same tests.
      const first = steps[0];
      // A preparation step that differs only in its directory or shell (`cp backend.conf .` from
      // fixtures/sqlite against fixtures/postgres) prepares different tests.
      const before = text(all.slice(0, first.index).map((st) => ({ uses: st.uses ?? null, run: st.run ?? null, with: st.with ?? null, env: st.env ?? null, if: st.if ?? null, dir: st['working-directory'] ?? null, shell: st.shell ?? null })));
      const jobKey = [stepKey, text(job['runs-on']), text(job.env), text(job.container), text(job.services), text(job.defaults), cond(job), before].join('\u0000');
      if (!byCommand.has(jobKey)) byCommand.set(jobKey, []);
      byCommand.get(jobKey).push({ job: id, step: first.name, header: first.header, shared: first.shared, index: first.index, command: first.command, matrix: Boolean(job.strategy && job.strategy.matrix) });
    }
  }
  for (const where of byCommand.values()) {
    const ws = where.filter((w) => !w.matrix && !used.has(key(w.job, w.index)));
    if (ws.length > 1) {
      found.push({ scope: 'workflow', jobs: ws.map((w) => w.job), steps: ws.map((w) => w.step), headers: ws.map((w) => w.header), shared: ws.map((w) => w.shared), command: ws[0].command });
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
  for (const [id, job] of jobsOf(doc)) {
    const steps = stepsOf(job);
    steps.forEach((st, i) => {
      if (!/^actions\/upload-artifact@/.test(String(st.uses || ''))) return;
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
      // The other destination must run whenever the artifact step runs: a release upload behind
      // `if: startsWith(github.ref, 'refs/tags/')` leaves the artifact the only copy on every other
      // run, so a destination with a condition the artifact step does not share does not count.
      const guard = (s) => String(s.if ?? '').replace(/\s+/g, ' ').trim();
      const mine = guard(st);
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
        if (guard(other) !== mine && guard(other) !== '') return;
        // A destination allowed to fail (continue-on-error) can leave the artifact the only copy.
        if (other['continue-on-error'] !== undefined && String(other['continue-on-error']).trim().toLowerCase() !== 'false') return;
        if (j > i + 1 && !survivesFailure(guard(other))) return;
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

/** Lines that give the count of tests a run reports, by runner; the last such line of a section is its count. */
const COUNT_LINES = [
  /^# tests (\d+)$/, // node --test's TAP summary
  /^Tests:\s+(?:.*?, )?(\d+) total/, // jest
  /^\s*Tests\s+(?:.*?\| )?\d+ \w+ \((\d+)\)/, // vitest: "Tests  12 passed (12)"
  /^=+ (\d+) passed/, // pytest
  /^\s*(\d+) passing/, // mocha
  /^test result: \w+\. (\d+) passed; (\d+) failed/, // cargo test, one line per binary (the last counts)
  /^\[INFO\] Tests run: (\d+), Failures/, // maven's total, after the per-class lines
  /^Tests run: (\d+), Failures/, // gradle, surefire per class
  /^OK \((\d+) tests?/, // phpunit
  /^(\d+) examples?, \d+ failures?/, // rspec
  /^\s*Passed!\s+-\s+Failed:\s+\d+,\s+Passed:\s+\d+,\s+Skipped:\s+\d+,\s+Total:\s+(\d+)/, // dotnet test
];

/**
 * What a test step's log says ran: the tests by name where the runner lists them, else the count
 * its summary gives; null for a log that shows neither. Names come from every line that names a
 * test (a subtest's indented line included), the count from the last summary line.
 */
export function testSignature(sectionText) {
  const names = [];
  let count = null;
  for (const line of String(sectionText).split('\n')) {
    for (const rx of NAME_LINES) {
      const m = rx.exec(line);
      if (m) {
        names.push(m[1].trim());
        break;
      }
    }
    for (const rx of COUNT_LINES) {
      const m = rx.exec(line);
      if (m) {
        // cargo's line carries passed and failed apart; every other has one figure.
        count = m.length > 2 && m[2] !== undefined ? Number(m[1]) + Number(m[2]) : Number(m[1]);
        break;
      }
    }
  }
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
