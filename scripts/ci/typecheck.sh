#!/usr/bin/env bash
set -euo pipefail

# --concurrency=2 stays: uncapped Turbo fan-out has OOM-killed a CI runner here, and running this
# lane on its own runner does not change how much memory the fan-out wants.
bun run typecheck --concurrency=2
bun run typecheck:scripts
