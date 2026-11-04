// Fuzz the workflow-file path: the YAML text of another repository's workflow, which ci-wizard
// fetches from the GitHub contents API and parses to confirm what the run history suggests.
// The file is untrusted input. Contracts: parseWorkflow never throws and always returns a plain
// object; every reader built on it (triggers, concurrency, steps, cache facts) returns its
// documented shape for any parsed document, including documents that are not workflows at all
// (scalars, lists, `jobs: 3`, steps that are strings); and no regex in the step-name matching
// takes super-linear time on a hostile step name (the run reaches libFuzzer's timeout instead).
import {
  allSteps,
  categoryOf,
  CATEGORIES,
  commandOf,
  concurrencyGroupOf,
  parseWorkflow,
  pushBranchesOf,
  stepCommands,
  triggersOf,
  workflowFacts,
} from '../src/workflow.mjs';
import { measureWorkflow } from '../src/analyse.mjs';

// The yaml parser reports each malformed document as a process warning on stderr; with hostile
// input that is thousands of lines of noise. The parse result carries the same information.
process.removeAllListeners('warning');

const FACT_FLAGS = ['hasCache', 'setupCache', 'cachesNodeModules', 'hasConcurrency', 'cancels', 'npmInstallNoCi', 'preferOffline'];

function fail(msg) {
  throw new Error(msg);
}

export function fuzz(data) {
  const text = data.toString('utf8');

  const doc = parseWorkflow(text);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) fail('parseWorkflow did not return a plain object');

  const triggers = triggersOf(doc);
  if (!Array.isArray(triggers) || triggers.some((t) => typeof t !== 'string')) fail('triggersOf returned a non-string list');
  const branches = pushBranchesOf(doc);
  if (!Array.isArray(branches) || branches.some((b) => typeof b !== 'string')) fail('pushBranchesOf returned a non-string list');
  if (typeof concurrencyGroupOf(doc) !== 'string') fail('concurrencyGroupOf returned a non-string');
  if (!Array.isArray(allSteps(doc))) fail('allSteps returned a non-list');

  const facts = workflowFacts(doc);
  for (const flag of FACT_FLAGS) if (typeof facts[flag] !== 'boolean') fail(`workflowFacts.${flag} is ${typeof facts[flag]}`);

  // Step names the way the Actions API reports them: the workflow file's own names, plain and
  // with a "Post " prefix, plus the raw fuzz text as a name no file declared. A name with a
  // `${{ }}` expression is matched as a pattern, which is the regex built from untrusted text.
  const commands = stepCommands(doc);
  const names = [...commands.keys(), text.slice(0, 200)];
  for (const name of names.slice(0, 64)) {
    for (const n of [name, `Post ${name}`, name.replace(/\$\{\{.*?\}\}/g, 'x')]) {
      if (typeof commandOf(n, commands) !== 'string') fail('commandOf returned a non-string');
      const c = categoryOf(n, commands);
      if (!CATEGORIES.includes(c) && c !== 'work') fail(`categoryOf returned an unknown category: ${c}`);
    }
  }

  // The whole per-workflow measurement over a fixed run history whose steps carry the file's names.
  const steps = [...commands.keys()].slice(0, 16).map((name, i) => ({
    name,
    started_at: `2026-01-05T10:00:${String(10 + i).padStart(2, '0')}Z`,
    completed_at: `2026-01-05T10:00:${String(11 + i).padStart(2, '0')}Z`,
  }));
  const job = {
    created_at: '2026-01-05T10:00:00Z',
    started_at: '2026-01-05T10:00:02Z',
    completed_at: '2026-01-05T10:02:00Z',
    runner_name: 'GitHub Actions 1',
    steps,
  };
  const run = {
    id: 1, name: 'CI', event: 'push', head_sha: 'a', head_branch: 'main', conclusion: 'success', status: 'completed',
    path: '.github/workflows/ci.yml', created_at: '2026-01-05T10:00:00Z', run_started_at: '2026-01-05T10:00:00Z', updated_at: '2026-01-05T10:02:00Z',
  };
  const w = measureWorkflow('CI', [run], [[job]], text, 1);
  if (facts.hasCache && !w.has_cache) fail('measureWorkflow lost the cache that workflowFacts found');
  if (!Array.isArray(w.triggers) || !Array.isArray(w.push_branches)) fail('measureWorkflow returned a malformed workflow record');
}
