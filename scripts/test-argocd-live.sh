#!/bin/sh
set -eu

ARGOCD_VERSION=v3.4.6
ARGOCD_INSTALL_SHA256=752b5a2681f2522fc78ea12ba2d23be44a4523cfa5d9a55cf1907909cc23fc5d
KIND_VERSION=v0.32.0
KIND_NODE_IMAGE=kindest/node:v1.31.14@sha256:6f86cf509dbb42767b6e79debc3f2c32e4ee01386f0489b3b2be24b0a55aac2b
CLUSTER_NAME="sre-argocd-$$"
PORT=${ARGOCD_TEST_PORT:-$((20000 + ($$ % 20000)))}
TMP_DIR=$(mktemp -d)
PORT_FORWARD_PID=
KIND_BIN=
export KUBECONFIG="$TMP_DIR/kubeconfig"

cleanup() {
  if [ -n "$PORT_FORWARD_PID" ]; then kill "$PORT_FORWARD_PID" 2>/dev/null || true; fi
  if [ -n "$KIND_BIN" ]; then
    "$KIND_BIN" delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

for command in kubectl curl bun openssl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "required command not found: $command" >&2
    exit 1
  }
done

if command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{print $1}'; }
else
  echo "required SHA-256 command not found: shasum or sha256sum" >&2
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) CLI_ASSET=argocd-darwin-arm64; KIND_ASSET=kind-darwin-arm64 ;;
  Darwin-x86_64) CLI_ASSET=argocd-darwin-amd64; KIND_ASSET=kind-darwin-amd64 ;;
  Linux-aarch64 | Linux-arm64) CLI_ASSET=argocd-linux-arm64; KIND_ASSET=kind-linux-arm64 ;;
  Linux-x86_64) CLI_ASSET=argocd-linux-amd64; KIND_ASSET=kind-linux-amd64 ;;
  *) echo "unsupported host for pinned ArgoCD CLI" >&2; exit 1 ;;
esac

if [ -n "${ARGOCD_TEST_HOST:-}" ]; then
  TEST_HOST=$ARGOCD_TEST_HOST
elif [ "$(uname -s)" = Darwin ]; then
  TEST_HOST=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
else
  TEST_HOST=$(hostname -I 2>/dev/null | awk '{print $1}')
fi

curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/${KIND_ASSET}" -o "$TMP_DIR/kind"
curl -fsSL "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/${KIND_ASSET}.sha256sum" -o "$TMP_DIR/kind.sha256sum"
EXPECTED_KIND_SHA=$(awk '{print $1}' "$TMP_DIR/kind.sha256sum")
ACTUAL_KIND_SHA=$(sha256_file "$TMP_DIR/kind")
[ -n "$EXPECTED_KIND_SHA" ] && [ "$ACTUAL_KIND_SHA" = "$EXPECTED_KIND_SHA" ] || {
  echo "pinned kind checksum mismatch" >&2
  exit 1
}
chmod +x "$TMP_DIR/kind"
KIND_BIN="$TMP_DIR/kind"
case "$TEST_HOST" in
  10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].*) ;;
  *)
    echo "ARGOCD_TEST_HOST must be a specific RFC1918 address, never wildcard or loopback" >&2
    exit 1
    ;;
esac

curl -fsSL "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml" -o "$TMP_DIR/install.yaml"
ACTUAL_INSTALL_SHA=$(sha256_file "$TMP_DIR/install.yaml")
[ "$ACTUAL_INSTALL_SHA" = "$ARGOCD_INSTALL_SHA256" ] || {
  echo "pinned ArgoCD install manifest checksum mismatch" >&2
  exit 1
}
curl -fsSL "https://github.com/argoproj/argo-cd/releases/download/${ARGOCD_VERSION}/${CLI_ASSET}" -o "$TMP_DIR/argocd"
curl -fsSL "https://github.com/argoproj/argo-cd/releases/download/${ARGOCD_VERSION}/cli_checksums.txt" -o "$TMP_DIR/checksums"
EXPECTED_CLI_SHA=$(awk -v asset="$CLI_ASSET" '$2 == asset {print $1}' "$TMP_DIR/checksums")
ACTUAL_CLI_SHA=$(sha256_file "$TMP_DIR/argocd")
[ -n "$EXPECTED_CLI_SHA" ] && [ "$ACTUAL_CLI_SHA" = "$EXPECTED_CLI_SHA" ] || {
  echo "pinned ArgoCD CLI checksum mismatch" >&2
  exit 1
}
chmod +x "$TMP_DIR/argocd"

