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
const HARMLESS = new Set(['set', 'cd', 'export', 'echo', 'true', ':', 'pwd']);

/**
 * Whether a script runs the one test command and nothing else (set, cd, export and echo aside):
 * only such a step is priced as a whole when that command is the repeat. A step with another
 * suite, a build or an export beside it keeps work that must stay.
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
 * Tests started twice. In one job (scope "job"): two steps each start the same test runner, the
 * same command (`same: true`) or the runner on other paths or in another directory (`same:
 * false`, an exported or built tree). Across the workflow (scope "workflow"): two jobs start the
 * same command on the same kind of runner with no matrix. A matrix leg is one job to GitHub, and
 * the same tests on two runners are two results, so neither counts. `pure` says, per step,
 * whether the step does nothing but run tests: only such a step is priced as a whole.
 */
export function repeatedTests(doc) {
  const found = [];
  const byCommand = new Map();
  // A step is priced once, whatever took it: the steps in a within-job finding are out of every
  // cross-job match, under any command, and a step in one cross-job finding is out of the next.
  const used = new Set();
  const key = (job, index) => `${job}\u0000${index}`;
  const cond = (x) => String(x?.if ?? '').replace(/\s+/g, ' ').trim();
  for (const [id, job] of jobsOf(doc)) {
    const inJob = new Map();
    const byRunner = new Map();
    stepsOf(job).forEach((st, i) => {
      if (st.run === undefined) return;
      const name = stepName(st, i);
      for (const command of new Set(testCommands(st.run))) {
        if (!inJob.has(command)) inJob.set(command, []);
        inJob.get(command).push({ index: i, name, run: st.run, when: cond(st) });
        // Occurrences by step, not by display name: two unnamed `run: npm test` steps are both
        // "Run npm test", and are two runs.
        const runner = runnerOf(command);
        if (!byRunner.has(runner)) byRunner.set(runner, []);
        byRunner.get(runner).push({ index: i, name, command, run: st.run });
      }
    });
    for (const [command, steps] of inJob) {
      if (!byCommand.has(command)) byCommand.set(command, []);
      // A job's and a step's own conditions travel with the match: two jobs that never run in the
      // same run (push against pull_request) are not a repeat.
      byCommand.get(command).push({ job: id, step: steps[0].name, index: steps[0].index, run: steps[0].run, when: `${cond(job)}\u0000${steps[0].when}`, runsOn: JSON.stringify(job['runs-on'] ?? null), matrix: Boolean(job.strategy && job.strategy.matrix) });
    }
    for (const [runner, occurrences] of byRunner) {
      // One step that starts two suites of one runner is one step: distinct steps by index, each
      // named once, and none that an earlier runner's finding already took.
      const byIndex = new Map();
      for (const o of occurrences) if (!byIndex.has(o.index) && !used.has(key(id, o.index))) byIndex.set(o.index, o);
      const taken = [...byIndex.values()];
      const commands = [...new Set(occurrences.filter((o) => byIndex.has(o.index)).map((o) => o.command))];
      // Two steps of this runner: the same command in both, or two commands (other paths, another directory).
      if (taken.length > 1) {
        const same = commands.length === 1;
        // Priced only when each step is that one command and nothing else; two different commands
        // (other paths, another directory) are two suites as far as the file can tell.
        found.push({ scope: 'job', jobs: [id], steps: taken.map((o) => o.name), pure: taken.map((o) => same && onlyCommand(o.run, commands[0])), command: same ? commands[0] : runner, same });
        for (const i of byIndex.keys()) used.add(key(id, i));
      }
    }
  }
  for (const [command, where] of byCommand) {
    const groups = new Map();
    for (const w of where) {
      if (w.matrix || used.has(key(w.job, w.index))) continue;
      const g = `${w.runsOn}\u0000${w.when}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(w);
    }
    for (const ws of groups.values()) {
      if (ws.length > 1) {
        found.push({ scope: 'workflow', jobs: ws.map((w) => w.job), steps: ws.map((w) => w.step), pure: ws.map((w) => onlyCommand(w.run, command)), command, same: true });
        for (const w of ws) used.add(key(w.job, w.index));
      }
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
 * not a duplicate.
 */
export function duplicateUploads(doc) {
  const found = [];
  for (const [id, job] of jobsOf(doc)) {
    const steps = stepsOf(job);
    steps.forEach((st, i) => {
      if (!/^actions\/upload-artifact@/.test(String(st.uses || ''))) return;
      if (/failure\(\)/.test(String(st.if ?? ''))) return;
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
      // A destination with no condition runs only on success (GitHub's implicit success()). An
      // artifact step that runs after a failure too (always(), !cancelled()) then keeps the only
      // copy of a failed run's file, so such a destination counts only under the same condition.
      const afterFailure = /always\(\)|cancelled\(\)/.test(mine);
      // A destination that comes later counts only when it comes next, unless its own condition
      // survives a failure (always(), !cancelled()): any other condition, or none, carries the
      // implicit success(), and a step between them that fails skips the destination after the
      // artifact already went up.
      steps.forEach((other, j) => {
        if (j === i) return;
        if (guard(other) !== mine && (guard(other) !== '' || afterFailure)) return;
        // A destination allowed to fail (continue-on-error) can leave the artifact the only copy.
        if (other['continue-on-error'] !== undefined && String(other['continue-on-error']).trim().toLowerCase() !== 'false') return;
        if (j > i + 1 && !survivesFailure(guard(other))) return;
        const uses = String(other.uses || '');
        const w = other.with && typeof other.with === 'object' ? other.with : {};
        if (/^github\/codeql-action\/upload-sarif@/.test(uses) && same(w.sarif_file)) alsoTo.add('code scanning');
        if (/^softprops\/action-gh-release@/.test(uses) && same(w.files)) alsoTo.add('the release');
        // A `gh release upload` in a run script is not read: whether the shell reaches it (a
        // `test ... || exit 0`, an if, a here-document) and from which directory (working-directory,
        // a cd) is not the file's to establish, and a wrong "duplicate" deletes the only copy.
      });
      if (alsoTo.size) found.push({ job: id, step: stepName(st, i), path, alsoTo: [...alsoTo] });
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
