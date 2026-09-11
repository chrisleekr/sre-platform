#!/bin/sh
set -eu

image=${1:-}
if [ -z "$image" ]; then
  echo 'Usage: docker-smoke.sh <image:tag>' >&2
  exit 64
fi

container_id=''
cleanup() {
  if [ -n "$container_id" ]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

container_id=$(docker run --detach --rm \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges=true \
  --env ROLE=dashboard \
  --env PORT=8080 \
  --env DASHBOARD_API_BASE_URL=https://api.example.test \
  "$image")

attempt=0
until docker exec "$container_id" bun -e \
  "const r = await fetch('http://127.0.0.1:8080/healthz'); if (!r.ok) process.exit(1)"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$container_id" >&2
    exit 1
  fi
  sleep 1
done

runtime_config=$(docker exec "$container_id" bun -e \
  "const r = await fetch('http://127.0.0.1:8080/runtime-config.js'); if (!r.ok) process.exit(1); console.log(await r.text())")
echo "$runtime_config" | grep -F 'https://api.example.test' >/dev/null
if echo "$runtime_config" | grep -F 'auth0' >/dev/null; then
  echo 'Dashboard runtime configuration leaked provider-specific fields.' >&2
  exit 1
fi

docker exec "$container_id" bun -e "
  const origin = 'http://127.0.0.1:8080';
  const framingIsDenied = (response) =>
    response.headers.get('content-security-policy') === "frame-ancestors 'none'" &&
    response.headers.get('x-frame-options') === 'DENY';
  const root = await fetch(origin + '/');
  if (!root.ok || root.headers.get('cache-control') !== 'no-cache' || !framingIsDenied(root)) process.exit(1);
  const html = await root.text();
  const assetPath = html.match(/src=\"(\\/assets\\/[^\"]+\\.js)\"/)?.[1];
  if (!assetPath) process.exit(1);
  const asset = await fetch(origin + assetPath);
  if (!asset.ok || asset.headers.get('cache-control') !== 'public, max-age=31536000, immutable' || !framingIsDenied(asset)) process.exit(1);
  const missing = await fetch(origin + '/missing.js');
  if (missing.status !== 404 || !framingIsDenied(missing)) process.exit(1);
  const malformed = await fetch(origin + '/%E0%A4%A');
  if (malformed.status !== 400 || !framingIsDenied(malformed)) process.exit(1);
  if ((await fetch(origin + '/%2e%2e%2fpackage.json')).status !== 404) process.exit(1);
"

spa_status=$(docker exec "$container_id" bun -e \
  "const r = await fetch('http://127.0.0.1:8080/incidents/example'); console.log(r.status)")
if [ "$spa_status" != '200' ]; then
  echo "Dashboard SPA fallback returned $spa_status" >&2
  exit 1
fi

cleanup
container_id=''

# set -eu aborts on a bare assignment from a failing command, so guard the capture. The grep only
# proves the fallback help text lists the bootstrap role, so an operator reading the error is not
# told a supported role is unsupported. Dispatch itself is covered by assert_db_role_fails_without_database.
unsupported_output=$(docker run --rm --env ROLE=unsupported "$image" 2>&1) && unsupported_status=0 ||
  unsupported_status=$?
if [ "$unsupported_status" -eq 0 ]; then
  echo 'The image accepted an unsupported ROLE.' >&2
  exit 1
fi
if ! printf '%s' "$unsupported_output" | grep -qF 'bootstrap'; then
  printf 'The unsupported-ROLE message does not list the bootstrap role:\n%s\n' \
    "$unsupported_output" >&2
  exit 1
fi

# The dashboard role serves prebuilt files and imports nothing from node_modules, so
# every check above passes on an image whose dependencies cannot be resolved. Resolve
# one third-party entry point from inside a workspace, which is where the roles that
# do the work import from, and start a role that loads its own module graph.
docker run --rm --workdir /app/packages/db --entrypoint bun "$image" -e \
  "require.resolve('drizzle-orm/postgres-js'); require.resolve('postgres')"

# Import the API composition root without starting a server. This catches runtime dependencies
# accidentally classified as development-only before a release reaches Kubernetes.
docker run --rm --workdir /app/apps/api --entrypoint bun "$image" -e \
  "await import('./src/app.ts')"

# Start a role with an unreachable database on purpose, so this proves only that the role starts,
# resolves its own module graph and runs its own code, not that it can write. The name is narrow on
# purpose: the assertions below only hold for one-shot roles that cannot succeed without a database.
# A role that legitimately exits 0 without one does not belong here. Trailing args are docker flags.
assert_db_role_fails_without_database() {
  role=$1
  shift
  role_output=$(docker run --rm \
    --env ROLE="$role" \
    --env DATABASE_URL=postgres://sre:sre@127.0.0.1:1/sre_platform \
    "$@" \
    "$image" 2>&1) && role_status=0 || role_status=$?
  # Docker reserves 125 (docker run itself failed), 126 (command not invokable) and 127 (command not
  # found). Every assertion below passes vacuously in those cases: the exit is non-zero and the
  # output carries none of the strings we grep for, because the role never started.
  case "$role_status" in
    125 | 126 | 127)
      printf 'Role %s never started: docker exited %s:\n%s\n' \
        "$role" "$role_status" "$role_output" >&2
      exit 1
      ;;
  esac
  if printf '%s' "$role_output" | grep -qE 'Cannot find module|error: Cannot find'; then
    printf 'Role %s cannot resolve its dependencies:\n%s\n' "$role" "$role_output" >&2
    exit 1
  fi
  if printf '%s' "$role_output" | grep -qF 'Unsupported ROLE'; then
    printf 'Role %s has no entrypoint branch:\n%s\n' "$role" "$role_output" >&2
    exit 1
  fi
  # The absence of an error is not evidence the role ran. Both probed roles drive postgres-js far
  # enough to surface the connect failure verbatim, so require that signature as positive proof the
  # role executed its own code rather than dying before it reached the database layer.
  if ! printf '%s' "$role_output" | grep -qE 'ECONNREFUSED|Connection refused'; then
    printf 'Role %s never reached the database layer, so nothing here proves it ran:\n%s\n' \
      "$role" "$role_output" >&2
    exit 1
  fi
  if [ "$role_status" -eq 0 ]; then
    printf 'Role %s exited 0 with an unreachable database, so it reached a database it should not have:\n%s\n' \
      "$role" "$role_output" >&2
    exit 1
  fi
}

assert_db_role_fails_without_database migrate --env APP_DB_PASSWORD=smoke-test-password
assert_db_role_fails_without_database bootstrap \
  --env BOOTSTRAP_STAFF_PROVIDER='{"displayName":"Staff sign-in","issuer":"https://idp.example.test/","jwksUri":"https://idp.example.test/jwks","browserClientId":"smoke-browser","audience":"https://api.example.test/"}' \
  --env BOOTSTRAP_PLATFORM_ADMINS='[{"subject":"smoke|operator"}]'

docker run --rm --entrypoint sh "$image" -c '
  case "$(uname -m)" in
    x86_64) package="@anthropic-ai+claude-agent-sdk-linux-x64-musl" ;;
    aarch64) package="@anthropic-ai+claude-agent-sdk-linux-arm64-musl" ;;
    *) echo "Unsupported image architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  find /app/node_modules/.bun -maxdepth 1 -type d -name "${package}@*" | grep -q .
'