"$KIND_BIN" create cluster --name "$CLUSTER_NAME" --image "$KIND_NODE_IMAGE" --wait 120s
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts -f "$TMP_DIR/install.yaml"
kubectl -n argocd wait --for=condition=Available deployment/argocd-server --timeout=300s
case "$TEST_HOST" in
  *[!0-9.]*) CERT_SAN="DNS:${TEST_HOST}" ;;
  *) CERT_SAN="IP:${TEST_HOST}" ;;
esac
openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
  -keyout "$TMP_DIR/argocd-server.key" -out "$TMP_DIR/argocd-server.crt" \
  -subj "/CN=${TEST_HOST}" -addext "subjectAltName=${CERT_SAN}" >/dev/null 2>&1
kubectl -n argocd create secret tls argocd-server-tls \
  --cert="$TMP_DIR/argocd-server.crt" --key="$TMP_DIR/argocd-server.key"
ACCESS_COMMANDS_FILE="$TMP_DIR/access-commands.json" bun -e '
  import { argoCdAccessCommands, generateArgoCdAccess } from "./packages/connectors/src/data-sources/argocd/access.ts";
  const instructions = generateArgoCdAccess({
    account: "sre-platform",
    applicationsInAnyNamespace: false,
    applications: [{ project: "default", name: "guestbook" }],
  });
  await Bun.write(process.env.ACCESS_COMMANDS_FILE, JSON.stringify(argoCdAccessCommands(instructions)));
