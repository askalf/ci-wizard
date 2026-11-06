// Entry point of the bundled action (dist/action.mjs).
import { run } from './action-run.mjs';
import { proxyPlan, rerunWithEnvProxy } from './proxy.mjs';

// A self-hosted runner behind a proxy: Node's fetch only uses HTTPS_PROXY with NODE_USE_ENV_PROXY=1
// set at start-up, so the action runs itself again with it.
const plan = proxyPlan(process.env);
if (plan.action === 'rerun') {
  process.exitCode = rerunWithEnvProxy();
} else {
  if (plan.action === 'unsupported') process.stdout.write(`::warning::ci-wizard: ${plan.message}\n`);
  process.exitCode = await run();
}
