#!/usr/bin/env bash
set -euo pipefail

uv lock --check
uv run --locked --group docs mkdocs build --strict
