# Container image

SRE Platform ships one image. Deploy each process as its own workload and select its behavior with
`ROLE`:

| `ROLE` | Process | Default port |
| --- | --- | --- |
| `api` | HTTP, WebSocket, inbound relay, and connector API | `3000` |
| `triage-worker` | Investigation, polling, scheduling, and lifecycle worker | none |
| `surface-worker` | Durable outbound Slack delivery worker | none |
| `dashboard` | Static dashboard and startup-generated browser configuration | `8080` |
| `migrate` | One-shot database migration and RLS validation | none |
| `bootstrap` | One-shot registration of the first installation sign-in method and platform administrators | none |

The default role is `api`. An unknown role exits with status 64 instead of starting the wrong process.
Run migrations as a one-shot deployment task before starting a new application version.

On a brand new deployment, run the `bootstrap` role once after the migration task and before the
application processes start. It registers the first installation sign-in method and the first
platform administrators, but deliberately does not create an organisation. See
[First-run bootstrap](bootstrap.md).

## Before it starts

Every role reads its configuration from environment variables when it starts. A missing required
value stops the process before it serves anything. A defaulted value points at `localhost`, which is
right for a laptop and wrong for every deployment, so treat those as required too.

| Variable | What it is | Roles that read it |
| --- | --- | --- |
| `DATABASE_URL` | Administrative database connection, defined below | Required by `api`, `triage-worker`, `surface-worker`, `migrate`, `bootstrap` |
| `APP_DATABASE_URL` | Application database connection, defined below | `api`, `triage-worker`, `surface-worker`; falls back to `DATABASE_URL`, see below |
| `APP_DB_PASSWORD` | Password that `migrate` sets on the `app_user` login role | Required by `migrate` under `NODE_ENV=production`, which the image sets |
| `SECRETS_MASTER_KEY` | 32-byte base64 key that encrypts stored credentials | Required by `api`, `triage-worker`, `surface-worker`; by `bootstrap` only when it stores a client secret |
| `VALKEY_URL` | Valkey connection for the queue, pub/sub, and cache | `api`, `triage-worker`, `surface-worker`; default `redis://localhost:6379` |
| `EMBEDDINGS_URL` | Local embeddings service | `triage-worker`; default `http://localhost:8080` |
| `PORT` | Listener port | `api`, default `3000`; `dashboard`, default `8080` |
| `TRUST_PROXY_HOPS` | How many forwarding hops in front of the API are trusted, so the public rate limit keys on the browser address rather than on the proxy. Default `0` ignores forwarded headers and uses the direct socket peer, which behind an ingress makes every browser share one bucket. A deployment behind one ingress normally sets `1`. Local passwordless sign-in refuses to arm unless it is `0`. | `api`, default `0` |
| `BOOTSTRAP_STAFF_PROVIDER`, `BOOTSTRAP_PLATFORM_ADMINS` | The first installation sign-in method and the first administrators | Required by `bootstrap`; see [First-run bootstrap](bootstrap.md#configuration) |

The `api` role also needs `DASHBOARD_BASE_URL` and `CORS_ORIGINS` set to the deployed dashboard
origin; see [Browser sessions and deployment](auth.md#browser-sessions-and-deployment). The
`dashboard` role needs only the variables in the next section. The Triage Engine's provider, model,
and credential are platform settings with environment fallbacks, not start-up requirements; see
[Settings and their fallbacks](settings.md#settings-and-their-fallbacks).

### The two database connections

The platform connects to Postgres as two different roles. Keeping them apart is what makes tenant
isolation hold.

- The **administrative database connection** (`DATABASE_URL`) owns the schema. `migrate` uses it to
  apply migrations, create the application login role, grant its table privileges, and force
  row-level security. `bootstrap` uses it for installation-wide writes. The long-running roles hold it
  for cross-tenant control-plane work only: queue dispatch, platform settings, platform secrets.
- The **application database connection** (`APP_DATABASE_URL`) is the `app_user` login role. It runs
  under row-level security and sees only the current request's tenant; every tenant-scoped read and
  write goes through it. `migrate` sets its password from `APP_DB_PASSWORD` on every run, so the
  string is `postgres://app_user:<APP_DB_PASSWORD>@<host>/<database>`.

When `APP_DATABASE_URL` is unset, the application connection falls back to `DATABASE_URL`. The `api`
and `triage-worker` roles then probe the connected role at start and refuse to run if it is a
superuser or carries `BYPASSRLS`, because either one bypasses every tenant policy. The local-only
opt-out, `ALLOW_SUPERUSER_APP_DB=true`, is refused under `NODE_ENV=production`. The `surface-worker`
role performs no such probe, so a deployment must not rely on the fallback.

### Order of first start

Run `migrate`, then `bootstrap`, then the long-running roles. [Ordering](bootstrap.md#ordering)
explains why.

## Dashboard runtime configuration

The dashboard assets are built once. The `dashboard` role generates `/runtime-config.js` from the
container environment on startup, so promotion between environments does not rebuild the image.

| Variable | Browser value |
| --- | --- |
| `DASHBOARD_API_BASE_URL` | Browser-reachable API origin, or empty for same origin |
| `DASHBOARD_WS_BASE_URL` | Optional WebSocket override; otherwise derived from the API origin |
| `PORT` | Dashboard listener port, default `8080` |

Provider-neutral OIDC metadata comes from the API's `/public-config` endpoint. The dashboard runtime
does not receive provider token, key, or client-secret configuration. Local Vite development uses
the `VITE_API_BASE_URL` and optional `VITE_WS_BASE_URL` values documented in `.env.example`.

## Published tags

| Tag | Mutable | Source |
| --- | --- | --- |
| `docker.io/chrisleekr/sre-platform:1.2.3` | no | the `v1.2.3` release |
| `docker.io/chrisleekr/sre-platform:latest` | yes | the newest release |

Both are built for amd64 and arm64. Version tags are immutable release artifacts. `latest` is
deliberately mutable and follows the newest release, so a deployment that must not move should name
a version. Pull requests build and smoke-test the production image but never publish it.

A `buildcache` tag may appear alongside these. It is a build-cache artifact, not a runnable image.
