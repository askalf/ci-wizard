// What a workflow file shows that the measurements price: a toolchain setup on a self-hosted
// runner that can carry the runtime itself, and whether the file starts a test runner at all (for
// the log rule). Each reads the parsed file and names the job and step, by the name GitHub gives
// the step (stepCommands in workflow.mjs), so the step timings price the finding.
//
// Two further readings were built and taken out again (ci-wizard#33): the same test step twice,
// and an artifact of a file another step already published. Both recommend deleting a step, and
// a workflow file cannot establish that the second copy is the first (another directory,
// environment, runtime, configuration, or a destination that fails after the artifact went up).
// Their cases are the spec of the follow-up issue.
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
      const off = (k) => String(w[k] ?? '').trim().toLowerCase() === 'false';
      if (Object.keys(w).some((k) => /^(cache|cache-dependency-path|bundler-cache|registry-url|scope|always-auth|server-id|server-username|server-password|gpg-private-key|source-url|package-manager-cache)$/.test(k) && !((k === 'cache' || k === 'package-manager-cache') && off(k)))) return;
      // setup-go caches by default (v4 and later; the version is not checked, which only ever
      // keeps a step): only an explicit `cache: false` makes it a runtime-only setup.
      if (m[1] === 'go' && !off('cache')) return;
      // setup-node caches the package manager's store by itself from v6 when package.json names
      // one; a version that is not a known v5 or earlier (a SHA pin, a branch) is taken to be that
      // new, so only an explicit `package-manager-cache: false` makes it runtime-only.
      const major = /@v(\d+)(\.|$)/.exec(String(st.uses));
      if (m[1] === 'node' && !(major && Number(major[1]) <= 5) && !off('package-manager-cache')) return;
      // A step name that another step of the job shares cannot be priced from the sample (the
      // timings of both would pool): `unique` says the name is this step's alone.
      const name = stepName(st, i);
      const unique = stepsOf(job).filter((x, k) => stepName(x, k) === name).length === 1;
      found.push({ job: id, step: name, action: `setup-${m[1]}`, unique });
    });
  }
  return found;
}
