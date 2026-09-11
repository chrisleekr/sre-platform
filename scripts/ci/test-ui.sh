#!/usr/bin/env bash
set -euo pipefail

# No Docker daemon and no database. The partition guard inside the lane proves it stays that way.
bun run test:ci:ui
