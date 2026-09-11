#!/usr/bin/env bash
set -euo pipefail

# The one command that reproduces CI locally. No provider invokes it: each provider runs the lane
# scripts below as parallel jobs. Ordered fastest-feedback-first, not as the pipeline schedules them.
bash scripts/ci/lint.sh
bash scripts/ci/guards.sh
bash scripts/ci/typecheck.sh
bash scripts/ci/test-ui.sh
bash scripts/ci/test.sh
bash scripts/ci/build.sh
