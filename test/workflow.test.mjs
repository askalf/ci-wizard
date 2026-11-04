import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allSteps, category, categoryOf, concurrencyGroupOf, parseWorkflow, pushBranchesOf, stepCommands, triggersOf, workflowFacts } from '../src/workflow.mjs';

const WF = `name: CI
on:
  push:
    branches: [main, 'feat/*']
  pull_request:
  workflow_dispatch:
concurrency:
  group: ci-\${{ github.event.number || github.sha }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: |
          echo preparing
          npm install --ignore-scripts
      - run: npm test
`;

test('category: by name, with "Post " steps counted as what they post for', () => {
  assert.equal(category('Set up job'), 'overhead');
  assert.equal(category('Run actions/checkout@v4'), 'checkout');
  assert.equal(category('Post Run actions/checkout@v4'), 'checkout');
  assert.equal(category('Run actions/setup-node@v4'), 'toolchain');
  assert.equal(category('npm ci'), 'deps');
  assert.equal(category('Restore cache'), 'cache');
  assert.equal(category('Run actions/upload-artifact@v4'), 'artifacts');
  assert.equal(category('Build docker image'), 'docker');
  assert.equal(category('Run tests'), 'work');
});

test('stepCommands names unnamed steps the way GitHub does', () => {
  const m = stepCommands(parseWorkflow(WF));
  assert.equal(m.get('Run actions/checkout@v4'), 'actions/checkout@v4');
  assert.equal(m.get('Run npm test'), 'npm test');
  assert.match(m.get('Install'), /npm install/);
});

test('categoryOf: a multi-line run that installs dependencies on any line counts as dependencies', () => {
  const m = stepCommands(parseWorkflow(WF));
  assert.equal(categoryOf('Install', m), 'deps');
  assert.equal(categoryOf('Run npm test', m), 'work');
  assert.equal(categoryOf('Install', new Map()), 'work');
});

test('triggers, push branches and the concurrency group', () => {
  const d = parseWorkflow(WF);
  assert.deepEqual(triggersOf(d), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(pushBranchesOf(d), ['main', 'feat/*']);
  assert.equal(concurrencyGroupOf(d), 'ci-${{ github.event.number || github.sha }}');
  assert.deepEqual(triggersOf(parseWorkflow('on: [push, pull_request]\n')), ['pull_request', 'push']);
  assert.deepEqual(triggersOf(parseWorkflow('on: push\n')), ['push']);
  assert.equal(concurrencyGroupOf(parseWorkflow('concurrency: deploy\n')), 'deploy');
});

test('a file that does not parse yields no facts, never an error', () => {
  const d = parseWorkflow('on: [push\njobs: {');
  assert.deepEqual(d, {});
  assert.deepEqual(triggersOf(d), []);
  assert.equal(stepCommands(d).size, 0);
});

test('a job whose steps are not a list has no steps, and does not stop the rest of the file', () => {
  const doc = parseWorkflow(['jobs:', '  odd:', '    steps:', '      a: 1', '  count:', '    steps: 3', '  fine:', '    steps:', '      - run: npm ci', ''].join(String.fromCharCode(10)));
  assert.deepEqual([...stepCommands(doc).values()], ['npm ci']);
  assert.equal(workflowFacts(doc).npmInstallNoCi, false);
  assert.equal(allSteps(doc).length, 1);
});
