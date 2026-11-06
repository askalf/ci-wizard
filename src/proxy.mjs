// Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set when the process starts
// (Node 22.21 and 24 onwards), so behind a proxy every API call would go direct and fail. When a
// proxy is set and the runtime can honour it, the entry point runs itself again with the variable
// set; when the runtime cannot, it says so instead of failing later with a network error.
import { spawnSync } from 'node:child_process';

/** Whether this Node's fetch honours NODE_USE_ENV_PROXY: 22.21 and later 22s, and 24 onwards. */
export function supportsEnvProxy(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  return major >= 24 || (major === 22 && minor >= 21) || major === 23;
}

/**
 * What to do about a proxy in the environment: nothing (no proxy, or Node already honours it),
 * run again with NODE_USE_ENV_PROXY=1, or warn that this Node cannot use it.
 * @returns {{ action: 'none' } | { action: 'rerun' } | { action: 'unsupported', message: string }}
 */
export function proxyPlan(env = process.env, version = process.versions.node) {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxy || env.NODE_USE_ENV_PROXY === '1') return { action: 'none' };
  if (supportsEnvProxy(version)) return { action: 'rerun' };
  return {
    action: 'unsupported',
    message: `a proxy is set (HTTPS_PROXY), but the fetch in Node ${version} ignores it, so calls to the GitHub API go direct; Node 22.21 or later uses it`,
  };
}

/**
 * Runs this same script again with NODE_USE_ENV_PROXY=1, its output passed straight through, and
 * returns its exit code. The child sees the variable set, so it never runs itself a third time.
 */
export function rerunWithEnvProxy({ env = process.env, argv = process.argv, execArgv = process.execArgv, execPath = process.execPath } = {}) {
  const child = spawnSync(execPath, ['--disable-warning=ExperimentalWarning', '--disable-warning=UNDICI-EHPA', ...execArgv, ...argv.slice(1)], {
    stdio: 'inherit',
    env: { ...env, NODE_USE_ENV_PROXY: '1' },
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}
