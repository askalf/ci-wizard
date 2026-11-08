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
 * the same tests on two runners are two results, so neither counts.
 */
export function repeatedTests(doc) {
  const found = [];
  const byCommand = new Map();
  // Jobs already counted for a runner within themselves: the cross-job scope leaves them out, so a
  // run is never counted twice (the estimate then understates a suite run in two jobs twice each).
  const counted = new Set();
  for (const [id, job] of jobsOf(doc)) {
    const inJob = new Map();
    const byRunner = new Map();
    stepsOf(job).forEach((st, i) => {
      if (st.run === undefined) return;
      const name = stepName(st, i);
      for (const command of new Set(testCommands(st.run))) {
        if (!inJob.has(command)) inJob.set(command, []);
        inJob.get(command).push(name);
        // Occurrences by step, not by display name: two unnamed `run: npm test` steps are both
        // "Run npm test", and are two runs.
        const runner = runnerOf(command);
        if (!byRunner.has(runner)) byRunner.set(runner, []);
        byRunner.get(runner).push({ index: i, name, command });
      }
    });
    for (const [command, steps] of inJob) {
      const first = byRunner.get(runnerOf(command)).find((o) => o.command === command);
      if (!byCommand.has(command)) byCommand.set(command, []);
      byCommand.get(command).push({ job: id, step: steps[0], index: first.index, runsOn: JSON.stringify(job['runs-on'] ?? null), matrix: Boolean(job.strategy && job.strategy.matrix) });
    }
    // A step is priced once: a step that starts two runners (or two suites of one) joins the first
    // finding that takes it and no other, so no step's time is claimed twice.
    const used = new Set();
    for (const [runner, occurrences] of byRunner) {
      const byIndex = new Map();
      for (const o of occurrences) if (!byIndex.has(o.index) && !used.has(o.index)) byIndex.set(o.index, o.name);
      const steps = [...byIndex.values()];
      const commands = [...new Set(occurrences.filter((o) => byIndex.has(o.index)).map((o) => o.command))];
      // Two steps of this runner: the same command in both, or two commands (other paths, another directory).
      if (steps.length > 1) {
        found.push({ scope: 'job', jobs: [id], steps, command: commands.length === 1 ? commands[0] : runner, same: commands.length === 1 });
        for (const i of byIndex.keys()) used.add(i);
        counted.add(`${id}\u0000${runner}`);
      }
    }
  }
  // Across jobs the same: a step already in a cross-job finding (two suites in one step, two
  // commands of two runners) is not priced again under its other command.
  const usedAcross = new Set();
  for (const [command, where] of byCommand) {
    const groups = new Map();
    for (const w of where) {
      if (w.matrix || counted.has(`${w.job}\u0000${runnerOf(command)}`) || usedAcross.has(`${w.job}\u0000${w.index}`)) continue;
      if (!groups.has(w.runsOn)) groups.set(w.runsOn, []);
      groups.get(w.runsOn).push(w);
    }
    for (const ws of groups.values()) {
      if (ws.length > 1) {
        found.push({ scope: 'workflow', jobs: ws.map((w) => w.job), steps: ws.map((w) => w.step), command, same: true });
        for (const w of ws) usedAcross.add(`${w.job}\u0000${w.index}`);
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
      steps.forEach((other, j) => {
        if (j === i) return;
        if (guard(other) !== mine && (guard(other) !== '' || afterFailure)) return;
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

/** A runtime setup action on a job that runs on self-hosted runners, where the host can carry the runtime. */
export function selfHostedSetups(doc) {
  const found = [];
  for (const [id, job] of jobsOf(doc)) {
    if (!runsOnSelfHosted(job['runs-on'])) continue;
    stepsOf(job).forEach((st, i) => {
      const m = /^actions\/setup-(node|python|go|java|dotnet|ruby)@/.exec(String(st.uses || ''));
      if (m) found.push({ job: id, step: stepName(st, i), action: `setup-${m[1]}` });
    });
  }
  return found;
}