'
INSTALL_COMMAND=$(ACCESS_COMMANDS_FILE="$TMP_DIR/access-commands.json" bun -e '
  const commands = await Bun.file(process.env.ACCESS_COMMANDS_FILE).json();
  process.stdout.write(commands.install);
')
UNINSTALL_COMMAND=$(ACCESS_COMMANDS_FILE="$TMP_DIR/access-commands.json" bun -e '
  const commands = await Bun.file(process.env.ACCESS_COMMANDS_FILE).json();
  process.stdout.write(commands.uninstall);
')
sh -c "$INSTALL_COMMAND"
kubectl -n argocd patch configmap argocd-cm --type merge -p \
  '{"data":{"accounts.sre-denied":"apiKey"}}'
kubectl -n argocd rollout restart deployment/argocd-server
kubectl -n argocd rollout status deployment/argocd-server --timeout=300s

kubectl -n argocd port-forward --address "127.0.0.1,$TEST_HOST" service/argocd-server "$PORT:443" >"$TMP_DIR/port-forward.log" 2>&1 &
PORT_FORWARD_PID=$!
ADMIN_PASSWORD_ENCODED=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}')
if ADMIN_PASSWORD=$(printf '%s' "$ADMIN_PASSWORD_ENCODED" | base64 --decode 2>/dev/null); then :; else
  ADMIN_PASSWORD=$(printf '%s' "$ADMIN_PASSWORD_ENCODED" | base64 -D)
fi

attempt=0
until "$TMP_DIR/argocd" login "127.0.0.1:$PORT" --insecure --username admin --password "$ADMIN_PASSWORD" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { cat "$TMP_DIR/port-forward.log" >&2; exit 1; }
  sleep 1
done
STALE_TOKEN=$("$TMP_DIR/argocd" account generate-token --account sre-platform)
sh -c "$UNINSTALL_COMMAND"
sh -c "$INSTALL_COMMAND"
kubectl -n argocd rollout restart deployment/argocd-server
kubectl -n argocd rollout status deployment/argocd-server --timeout=300s
kill "$PORT_FORWARD_PID" 2>/dev/null || true
wait "$PORT_FORWARD_PID" 2>/dev/null || true
kubectl -n argocd port-forward --address "127.0.0.1,$TEST_HOST" service/argocd-server "$PORT:443" >"$TMP_DIR/port-forward.log" 2>&1 &
PORT_FORWARD_PID=$!
attempt=0
until "$TMP_DIR/argocd" login "127.0.0.1:$PORT" --insecure --username admin --password "$ADMIN_PASSWORD" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { cat "$TMP_DIR/port-forward.log" >&2; exit 1; }
  sleep 1
done
STALE_STATUS=$(curl --cacert "$TMP_DIR/argocd-server.crt" -sS \
  -H "Authorization: Bearer ${STALE_TOKEN}" \
  "https://${TEST_HOST}:${PORT}/api/v1/session/userinfo" \
  -o "$TMP_DIR/stale-userinfo.json" -w '%{response_code}')
STALE_PROTECTED_STATUS=$(curl --cacert "$TMP_DIR/argocd-server.crt" -sS \
  -H "Authorization: Bearer ${STALE_TOKEN}" \
  "https://${TEST_HOST}:${PORT}/api/v1/applications" \
  -o "$TMP_DIR/stale-applications.json" -w '%{response_code}')
STALE_STATUS="$STALE_STATUS" STALE_PROTECTED_STATUS="$STALE_PROTECTED_STATUS" \
  STALE_USERINFO_FILE="$TMP_DIR/stale-userinfo.json" bun -e '
  const status = Number(process.env.STALE_STATUS);
  const protectedStatus = Number(process.env.STALE_PROTECTED_STATUS);
  if (status !== 200) throw new Error(`userinfo returned HTTP ${status}`);
  const value = await Bun.file(process.env.STALE_USERINFO_FILE).json();
  if (
    value === null ||
    typeof value !== "object" ||
    value.loggedIn === true ||
    (typeof value.username === "string" && value.username.length > 0) ||
    (typeof value.iss === "string" && value.iss.length > 0)
  ) throw new Error("stale token still has an authenticated identity");
  if (protectedStatus !== 401 && protectedStatus !== 403) {
    throw new Error(`stale token reached protected applications API (HTTP ${protectedStatus})`);
  }
  console.log(`Stale token rejected by protected API (HTTP ${protectedStatus})`);
'
LIVE_TOKEN=$("$TMP_DIR/argocd" account generate-token --account sre-platform)
DENIED_TOKEN=$("$TMP_DIR/argocd" account generate-token --account sre-denied)
curl --cacert "$TMP_DIR/argocd-server.crt" -fsS \
  -H "Authorization: Bearer ${LIVE_TOKEN}" \
  "https://${TEST_HOST}:${PORT}/api/v1/session/userinfo" -o "$TMP_DIR/userinfo.json"
USERINFO_FILE="$TMP_DIR/userinfo.json" bun -e '
  const value = await Bun.file(process.env.USERINFO_FILE).json();
  const evidence = { loggedIn: value.loggedIn, username: value.username, iss: value.iss };
  console.log(`ArgoCD userinfo preflight: ${JSON.stringify(evidence)}`);
  if (value.loggedIn !== true) process.exit(1);
'

kubectl apply -f - <<'ARGOCD_TEST_APPLICATION'
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: guestbook
  namespace: argocd
  labels:
    sre-platform-proof: "true"
spec:
  project: default
  source:
    repoURL: https://github.com/argoproj/argocd-example-apps.git
    targetRevision: HEAD
    path: guestbook
  destination:
    server: https://kubernetes.default.svc
    namespace: default
  syncPolicy:
    automated:
      prune: false
      selfHeal: false
ARGOCD_TEST_APPLICATION
"$TMP_DIR/argocd" app wait guestbook --sync --health --timeout 300

ARGOCD_LIVE_BASE_URL="https://${TEST_HOST}:${PORT}" \
ARGOCD_LIVE_TOKEN="$LIVE_TOKEN" \
ARGOCD_LIVE_DENIED_TOKEN="$DENIED_TOKEN" \
ARGOCD_LIVE_APPLICATION=guestbook \
ARGOCD_LIVE_CA="$(cat "$TMP_DIR/argocd-server.crt")" \
bun test packages/connectors/src/data-sources/argocd/__tests__/argocd.live.bun_test.ts

NODE_EXTRA_CA_CERTS="$TMP_DIR/argocd-server.crt" \
ARGOCD_LIVE_BASE_URL="https://${TEST_HOST}:${PORT}" \
ARGOCD_LIVE_TOKEN="$LIVE_TOKEN" \
ARGOCD_LIVE_APPLICATION=guestbook \
ARGOCD_LIVE_CA="$(cat "$TMP_DIR/argocd-server.crt")" \
bunx vitest run apps/api/src/__tests__/argocd.live.test.ts
