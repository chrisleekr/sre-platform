#!/usr/bin/env bash
set -euo pipefail

# The only lane that needs a Docker daemon.
bun run test:ci:backend
