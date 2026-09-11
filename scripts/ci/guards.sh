#!/usr/bin/env bash
set -euo pipefail

# test:slack-socket-compat lives here rather than in a test lane: it is a `bun test` over a file the
# Vitest globs exclude, and it touches no infrastructure, so it must not pin a lane to Docker.
bun run check:live-test-scripts
bun run db:check
bun run check:connector-architecture
bun run check:test-layout
bun run test:slack-socket-compat
