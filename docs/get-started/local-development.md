# Local development

Bring the platform up on one machine and use the normal work-email form. Your configured development
email signs in without a password; other emails use company sign-in.

## Prerequisites

- Bun >= 1.4
- Node.js 22.12 or newer, for the test suite. The test gate runs Vitest on real Node, not on Bun.
- Docker, running. The test suite and `dev:setup` both start containers.
- `uv`, only if you intend to build this documentation site.

The example environment file ships the Prometheus and Grafana `kubectl port-forward` tunnels turned
off. They run unless `DEV_OBSERVABILITY_TUNNELS` is set to `false`, so keep that key set to `false`
in `.env` when you have no cluster.

## Bring it up

```
cp .env.example .env   # then set SECRETS_MASTER_KEY (openssl rand -base64 32)
bun install
bun run dev:setup # start containers, wait for health, apply migrations
bun run dev
```

Two processes serve the browser:

| Service | URL |
| --- | --- |
| Dashboard (Vite) | `http://localhost:45173` |
| API (Hono) | `http://localhost:43000` |

Open the dashboard. Both ports are fixed, so they do not move between machines.

## Sign in

### Local email sign-in (recommended)

Set these values in `.env`, restart `bun run dev`, and reload the browser:

```dotenv
ALLOW_LOCAL_DEVELOPMENT_LOGIN=true
LOCAL_LOGIN_EMAIL=dev@example.test
```

Open `http://localhost:45173`, enter the configured `LOCAL_LOGIN_EMAIL` in **Work email**, and select
**Continue**. No password or OIDC provider is required for that account. The server compares emails
case-insensitively after trimming whitespace. Other emails continue through ordinary company sign-in.

The first successful local sign-in creates or reuses a development workspace and grants that account
workspace owner and platform operator access. Subsequent page loads restore the existing session.
Sessions renew before expiry and recover after API restarts. Failed actions are not replayed.
Signing out clears the session and returns to the same email form, without automatic re-entry.
Use **Create a workspace** from that form to test onboarding. There is no separate development mode.

The API requires exactly `NODE_ENV=development`, binds to `127.0.0.1`, and rejects remote or forwarded
requests and requests without the exact configured dashboard origin and custom header.
Do not expose this listener through a proxy or tunnel. Other programs on your machine can access
the development account. Never enable this on a shared or deployed host.

To disable development email sign-in, set `ALLOW_LOCAL_DEVELOPMENT_LOGIN=false`, restart the API,
and reload the browser. Capabilities are cached for the page lifetime.

### Installation sign-in method

To sign in through a real directory instead, register the first installation sign-in method (the
staff provider that bootstrap creates) and the initial platform administrators:

```
BOOTSTRAP_STAFF_PROVIDER='{"displayName":"Staff sign-in","issuer":"https://idp.example.invalid/","jwksUri":"https://idp.example.invalid/jwks","browserClientId":"<browser-client-id>","audience":"https://api.example.invalid/"}' \
BOOTSTRAP_PLATFORM_ADMINS='[{"subject":"<subject>","email":"operator@example.invalid"}]' \
bun run db:bootstrap
```

`issuer` and `subject` correspond to the OIDC `iss` and `sub` claims. The command grants the declared
subject platform-administrator access without creating a workspace or membership. It is safe to
re-run. Bootstrap discovers and stores the method's browser authorization and server token endpoints
even when `jwksUri` is supplied, so the resulting method is immediately usable from the sign-in
page.
See [First-run bootstrap](../operate/bootstrap.md).

## Everyday commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Run every app's watcher (Turbo). |
| `bun run dev:infra` | Start containers without migrating. |
| `bun run db:reset` | Discard and rebuild only the local Postgres database. |
| `bun run typecheck && bun run test` | The two checks worth running before pushing. |
| `bun run test:onboarding-e2e` | Exercise workspace creation, sign-in recovery, provisioning, DNS verification, and responsive layouts in an isolated browser stack. |
| `bun run test:local-development-e2e` | Verify local email sign-in, API restart recovery, sign-out, and company sign-in fallback in an isolated browser stack. |

`bun run test` needs Docker but **not** `dev:setup`: it boots its own throwaway Postgres and Valkey
through Testcontainers and tears them down afterwards. It never touches your development database.
The suite also needs Node.js 22.12 or newer on your PATH. The gate pins Vitest to real Node so the
suite always runs on the runtime it is written against, rather than on whichever runtime `node`
happens to resolve to.

Install the matching Chromium build once with `bunx playwright install chromium` before running the
onboarding end-to-end check. That check also uses throwaway Postgres and Valkey containers, simulated
directory, email and DNS boundaries, and the real application API, worker, queue and browser UI.

The full set of checks CI runs is listed in `CONTRIBUTING.md` in the repository.

## Observability tunnels

Unless `DEV_OBSERVABILITY_TUNNELS` is set to `false`, `bun run dev` supervises loopback-only port
forwards for Prometheus (`http://127.0.0.1:9090`) and Grafana (`http://127.0.0.1:3000`). If a
`kubectl port-forward` exits it is restarted with bounded backoff. The defaults target the
`homelab-v2` context and the `monitoring` namespace; override them in `.env` with
`DEV_KUBE_CONTEXT`, `DEV_PROMETHEUS_NAMESPACE`, `DEV_PROMETHEUS_SERVICE`,
`DEV_PROMETHEUS_LOCAL_PORT`, `DEV_PROMETHEUS_REMOTE_PORT`, `DEV_GRAFANA_NAMESPACE`,
`DEV_GRAFANA_SERVICE`, `DEV_GRAFANA_LOCAL_PORT` and `DEV_GRAFANA_REMOTE_PORT`.
