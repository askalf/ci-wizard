// What stands between a pull request and the default branch: the checks a merge has to wait for,
// whether pull requests are checked at all, and the two workflows a supply-chain review expects
// (code scanning, dependency updates). Every finding comes from what the API showed; whatever it
// could not read (a ruleset, a listing) yields no finding rather than a guess.
import { parseWorkflow, triggersOf } from './workflow.mjs';

// GitHub Actions' app id. Only a required check bound to it is known to come from a workflow job,
// which the runs show. One bound to another app (a coverage service, a review bot), or bound to no
// app (any app may report it, as Codecov reports codecov/patch), cannot be judged absent from them.
const ACTIONS_APP = 15368;
export const isActionsCheck = (c) => c.integrationId === ACTIONS_APP;

const PR_TRIGGERS = new Set(['pull_request', 'pull_request_target', 'merge_group']);

// Actions that scan a repository's code and report its vulnerabilities: CodeQL, Semgrep, Snyk,
// SonarSource (SonarCloud, SonarQube), Bearer.
const CODE_SCANNERS = /^(github\/codeql-action\/(init|analyze)|returntocorp\/semgrep-action|semgrep\/semgrep-action|snyk\/actions\/|sonarsource\/|bearer\/bearer-action)/i;

// Checks that test, build or analyse the change: the ones a merge should wait for. Matched on the
// check's name, so the finding says "inferred" and lists the rest apart.
const GATE_LIKE = /\b(test|tests|lint|build|check|checks|verify|analy[sz]e|codeql|typecheck|types|dist|unit|e2e|ci|fuzz|fuzzing)\b/i;

const list = (xs, n = 6) => `${xs.slice(0, n).join(', ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`;

