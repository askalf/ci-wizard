// The API budget an audit drew on: the token's hourly limit from GitHub's headers, what was left,
// and the GitHub App route when the budget is a workflow token's 1,000.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, RateLimitError, RATE_LIMIT_HINT } from '../src/github.mjs';
import { budgetText, report } from '../src/report.mjs';
import { analyse } from '../src/analyse.mjs';
import { main as cli } from '../src/cli.mjs';
import { data, job, runs } from './helpers.mjs';

/** A fetch answering every path with `body`, and the rate-limit headers given. */
const fetchWith = (headers, body = {}) => async () => new Response(JSON.stringify(body), { status: 200, headers });

test('the client records the hourly limit GitHub reports', async () => {
  const c = createClient({ fetchImpl: fetchWith({ 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '941' }) });
  assert.equal(c.limit, null);
  await c.get('repos/o/r');
  assert.equal(c.limit, 1000);
  assert.equal(c.remaining, 941);
});

test('a stop near the limit names the budget and the App route', async () => {
  const c = createClient({ fetchImpl: fetchWith({ 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '10' }), minRemaining: 25 });
  await c.get('repos/o/r');
  await assert.rejects(c.get('repos/o/r'), (err) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.limit, 1000);
    assert.match(err.message, /10 calls left of 1000 an hour; a GitHub App's installation token has its own budget of 5,000 or more/);
    return true;
  });
  assert.match(RATE_LIMIT_HINT, /README's "Rate limits" section/);
});

test('budgetText: calls and what was left, with the App route only for a small budget', () => {
  assert.equal(budgetText({ api_calls: 41, rate_limit: { limit: 1000, remaining: 959 } }), "41 API calls, 959 of 1000 left this hour; a GitHub App's token has its own 5,000 or more");
  assert.equal(budgetText({ api_calls: 41, rate_limit: { limit: 5000, remaining: 4959 } }), '41 API calls, 4959 of 5000 left this hour');
  // A limit with no remaining count is never shown as what is left.
  const noRemaining = budgetText({ api_calls: 3, rate_limit: { limit: 60, remaining: null } });
  assert.equal(noRemaining, "3 API calls, hourly limit 60, remaining not reported; a GitHub App's token has its own 5,000 or more");
  assert.doesNotMatch(noRemaining, /left/);
  assert.equal(budgetText({ api_calls: 41 }), '');
  assert.equal(budgetText({ rate_limit: { limit: null, remaining: 5 } }), '');
});

test('the report and the CLI say what budget the audit drew on', async () => {
  const a = analyse('o/r', data({ workflows: [{ name: 'CI', runs: runs(5) }] }));
  assert.doesNotMatch(report(a), /API budget/);
  a.api_calls = 12;
  a.rate_limit = { limit: 1000, remaining: 988 };
  assert.match(report(a), /- API budget: 12 API calls, 988 of 1000 left this hour; a GitHub App's token has its own 5,000 or more\./);

  const routes = async (url) => {
    const path = url.replace('https://api.github.com/', '');
    const headers = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990' };
    const body = path.startsWith('repos/o/r/actions/runs?') ? { workflow_runs: runs(3) }
      : path.startsWith('repos/o/r/actions/runs/') ? { jobs: [job()] }
        : path.startsWith('repos/o/r/contents/') ? [] : { default_branch: 'main', visibility: 'private' };
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  const o = { out: '', err: '' };
  const io = { stdout: { write: (s) => (o.out += s) }, stderr: { write: (s) => (o.err += s) } };
  assert.equal(await cli(['o/r'], { env: {}, token: 'x', ...io, fetchImpl: routes }), 0);
  assert.match(o.err, /\d+ API calls, 4990 of 5000 left this hour\n/);
  assert.doesNotMatch(o.err, /GitHub App/);
});

test('the reserve holds before every attempt, retries included: no request at minRemaining or below', async () => {
  let sent = 0;
  // First answer: 26 left. Then the server fails, so the client would retry; the retry must not go
  // out, because the failed attempt brought the token to the reserve.
  const fetchImpl = async () => {
    sent++;
    const left = String(27 - sent);
    return sent === 1
      ? new Response('{}', { status: 200, headers: { 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': left } })
      : new Response('{}', { status: 502, headers: { 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': left } });
  };
  const c = createClient({ fetchImpl, minRemaining: 25, backoffMs: [0, 0] });
  await c.get('a'); // 26 left
  await assert.rejects(c.get('b'), RateLimitError); // one attempt at 26 -> 25 left, then the retry stops
  assert.equal(sent, 2);
  assert.equal(c.remaining, 25);
});

test('the action logs the budget when GitHub sends the headers, and the call count when it does not', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { run: runAction } = await import('../src/action-run.mjs');
  const fetchFor = (headers) => async (url) => {
    const path = url.replace('https://api.github.com/', '');
    const body = path.startsWith('repos/o/r/actions/runs?') ? { workflow_runs: runs(3) }
      : path.startsWith('repos/o/r/actions/runs/') ? { jobs: [job()] }
        : path.startsWith('repos/o/r/contents/') ? [] : { default_branch: 'main', visibility: 'private' };
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  const go = async (headers) => {
    const dir = mkdtempSync(join(tmpdir(), 'ciw-budget-'));
    const summary = join(dir, 'summary.md');
    let out = '';
    const env = { INPUT_REPOSITORY: 'o/r', INPUT_TOKEN: 'x', RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary };
    assert.equal(await runAction({ env, stdout: { write: (s) => (out += s) }, fetchImpl: fetchFor(headers) }), 0);
    return { out, summary: readFileSync(summary, 'utf8'), json: JSON.parse(readFileSync(join(dir, 'ci-wizard', 'report.json'), 'utf8')) };
  };
  const withHeaders = await go({ 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '980' });
  assert.match(withHeaders.out, /\d+ API calls, 980 of 1000 left this hour; a GitHub App's token has its own 5,000 or more; report in the job summary/);
  assert.match(withHeaders.summary, /- API budget: \d+ API calls, 980 of 1000 left this hour/);
  assert.deepEqual(withHeaders.json.rate_limit, { limit: 1000, remaining: 980 });
  const without = await go({});
  assert.match(without.out, /findings, \d+ API calls; report in the job summary/);
  assert.doesNotMatch(without.summary, /API budget/);
});
