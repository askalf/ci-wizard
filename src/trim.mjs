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
  for (const [id, job] of jobsOf(doc)) {
    const inJob = new Map();
    const byRunner = new Map();
    stepsOf(job).forEach((st, i) => {
      if (st.run === undefined) return;
      const name = stepName(st, i);
      for (const command of new Set(testCommands(st.run))) {
        if (!inJob.has(command)) inJob.set(command, []);
        inJob.get(command).push(name);
        const runner = runnerOf(command);
        if (!byRunner.has(runner)) byRunner.set(runner, new Map());
        byRunner.get(runner).set(name, command);
      }
    });
    for (const [command, steps] of inJob) {
      if (!byCommand.has(command)) byCommand.set(command, []);
      byCommand.get(command).push({ job: id, step: steps[0], runsOn: JSON.stringify(job['runs-on'] ?? null), matrix: Boolean(job.strategy && job.strategy.matrix) });
    }
    for (const [runner, bySteps] of byRunner) {
      const steps = [...bySteps.keys()];
      const commands = [...new Set(bySteps.values())];
      // The same command in two steps counts once; two commands under one runner count once more.
      const sameCommand = [...inJob.values()].some((xs) => xs.length > 1);
      if (steps.length > 1 || sameCommand) found.push({ scope: 'job', jobs: [id], steps: steps.length > 1 ? steps : inJob.get(commands[0]), command: commands.length === 1 ? commands[0] : runner, same: commands.length === 1 });
    }
  }
  for (const [command, where] of byCommand) {
    const groups = new Map();
    for (const w of where) {
      if (w.matrix) continue;
      if (!groups.has(w.runsOn)) groups.set(w.runsOn, []);
      groups.get(w.runsOn).push(w);
    }
    for (const ws of groups.values()) {
      if (ws.length > 1) found.push({ scope: 'workflow', jobs: ws.map((w) => w.job), steps: ws.map((w) => w.step), command, same: true });
    }
  }
  return found;
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An actions/upload-artifact step whose one literal path another step of the same job already
 * publishes: a SARIF file sent to code scanning, or a file uploaded to the release. An upload that
 * runs only on failure is a crash's files kept for a look, not a duplicate.
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
      const mentions = new RegExp(`(^|[\\s"'])(\\./)?${escapeRx(path)}([\\s"']|$)`, 'm');
      steps.forEach((other, j) => {
        if (j === i) return;
        const uses = String(other.uses || '');
        const w = other.with && typeof other.with === 'object' ? other.with : {};
        if (/^github\/codeql-action\/upload-sarif@/.test(uses) && same(w.sarif_file)) alsoTo.add('code scanning');
        if (/^softprops\/action-gh-release@/.test(uses) && same(w.files)) alsoTo.add('the release');
        if (other.run !== undefined && /\bgh release upload\b/.test(String(other.run)) && mentions.test(String(other.run))) alsoTo.add('the release');
      });
      if (alsoTo.size) found.push({ job: id, step: stepName(st, i), path, alsoTo: [...alsoTo] });
    });
  }
  return found;
}

/** Whether any step of the workflow starts a test runner: a large log is then a test listing, not a tool's own output. */
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
