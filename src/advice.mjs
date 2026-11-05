// Concrete YAML for the fixes, tailored to what the repository commits and what the workflow file
// says. Each example is the smallest change that carries the fix, written against the step the
// workflow already has where it can be, so it reads as an edit rather than a new design. Action
// versions are left out on purpose: pin whatever version (or full SHA) the workflow already uses.

/** The lockfile each package manager reads, in the order a repository is most likely to commit it. */
const LOCK_OF = {
  npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lock',
  uv: 'uv.lock', poetry: 'poetry.lock', pipenv: 'Pipfile.lock', pip: 'requirements.txt',
  go: 'go.sum', bundler: 'Gemfile.lock', cargo: 'Cargo.lock',
};

/** The package manager the advice is for: the first the workflow installs with, or one the repository's lockfile names. */
export function managerOf(installers = [], lockfiles = []) {
  if (installers.length) return installers[0];
  const byLock = Object.entries(LOCK_OF).find(([, lock]) => lockfiles.includes(lock) || (lock === 'bun.lock' && lockfiles.includes('bun.lockb')));
  return byLock ? byLock[0] : 'npm';
}

/**
 * The cache for one package manager: the setup action's own cache input where it has one (one
 * line on a step the workflow already runs), actions/cache otherwise.
 */
export function cacheExample(manager, lockfiles = []) {
  const committed = (name) => lockfiles.includes(name);
  switch (manager) {
    case 'npm':
      if (committed('package-lock.json')) return '# on the existing actions/setup-node step\nwith:\n  cache: npm';
      return [
        '# no lockfile is committed, so key the cache on package.json',
        '- uses: actions/cache',
        '  with:',
        '    path: ~/.npm',
        "    key: ${{ runner.os }}-npm-${{ hashFiles('**/package.json') }}",
        '    restore-keys: ${{ runner.os }}-npm-',
      ].join('\n');
    case 'pnpm':
      return '# on the existing actions/setup-node step (after pnpm/action-setup)\nwith:\n  cache: pnpm';
    case 'yarn':
      return '# on the existing actions/setup-node step\nwith:\n  cache: yarn';
    case 'uv':
      return '# on the existing astral-sh/setup-uv step\nwith:\n  enable-cache: true';
    case 'poetry':
      return '# on the existing actions/setup-python step (after installing poetry)\nwith:\n  cache: poetry';
    case 'pipenv':
      return '# on the existing actions/setup-python step\nwith:\n  cache: pipenv';
    case 'pip':
      return '# on the existing actions/setup-python step\nwith:\n  cache: pip';
    case 'go':
      return '# on the existing actions/setup-go step (v4 and later cache unless told not to)\nwith:\n  cache: true\n  cache-dependency-path: go.sum';
    case 'bundler':
      return '# on the existing ruby/setup-ruby step\nwith:\n  bundler-cache: true';
    case 'cargo':
      return [
        '- uses: actions/cache',
        '  with:',
        '    path: |',
        '      ~/.cargo/registry',
        '      ~/.cargo/git',
        '      target',
        "    key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}",
      ].join('\n');
    case 'bun':
      return [
        '- uses: actions/cache',
        '  with:',
        '    path: ~/.bun/install/cache',
        `    key: \${{ runner.os }}-bun-\${{ hashFiles('**/${committed('bun.lockb') ? 'bun.lockb' : 'bun.lock'}') }}`,
      ].join('\n');
    default:
      return '';
  }
}

/** A concurrency group that cancels a pull request's outdated run and leaves runs on branches alone. */
export const CANCEL_OUTDATED = [
  'concurrency:',
  '  group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}',
  '  cancel-in-progress: true',
].join('\n');

/**
 * Push for the default branch, pull_request for the rest: each commit runs once. The branch is the
 * repository's default when it is known, else the one the push trigger already names (main or
 * master), else a marked placeholder: guessing `main` would switch off push CI on a repository
 * whose default branch is develop.
 */
export function triggerExample(pushBranches = [], defaultBranch = null) {
  const named = pushBranches.find((b) => b === 'main' || b === 'master');
  const branch = defaultBranch || named;
  if (branch) return `on:\n  push:\n    branches: [${JSON.stringify(branch)}]\n  pull_request:`;
  return 'on:\n  push:\n    branches: [DEFAULT-BRANCH]   # replace with the repository\'s default branch\n  pull_request:';
}

/** One concurrency group per commit for both events, so the second run of a commit cancels the first. */
export const ONE_RUN_PER_COMMIT = [
  'concurrency:',
  '  group: ${{ github.workflow }}-${{ github.event.pull_request.head.sha || github.sha }}',
  '  cancel-in-progress: true',
].join('\n');

/**
 * What the checkout step does that costs time, from the workflow file: the causes it names, and
 * the example that removes them. Empty causes mean the step fetches one commit; the caller checks
 * `inspected` and `depthUnknown` first, since then the file does not say.
 */
export function checkoutAdvice(checkout = {}) {
  const causes = [];
  const lines = [];
  if (checkout.fullHistory) {
    causes.push('`fetch-depth: 0` fetches the whole history');
    lines.push('  fetch-depth: 1   # or the few commits the job reads');
  } else if (checkout.depth > 1) {
    causes.push(`\`fetch-depth: ${checkout.depth}\` fetches ${checkout.depth} commits`);
    lines.push(`  fetch-depth: 1   # or the fewest of the ${checkout.depth} commits the job reads`);
  }
  if (checkout.lfs) {
    causes.push('`lfs: true` downloads every LFS object');
    lines.push('  lfs: false       # in the jobs that do not read the LFS files');
  }
  if (checkout.submodules) {
    causes.push('`submodules` clones each submodule');
    lines.push('  submodules: false');
  }
  if (checkout.tags) {
    causes.push('`fetch-tags: true` fetches every tag');
    lines.push('  fetch-tags: false');
  }
  if (causes.length) return { causes, example: `# on the existing actions/checkout step\nwith:\n${lines.join('\n')}` };
  return {
    causes,
    example: '# on the existing actions/checkout step: fetch only the paths the job reads\nwith:\n  sparse-checkout: |\n    src\n    package.json',
  };
}
