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
  assert.equal(budgetText({ api_calls: 3, rate_limit: { limit: 60, remaining: null } }), "3 API calls, a limit of 60 left this hour; a GitHub App's token has its own 5,000 or more");
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
