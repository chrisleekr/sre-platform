#!/bin/sh
set -eu

case "${ROLE:-api}" in
  api)
    exec bun run /app/apps/api/src/index.ts
    ;;
  triage-worker)
    exec bun run /app/apps/triage-worker/src/index.ts
    ;;
  surface-worker)
    exec bun run /app/apps/surface-worker/src/index.ts
    ;;
  dashboard)
    exec bun run /app/apps/dashboard/src/server.ts
    ;;
  migrate)
    exec bun run /app/packages/db/src/migrate.ts
    ;;
  bootstrap)
    exec bun run /app/packages/db/src/bootstrap.ts
    ;;
  *)
    echo "Unsupported ROLE '${ROLE}'. Expected api, triage-worker, surface-worker, dashboard, migrate, or bootstrap." >&2
    exit 64
    ;;
esac
