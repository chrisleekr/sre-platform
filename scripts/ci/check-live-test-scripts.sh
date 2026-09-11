#!/usr/bin/env bash
set -euo pipefail

bundle_dir=$(mktemp -d)
trap 'rm -rf "$bundle_dir"' EXIT

bun build scripts/test-alertmanager-slack-live.mjs \
  --target=bun \
  --outfile="$bundle_dir/test-alertmanager-slack-live.mjs"