/** What the workflow files say: which run on pull requests, and which run CodeQL. */
function fileFacts(scanFiles) {
  const onPr = [];
  let codeql = false;
  for (const [path, text] of scanFiles) {
    const doc = parseWorkflow(text);
    if (!Object.keys(doc).length) continue;
    if (triggersOf(doc).some((t) => PR_TRIGGERS.has(t))) onPr.push(path);
    // A step that scans the code, read from the parsed steps (a commented-out line or a script that
    // only mentions one is not one): CodeQL, or another code scanner by its action, its container
    // or its command. A SARIF upload counts when its job is not a Scorecard or workflow-linter run,
    // whose results are about the repository's settings or workflows, not its code.
    for (const job of Object.values(doc.jobs || {})) {
      if (!job || typeof job !== 'object') continue;
      const steps = Array.isArray(job.steps) ? job.steps.filter((st) => st && typeof st === 'object') : [];
      const uses = steps.map((st) => String(st.uses || '').trim().toLowerCase());
      const runs = steps.map((st) => String(st.run || ''));
      const image = String((job.container && (job.container.image || job.container)) || '').toLowerCase();
      // A job that runs Scorecard or a workflow linter (by action or by command) uploads results
      // about settings or workflows, not about the code.
      const notCode = uses.some((u) => /^(ossf\/scorecard-action|zizmorcore\/|woodruffw\/zizmor|rhysd\/actionlint|raven-actions\/actionlint|boostsecurityio\/poutine)/.test(u))
        || runs.some((r) => /\b(scorecard|zizmor|actionlint|poutine)\b/i.test(r));
      if (uses.some((u) => CODE_SCANNERS.test(u))
        || (!notCode && uses.some((u) => u.startsWith('github/codeql-action/upload-sarif@')))
        || /semgrep|snyk|sonar/.test(image)
        || runs.some((r) => /(^|[\s;&|(])(semgrep (ci|scan)|snyk code test|codeql database (create|analyze))\b/.test(r))) codeql = true;
    }
  }
  return { onPr, codeql };
}

/**
 * The merge-gate findings, from collect's `gates`, the workflow files the scans read, whether the
 * workflow directory was fully listed, and the repository's visibility.
 */
export function gateFindings(gates, { scanFiles = new Map(), scanned = null, visibility = null } = {}) {
  if (!gates) return [];
  const F = [];
  const branch = gates.branch || 'the default branch';
  const files = fileFacts(scanFiles);
  const listedAll = Boolean(scanned && scanned.of !== null && scanned.of !== undefined && scanned.read === scanned.of);
  const prChecks = gates.pr_checks || [];
  const prSeen = gates.pr_runs_read > 0;

  // Nothing checks a pull request: no workflow file triggers on one, and none ran on one.
  if (listedAll && !files.onPr.length && !gates.pr_runs_seen) {
    F.push({
      saving: 0, unit: 'risk', confidence: 'confirmed', what: 'no workflow checks pull requests', workflow: 'all workflows',
      evidence: `none of the ${scanned.of} workflow files triggers on pull_request, and no pull request run is in the window: a change reaches ${branch} with nothing run on it first`,
      fix: 'run the tests (and the build) on pull_request, then require that check on the default branch',
      tradeoff: 'each pull request costs a run; a fork\'s pull request runs with a read-only token and no secrets, which is the safe default',
      example: 'on:\n  push:\n    branches: [main]\n  pull_request:',
    });
  }

  if (Array.isArray(gates.required)) {
    const required = gates.required;
    // Older saved reports carry no completeness flags: they are read as complete, as they were made.
    const requiredComplete = gates.required_complete !== false;
    const jobsComplete = gates.pr_jobs_complete !== false;
    const actionsRequired = required.filter(isActionsCheck);
    const requiredNames = new Set(required.map((c) => c.context));
    if (requiredComplete && !required.length && (prSeen || files.onPr.length)) {
      // Pull requests get checks, but the branch requires none: a red pull request can be merged.
      F.push({
        saving: 0, unit: 'risk', confidence: 'confirmed', what: 'merges do not wait for any check', workflow: branch,
        evidence: `no ruleset or branch protection on ${branch} requires a status check${prChecks.length ? `, though pull requests get ${prChecks.length}: ${list(prChecks)}` : ''}, so a pull request whose tests fail can still be merged`,
        fix: `require the checks that must pass in a ruleset on ${branch} (Settings, Rules, Rulesets: Require status checks to pass), by the exact names pull requests show`,
        tradeoff: 'a required check that does not run on a pull request (a path filter, a renamed job) blocks it; require only checks that run on every pull request',
        example: '',
      });
    }
    if (required.length && prSeen) {
      // Absence needs every sampled pull request run's jobs read; presence needs any.
      // A required check no pull request reported: renamed, path-filtered, or removed. GitHub waits
      // for it forever, so merges block or the rule is bypassed.
      const missing = jobsComplete ? [...new Set(actionsRequired.filter((c) => !prChecks.includes(c.context)).map((c) => c.context))] : [];
      if (missing.length) {
        F.push({
          saving: 0, unit: 'risk', confidence: 'inferred', what: 'required checks no pull request reports', workflow: branch,
          evidence: `${branch} requires ${list(missing.map((m) => `"${m}"`))}, but the newest pull request run of each of ${gates.pr_runs_read} workflow${gates.pr_runs_read === 1 ? '' : 's'} in the window reported no job by that name (they reported ${list(prChecks)}): GitHub waits for a required check until it reports, so a pull request without it cannot merge without bypassing the rule. A renamed job, a path filter or an \`if:\` on the workflow are the usual causes`,
          fix: 'rename the required check to the job name pull requests show (a matrix leg is "name (value)", a reusable workflow\'s job "caller / job"), or make the workflow run on every pull request and skip inside the job instead of filtering the trigger',
          tradeoff: 'a check that only runs for some paths cannot be required as it is: a job that always runs and exits early when nothing relevant changed can',
          example: '',
        });
      }
      // Checks pull requests get that a merge does not wait for, and that look like tests or builds.
      const notRequired = prChecks.filter((n) => !requiredNames.has(n));
      const gateLike = requiredComplete ? notRequired.filter((n) => GATE_LIKE.test(n)) : [];
      if (gateLike.length) {
        F.push({
          saving: 0, unit: 'guard', confidence: 'inferred', what: 'pull request checks merges do not wait for', workflow: branch,
          evidence: `pull requests get ${list(gateLike.map((n) => `"${n}"`))}, which look like tests, builds, analysis or fuzzing, but ${branch} does not require ${gateLike.length === 1 ? 'it' : 'them'}, so a pull request can merge with ${gateLike.length === 1 ? 'it' : 'them'} failing${notRequired.length > gateLike.length ? ` (${notRequired.length - gateLike.length} other unrequired check${notRequired.length - gateLike.length === 1 ? '' : 's'} not listed)` : ''}`,
          fix: `add the ones that must pass to the required status checks on ${branch}, by these exact names`,
          tradeoff: 'a required check that is slow or flaky holds every merge; fix or speed it up before requiring it',
          example: '',
        });
      }
      // Say which required checks could not be judged, on the missing-check finding when there is one.
      // A name also required from Actions was judged; only names required from no other way are not.
      const judged = new Set(actionsRequired.map((c) => c.context));
      const unjudged = [...new Set(required.filter((c) => !isActionsCheck(c) && !judged.has(c.context)).map((c) => c.context))];
      const missingFinding = F.find((f) => f.what === 'required checks no pull request reports');
      if (unjudged.length && missingFinding) missingFinding.evidence += `; ${list(unjudged.map((u) => `"${u}"`))} ${unjudged.length === 1 ? 'is' : 'are'} not bound to GitHub Actions, so another app may report ${unjudged.length === 1 ? 'it' : 'them'}, and ${unjudged.length === 1 ? 'it was' : 'they were'} not judged`;
    }
  }

  // Code scanning: a CodeQL workflow file, or default setup's dynamic runs.
  if (listedAll && !files.codeql && !gates.code_scanning_runs) {
    const paid = visibility && visibility !== 'public';
    F.push({
      saving: 0, unit: 'risk', confidence: 'inferred', what: 'no code scanning', workflow: 'all workflows',
      evidence: `no workflow file runs a code scanner (CodeQL, Semgrep, Snyk, SonarSource, or a SARIF upload) and no code scanning default-setup run is in the window, so pull requests are not scanned for vulnerabilities in the code${paid ? '; CodeQL on a private repository needs GitHub Advanced Security (or Code Security)' : ''}`,
      fix: 'turn on CodeQL default setup (Settings, Code security, Code scanning), or add a CodeQL workflow, and require its analyze check',
      tradeoff: 'each push and pull request runs an analysis (minutes for most repositories); findings need triage',
      example: '',
    });
  }

  // Dependency updates: without them, pinned actions and lockfiles stay on what they were.
  if (gates.dependency_updates === false) {
    F.push({
      saving: 0, unit: 'risk', confidence: 'confirmed', what: 'no dependency updates', workflow: 'the repository',
      evidence: 'there is no .github/dependabot.yml and no Renovate configuration, and no Dependabot run is in the window: pinned actions and locked dependencies never move to fixed versions unless someone does it by hand',
      fix: 'add .github/dependabot.yml for github-actions (and the package ecosystem the repository uses), weekly',
      tradeoff: 'update pull requests to review, about one a week per ecosystem when grouped',
      example: 'version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n    groups:\n      actions:\n        patterns: ["*"]',
    });
  }
  return F;
}
