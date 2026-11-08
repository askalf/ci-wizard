// What a workflow file shows about work done twice or shipped twice: the same test command in two
// steps of a job or two jobs of a run, an artifact of a file another step already published, and a
// toolchain setup on a self-hosted runner that can carry the runtime itself. Each reads the parsed
// file and names the job and step, by the name GitHub gives the step (stepCommands in
// workflow.mjs), so the step timings price the finding.
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

/** Shell commands a test step may carry beside its tests without doing other work. */
const HARMLESS = new Set(['set', 'export', 'echo', 'true', ':', 'pwd']);

/**
 * Whether a script runs the one test command and nothing else (set, export and echo aside; a cd
 * moves the tests to another directory and is not aside). Only such a step is a repeat of another
 * such step: a step with another suite, a build or an export beside it keeps work that must stay.
 */
export function onlyCommand(script, command) {
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
    if (!HARMLESS.has(ws[0])) return false;
  }
  return hits > 0;
}

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

/** The runner a test command starts (`node --test`, `npm test`, `pytest`, `go test`): the part before its paths and options. */
export function runnerOf(command) {
  const m = TEST_RUNNERS.map((rx) => rx.exec(command)).find(Boolean);
  return m ? m[0] : command.split(' ')[0];
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

/**
 * The same test step twice: two steps whose scripts are one and the same test command and
 * nothing else, under the same condition, in the same declared working directory, with the same
 * step environment. In one job (scope "job"), or in two jobs of the run (scope "workflow") that
 * also share runs-on, job environment, container, services and run defaults, with no matrix. A
 * matrix leg is one job to GitHub; the same tests on two runners, in two directories, against
 * two environments, or under two conditions are two results, and nothing else the file could
 * tell apart is called a repeat.
 */
export function repeatedTests(doc) {
  const found = [];
  const byCommand = new Map();
  const used = new Set();
  const key = (job, index) => `${job}\u0000${index}`;
  const text = (x) => JSON.stringify(x ?? null);
  const cond = (x) => String(x?.if ?? '').replace(/\s+/g, ' ').trim();
  const dirOf = (st, job) => String(st['working-directory'] ?? job.defaults?.run?.['working-directory'] ?? doc.defaults?.run?.['working-directory'] ?? '').trim();
  for (const [id, job] of jobsOf(doc)) {
    const inJob = new Map();
    stepsOf(job).forEach((st, i) => {
      if (st.run === undefined) return;
      const commands = new Set(testCommands(st.run));
      if (commands.size !== 1) return;
      const [command] = commands;
      if (!onlyCommand(st.run, command)) return;
      // Everything the file says about where and how the step runs is part of its identity.
      const stepKey = [command, cond(st), dirOf(st, job), text(st.env), text(st.shell)].join('\u0000');
      if (!inJob.has(stepKey)) inJob.set(stepKey, []);
      inJob.get(stepKey).push({ index: i, name: stepName(st, i), command });
    });
    for (const [stepKey, steps] of inJob) {
      if (steps.length > 1) {
        found.push({ scope: 'job', jobs: [id], steps: steps.map((o) => o.name), command: steps[0].command, same: true });
        for (const o of steps) used.add(key(id, o.index));
      }
      // The job's own identity joins the step's for the cross-job scope.
      const jobKey = [stepKey, text(job['runs-on']), text(job.env), text(job.container), text(job.services), text(job.defaults), cond(job)].join('\u0000');
      if (!byCommand.has(jobKey)) byCommand.set(jobKey, []);
      byCommand.get(jobKey).push({ job: id, step: steps[0].name, index: steps[0].index, command: steps[0].command, matrix: Boolean(job.strategy && job.strategy.matrix) });
    }
  }
  for (const where of byCommand.values()) {
    const ws = where.filter((w) => !w.matrix && !used.has(key(w.job, w.index)));
    if (ws.length > 1) {
      found.push({ scope: 'workflow', jobs: ws.map((w) => w.job), steps: ws.map((w) => w.step), command: ws[0].command, same: true });
      for (const w of ws) used.add(key(w.job, w.index));
    }
  }
  return found;
}

/**
 * An actions/upload-artifact step whose one literal path another action step of the same job
 * already publishes with the same literal input: a SARIF file sent to code scanning
 * (github/codeql-action/upload-sarif), or a file attached to the release
 * (softprops/action-gh-release). Both actions read their input against the workspace, as
 * upload-artifact does. An upload that runs only on failure is a crash's files kept for a look,
 * not a duplicate. `after` says the destination comes after the artifact step: it can then fail
 * after the artifact went up, so that order's fix moves the artifact behind it under failure()
 * rather than dropping it.
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
      if (alsoTo.size) found.push({ job: id, step: stepName(st, i), path, alsoTo: [...alsoTo], after: after });
    });
  }
  return found;
}

/** Whether any step of the workflow starts a test runner. The bytes of a log are not read, so this is the file's word on what a large log is likely to be. */
export function startsTests(doc) {
  return jobsOf(doc).some(([, job]) => stepsOf(job).some((st) => st.run !== undefined && testCommands(st.run).length > 0));
}

/** A runtime setup action, setting up the runtime and nothing else, on a job that runs on self-hosted runners, where the host can carry the runtime. */
export function selfHostedSetups(doc) {
  const found = [];
  for (const [id, job] of jobsOf(doc)) {
    if (!runsOnSelfHosted(job['runs-on'])) continue;
    stepsOf(job).forEach((st, i) => {
      const m = /^actions\/setup-(node|python|go|java|dotnet|ruby)@/.exec(String(st.uses || ''));
      if (!m) return;
      // A setup that also restores a dependency cache or signs the job in to a registry does more
      // than state a version: dropping it would lose that work, so it is not this rule's.
      const w = st.with && typeof st.with === 'object' ? st.with : {};
      if (Object.keys(w).some((k) => /^(cache|cache-dependency-path|bundler-cache|registry-url|scope|always-auth|server-id|server-username|server-password|gpg-private-key|source-url)$/.test(k) && !(k === 'cache' && String(w[k]).trim().toLowerCase() === 'false'))) return;
      // setup-go caches by default (v4 and later; the version is not checked, which only ever
      // keeps a step): only an explicit `cache: false` makes it a runtime-only setup.
      if (m[1] === 'go' && String(w.cache ?? '').trim().toLowerCase() !== 'false') return;
      found.push({ job: id, step: stepName(st, i), action: `setup-${m[1]}` });
    });
  }
  return found;
}
