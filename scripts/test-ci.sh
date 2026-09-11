#!/usr/bin/env bash
set -euo pipefail

# The oven/bun image symlinks node to bun, so `node` here is whichever runtime resolves first.
# Pin the suite to the real Node the pipeline installs: a test result only means something on the
# runtime the tests are written against. Under Bun 1.3 this was also a correctness guard, because
# the shim collected zero tests and exited 0. Bun 1.4 collects and runs them normally, so the check
# now enforces the choice rather than catching a silent pass. Refuse anything but real Node 22.12
# or newer before starting Vitest. The floor comes from the Vitest Getting Started guide
# ("Vitest requires Vite >=v6.4.0 and Node >=v22.12.0"), not from vitest's package.json engines
# field, which is wider.
node -e '
  if (process.versions.bun) {
    console.error("node resolves to the Bun shim (bun " + process.versions.bun + "); this test gate needs real Node >= 22.12");
    process.exit(1);
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    console.error("node " + process.versions.node + " is too old; this test gate needs real Node >= 22.12");
    process.exit(1);
  }
  console.log("test runtime: " + process.execPath + " (node " + process.versions.node + ")");
'

# The lane this run covers. Validated after the runtime guard, never before it: the guard is the
# only thing that may fail first, so a wrong runtime is reported as a wrong runtime.
lane=${1:-}
case "$lane" in
  backend | ui) ;;
  *)
    echo "usage: scripts/test-ci.sh <backend|ui>" >&2
    exit 1
    ;;
esac

# Invoke the entrypoint under the node the guard just checked. `bunx vitest` and the
# node_modules/.bin shim resolve through whatever runtime Bun picks, which is the case being refused.
# The report path carries the lane so running both lanes locally does not clobber one file.
report=".vitest/json/$lane.json"
rm -f "$report"
node node_modules/vitest/vitest.mjs run \
  --project="$lane" \
  --reporter=default \
  --reporter=json \
  --outputFile="$report"

# List the test files in the tree so a dropped include glob cannot silently shrink the run. The
# manifest covers the whole tree, both lanes, which is what lets one lane verify the partition.
# Mirrors vitest.config.ts include and exclude, including configDefaults.exclude. Change them
# together. Symlinked test files are not listed; Vitest follows symlinks, so do not add one.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
manifest="$work/test-files.txt"
find apps packages scripts -type f \( \
  -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.jsx' -o \
  -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.spec.js' -o -name '*.spec.jsx' \
\) ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/cypress/*' \
  ! -path '*/.idea/*' ! -path '*/.git/*' ! -path '*/.cache/*' ! -path '*/.output/*' ! -path '*/.temp/*' \
  ! -name '*.bun.test.ts' ! -name '*.bun.test.js' ! -name '*.bun_test.ts' ! -name '*.bun_test.js' \
  -print > "$manifest"

node scripts/assert-tests-ran.mjs --lane "$lane" --manifest "$manifest" "$report"
