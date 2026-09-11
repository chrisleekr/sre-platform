#!/usr/bin/env bash
set -euo pipefail

bun run lint
bun run docs:gen --check
bun run docs:lint
