#!/usr/bin/env node
// The installed command runs the bundled CLI in dist/, so the package needs no dependencies.
import { main, proxyPlan, rerunWithEnvProxy } from '../dist/cli.mjs';

// Behind a proxy, Node's fetch only uses HTTPS_PROXY with NODE_USE_ENV_PROXY=1 set at start-up.
const plan = proxyPlan(process.env);
if (plan.action === 'rerun') {
  process.exitCode = rerunWithEnvProxy();
} else {
  if (plan.action === 'unsupported') process.stderr.write(`ci-wizard: ${plan.message}\n`);
  process.exitCode = await main();
}
