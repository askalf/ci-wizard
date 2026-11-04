#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
#
# ci-wizard reads text it does not control: workflow files from other repositories, the run
# history the GitHub API returns for them, and the report files a person hands to `compare`.
# Each target feeds hostile input into one of those paths and asserts its contract; see the
# header of each fuzz/*.fuzz.js.

cd "$SRC/ci-wizard"

# npm ci verifies every integrity hash in the committed lockfile.
npm ci --no-audit --no-fund

# Jazzer.js comes from its own lockfile (.clusterfuzzlite/package-lock.json) rather than a
# devDependency, so the published package's dependency tree stays exactly as committed. It is
# merged into the project node_modules where compile_javascript_fuzzer expects to resolve it.
npm ci --prefix .clusterfuzzlite --no-audit --no-fund
cp -r .clusterfuzzlite/node_modules/. node_modules/

# The targets import src/ directly, so there is no build step.
for target in workflow_yaml run_history compare_report; do
  compile_javascript_fuzzer ci-wizard "fuzz/${target}.fuzz.js"
done
