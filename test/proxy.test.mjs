// A proxy in the environment: Node's fetch only uses it with NODE_USE_ENV_PROXY=1 set at start-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyPlan, rerunWithEnvProxy, supportsEnvProxy } from '../src/proxy.mjs';

test('supportsEnvProxy: Node 22.21 and later 22s, and 24 onwards; not 23', () => {
  assert.equal(supportsEnvProxy('20.19.0'), false);
  assert.equal(supportsEnvProxy('22.20.0'), false);
  assert.equal(supportsEnvProxy('22.21.0'), true);
  assert.equal(supportsEnvProxy('22.23.4'), true);
  assert.equal(supportsEnvProxy('24.1.0'), true);
  assert.equal(supportsEnvProxy('23.11.0'), false);
  assert.equal(supportsEnvProxy('24.0.0'), true);
});

test('proxyPlan: nothing without a proxy or once Node uses it; a rerun where it can; a warning where it cannot', () => {
  assert.deepEqual(proxyPlan({}, '22.23.4'), { action: 'none' });
  assert.deepEqual(proxyPlan({ HTTPS_PROXY: 'http://127.0.0.1:3128', NODE_USE_ENV_PROXY: '1' }, '22.23.4'), { action: 'none' });
  assert.deepEqual(proxyPlan({ HTTPS_PROXY: 'http://127.0.0.1:3128' }, '22.23.4'), { action: 'rerun' });
  assert.deepEqual(proxyPlan({ https_proxy: 'http://127.0.0.1:3128' }, '24.1.0'), { action: 'rerun' });
  const old = proxyPlan({ HTTPS_PROXY: 'http://127.0.0.1:3128' }, '20.19.0');
  assert.equal(old.action, 'unsupported');
  assert.match(old.message, /Node 20\.19\.0 ignores it.*Node 22\.21 or later/);
});

test('rerunWithEnvProxy: runs the same script again with the variable set and returns its exit code', () => {
  const script = 'process.exit(process.env.NODE_USE_ENV_PROXY === "1" && process.argv[1] === "x" ? 7 : 3)';
  // argv[1] onwards is passed through: here node -e runs the code, and its first argument is "x".
  const status = rerunWithEnvProxy({ env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:1' }, argv: [process.execPath, '-e', script, 'x'], execArgv: [] });
  assert.equal(status, 7);
});
