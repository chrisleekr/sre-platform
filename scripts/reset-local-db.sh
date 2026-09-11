#!/bin/sh
set -eu

# Reset must stay pinned to the local Compose database.
local_database_url='postgres://sre:sre@localhost:45432/sre_platform'

echo 'Starting local Postgres...'
docker compose up -d --wait postgres

echo 'Recreating the local database...'
docker compose exec -T postgres sh -eu -c '
  dropdb --if-exists --force --maintenance-db=postgres --username="$POSTGRES_USER" "$POSTGRES_DB"
  createdb --maintenance-db=postgres --username="$POSTGRES_USER" --owner="$POSTGRES_USER" "$POSTGRES_DB"
'

echo 'Applying migrations...'
NODE_ENV=development DATABASE_URL="$local_database_url" bun run db:migrate

echo 'Local database reset and migrated.'
