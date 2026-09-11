#!/usr/bin/env bash
set -euo pipefail

misplaced=$(find apps packages scripts -type f \( \
  -name '*.test.ts' -o -name '*.test.tsx' -o \
  -name '*.spec.ts' -o -name '*.spec.tsx' -o \
  -name '*.test.js' -o -name '*.test.jsx' -o \
  -name '*.spec.js' -o -name '*.spec.jsx' -o \
  -name '*.bun_test.ts' -o -name '*.bun_test.js' \
\) ! -path '*/__tests__/*' -print)

if [[ -n "$misplaced" ]]; then
  printf 'Test files must live in the nearest module __tests__ directory:\n%s\n' "$misplaced" >&2
  exit 1
fi
