# CLAUDE.md

> Engineering charter for Claude Code. Keep short. User and operator guidance lives in `docs/` and
> is built by MkDocs.

## Project

SRE Intelligence Platform is a multi-tenant SaaS that unifies observability, incident triage, and reliability metrics across each tenant's infrastructure. A pluggable AI triage engine investigates incidents conversationally across Slack and a React dashboard. Domain language: `CONTEXT.md`. Product doctrine and its grounding in Google's SRE book: `docs/understand/philosophy.md`.

## Architecture principles

Correctness first. Before writing code, confirm the design is sound: surface tradeoffs, name the simplest option that preserves the invariants below, and cite authoritative references (official docs, release notes, RFCs) for any version or API claim. Push back when a request would violate an invariant; ask before guessing.

**Deployed software.** Preserve upgrade paths for existing installations and stored data. Prefer the correct, extensible design over the minimal diff, but make breaking changes explicit and migrate durable state deliberately. The invariants below still bind; name a large refactor before starting it.

## Core invariants

- **Tenant isolation is absolute.** Every domain table carries `tenant_id`; Postgres RLS enforces it; a verified `(issuer, subject)` identifies the user and exactly one membership selects the tenant per request. An RLS gap is a cross-tenant data leak.
- **Postgres is the durable source of truth.** Every queued unit of work is written to Postgres before its Valkey Stream entry; consumers and the reconciler are idempotent. No SQS.
- **One LLM provider per deployment, no cross-provider fallback.** The Triage Engine is Claude *or* OpenAI by config. Resilience is degrade-and-redeliver, never a second provider.
- **The Conversation Hub is the single source of truth for triage dialogue.** The engine reads/writes only the hub; Slack/dashboard are thin adapters.
- **One atomic incident opener.** `openIncidentWorkspace` is the sole ingress: one tenant transaction writes the Incident, its first Signal, the opener audit line, and the triage job. `packages/alerts/src/__tests__/ingress-invariant.test.ts` enforces it as a source scan — only `packages/alerts/src/open-incident-workspace.ts` and `packages/db/src/incident-repo/create.ts` may call `createIncident`. Slack's `routeToIncident` and the dashboard declaration routes are adapters to it, never alternate creation paths.
- **Inbound is always a conversation.** A *signal* enters the platform only as a message a human can see and reply to (today: a Slack message in a subscribed channel), so a provider-born Incident always has a thread. An operator declaration from platform-owned evidence is not inbound and has no thread. A future non-chat source (webhook, PagerDuty) posts into a subscribed channel and enters the same way, rather than minting an incident directly.
- **Secrets never leave our control plane in plaintext.** Connector credentials are AES-256-GCM encrypted in Postgres under RLS, decrypted only in-app at point of use.
- **No new stateful datastore.** Postgres (+ pgvector) and Valkey are the only data stores; adding another needs explicit review and sign-off on the merge request.

## SRE doctrine (target state)

Derived from Google's *SRE* book; the argument and chapter citations live in `docs/understand/philosophy.md`. Unlike the Core invariants above — every one of which holds at HEAD and has a mechanism behind it — **several of these are not implemented yet**. They bind *new* code and refuse designs that contradict them; a bullet describes current behaviour only where it names the mechanism. Every principle there carries a status line; read it before assuming a guard exists. Tracked under the *Edition 2* milestone.

- **Reliability is measured, never asserted.** Any health number the platform shows resolves to an SLI query a human can re-run against their own backend. Store SLO definitions and computed burn events; never SLI samples. [Ch 4]
- **The error budget is a read model, never an ingress.** Budget state may enrich, rank, stamp and report; it may never call `openIncidentWorkspace`. Measurement does not need ingress, so this does not weaken "inbound is always a conversation". `packages/alerts/src/__tests__/ingress-invariant.test.ts` scans `createIncident`, `openIncidentWorkspace` and `routeToIncident` call sites against a per-symbol allow-list, so a budget module that grows an ingress fails at review time. [Ch 3]
- **Not every signal is a page.** Every material free-form signal receives one metered semantic classification and one durable disposition: `investigate` (opens an Incident and spends a full investigation run), `ticket` (queued for review without an investigation run), or `log` (retained context). `investigate` is never the default. Enforcement remains fail-closed in shadow mode until the current model runtime exactly matches the reviewed corpus and an operator approves it. The retained record is the `scrubSecrets`-scrubbed normalized signal plus its fingerprint, **never the raw provider event** (`candidate.raw` is deliberately unscrubbed as the fingerprint source), carries `tenant_id` under RLS, and expires on a bounded per-tenant window. Retaining more of a filtered signal than an investigated one is a CWE-532 regression. [Ch 1 (three outputs), Ch 6 (the page test)]
- **Postmortems are not runbooks.** A runbook says how to fix it next time; a postmortem records contributing causes plus action items typed `prevent`/`mitigate`/`process`, each with an owner and a tracker link, each tracked to done. An untracked action item is a bug, and is counted as one. **Built**: `postmortems` and `postmortem_action_items` under RLS with composite same-tenant FKs; one postmortem per incident, generated by `postmortem.generate` on the runbook stream from a responder's declared Ch 15 trigger, never automatically; `GET /reliability/postmortems` reports open, untracked and past-due items. The ingress-invariant scan still forbids every postmortem and grading module from calling `openIncidentWorkspace`. [Ch 15]
- **Blameless by construction.** No generated artifact names a human as a cause. `author_user_id` is attribution, who to ask, never causation. **Built**: the postmortem consumer generates under `BLAMELESS_SYSTEM_PROMPT` and then runs `stripHumanIdentifiers` (tenant member emails, local parts, `<@U…>` mentions, `@handles` and any email-shaped token) over every generated field before storage; `apps/triage-worker/src/__tests__/blameless.test.ts` proves it. Stated limit: a bare first name that is not a member email local-part is caught only by the prompt. [Ch 15]
- **No magic without a falsifier.** Every causal claim carries the evidence that produced it and a way to score it against outcome. An unscored `confidence` is a number pretending to be a measurement. **Built**: `assessment_grades` under RLS snapshots each graded run's claimed confidence beside a human verdict (finding confirm/correct) and a model verdict (`assessment.grade`, enqueued only by publishing a postmortem); the human verdict overrides, the judge's is kept for the agreement rate; `GET /reliability/rca-calibration` reports accuracy only from `RCA_CALIBRATION_FLOOR` (10) graded runs per bucket and never rescales a confidence. [Ch 6, Ch 12]
- **Count the toil the platform creates.** Every human interaction it demands — an approval, a re-ask, a corrected hypothesis — is counted and reported alongside the toil it removes. [Ch 5]

## Stack

- Runtime: Bun. API: Hono. Dashboard: React + Vite + Tailwind. Language: TypeScript (strict).
- Data: PostgreSQL + pgvector (Drizzle ORM + migrations; drizzle-kit owns all schema DDL — tables, indexes and RLS policies. The only raw SQL left in `migrate.ts` is what drizzle-kit cannot emit: `CREATE EXTENSION vector`, the login role + grants, `FORCE ROW LEVEL SECURITY`, and the RLS coverage assertion), Valkey (Streams queue + pub/sub + cache).
- AI: operator-managed Triage Engine. Claude uses the Claude Agent SDK with only the platform's audited in-process MCP tools; OpenAI uses the shared Chat Completions tool loop. The durable setting selects runtime, provider, model, turn cap, and custom pricing; environment values are bootstrap fallback only. Every invocation snapshots configuration, usage, and cost. Embeddings: self-hosted local model.
- Auth: data-driven OIDC providers with exact workspace bindings and bounded server-managed browser sessions.
- Infra: Kubernetes via Helm and Argo CD, with PostgreSQL, pgvector, and Valkey. Local development uses Docker Compose.
- Surfaces: Slack, React dashboard (WebSocket).

## Repo layout

Bun-workspaces monorepo. This table is generated from the workspace tree by `bun run docs:gen`;
edit `scripts/docs/notes.ts`, never the block below.

<!-- BEGIN generated:workspaces -->
<!-- Generated by scripts/docs/gen.ts. Run `bun run docs:gen`. Do not edit. -->

| Workspace | Responsibility |
| --- | --- |
| `apps/api` | Hono control plane: managed Slack Socket Mode, tenant/connector/surface config, queue producer, WebSocket hub. |
| `apps/dashboard` | React + Vite responder dashboard. |
| `apps/dev-tunnels` | Local-development supervisor for loopback-only `kubectl port-forward` tunnels to Prometheus and Grafana. |
| `apps/surface-worker` | Consumes the hub fan-out stream and posts to external surfaces. `surface_deliveries` is the durable outbox; every post threads under the incident binding. |
| `apps/triage-worker` | Queue consumer and Triage Engine host (Claude / OpenAI). |
| `packages/agent-tools` | Triage tool implementations and the per-engine binding layer. |
| `packages/alerts` | `openIncidentWorkspace`, the sole atomic incident opener, plus the Slack `routeToIncident` adapter and platform subject identity. |
| `packages/connectors` | Compile-time connector catalog, provider modules, stable connector ports, and registries. |
| `packages/contracts` | Shared client/server wire contracts (WebSocket ingress cap and error-frame shape). Pure TypeScript, no runtime dependencies. |
| `packages/db` | Drizzle schema (tables, indexes, RLS policies), generated migrations, role/grant/FORCE-RLS bootstrap, `SecretStore`, `Embedder`. |
| `packages/hub` | Canonical per-incident conversation: Postgres log plus Valkey pub/sub. |
| `packages/notifications` | Durable recipient inbox, lifecycle templates, and optional best-effort SMTP delivery. |
| `packages/platform-settings` | Typed platform-global settings backed by Postgres with bounded Valkey caching. |
| `packages/queue` | Valkey Streams work queue with Postgres as the durable source of truth, plus the reconciler. |
| `packages/slo` | Error-budget read model: objective evaluation, budget and burn computation, and status views. |
| `packages/surfaces` | Slack API clients and the outbound surface registry. |
| `packages/topology` | Service-graph queries, including the blast-radius CTE. |
<!-- END generated:workspaces -->

`docs/` is the MkDocs user and operator guide. Delivery work lives in project issues and
milestones.

## Required commands

- `bun install`; `bun run dev:setup` (start docker compose, wait for health, apply migrations), then `bun run dev` (Turbo runs every app's watcher); `bun run dev:infra` starts infrastructure without migrating; `bun run db:generate` / `db:check` / `db:migrate` / `db:reset`; `bun run typecheck` / `build` (Turbo, per-package + cached); `bun run test` (one root Vitest invocation over both projects, see below), and `bun run test:ci:backend` / `test:ci:ui`, which is what CI runs, one lane each: the same Vitest projects forced onto real Node, then failing unless the files the lane ran are exactly the files on disk for that lane; `bun run lint` (oxlint + prettier); `bun run docs:install` / `docs:serve` / `docs:build` (uv-managed MkDocs); `bun run ci:container` (production image build + smoke). Both CI providers call `scripts/ci/*.sh`; provider YAML owns only triggers, services, caches, permissions, and publishing integration.
- `bun scripts/docs/screenshots/capture.ts` (`bun run docs:screenshots`) regenerates every dashboard screenshot under `docs/assets/screenshots/`, including a per-step walk of each connect wizard. The walk always stops before Save and verify, so it never submits a form or reaches a third-party system; a step that cannot be driven fails the run rather than writing the previous step's image under the next step's name. It needs a Docker daemon and a Chromium from `bunx playwright install chromium`. It boots its **own** throwaway Postgres and Valkey on random ports, seeds a demo tenant through the real schema and the real `openIncidentWorkspace`, and refuses to start if the throwaway URL matches an inherited `DATABASE_URL`, so it can never touch the development database. Run it directly rather than through `bun run`: the script wrapper buffers child stdout and you see no progress.
- `bun run db:check` (`drizzle-kit check`) validates migration-history consistency and is a blocking CI gate. It reads the journal only, so it needs no database.
- `bun run test` needs a Docker daemon but **not** `dev:infra`: the `backend` project's `vitest.global-setup` always boots ephemeral Postgres (+pgvector) and Valkey via Testcontainers, replaces any `.env` URLs, migrates once, and tears them down. Tests must never target shared or development infrastructure. The `ui` project declares no `globalSetup` and starts nothing, so `test:ci:ui` runs without a Docker daemon; a second project declaring `globalSetup` would boot the stack and migrate twice.
- Migration history was squashed to a single baseline (`0000_damp_the_professor`); ordinary migrations have accumulated on top of it since. Drizzle applies any migration newer than the latest row in `__drizzle_migrations`, so a database that ran the pre-baseline migrations will try to replay the baseline and abort on an existing table. Testcontainers is always fresh, so CI cannot catch this — reset a long-lived local DB with `bun run db:reset`.
- Turbo owns `typecheck`, `build`, `dev` (per-package task graph + cache). `test` and `lint` stay single root invocations on purpose: the `backend` project's test files share one Postgres after a single global migration and run serially, so separate per-package invocations would race, and oxlint over the whole tree is already sub-second. The two Vitest projects split that run by directory, not by package.

## Linting

Dashboard changes must follow `apps/dashboard/AGENTS.md` and `docs/build/design-system.md`.
`bun run check:design-system` checks tokens and static style policy; the same tests run in the
required UI lane. Shared visual changes require the full isolated screenshot capture.

oxlint + prettier. Public package entrypoint functions also pass the JSDoc contract gate: concise
summary, described parameters, and no duplicated TypeScript types. Husky pre-commit runs staged
lint, public JSDoc validation, and formatting checks. TypeScript strict, no implicit `any`.

## Quality gates (CI must enforce — GitHub **and** GitLab)

- The gate list is generated by `bun run docs:gen`: commands from `scripts/ci/*.sh`, descriptions from `scripts/docs/notes.ts`. Edit those, never the block below.

<!-- BEGIN generated:ci-gates -->
<!-- Generated by scripts/docs/gen.ts. Run `bun run docs:gen`. Do not edit. -->

| Gate | What it protects |
| --- | --- |
| `bun run typecheck --concurrency=2` | TypeScript strict, per package, Turbo-cached with bounded CI memory use. |
| `bun run typecheck:scripts` | TypeScript strict over the repository scripts, which sit outside the workspace task graph. |
| `bun run lint` | oxlint, the public JSDoc contract gate, and `prettier --check`. |
| `bun run docs:gen --check` | Every generated documentation block matches the source it is derived from. |
| `bun run docs:lint` | Documentation prose rules: no em dashes, no tracker or decision-record references, no source paths. |
| `bun run check:live-test-scripts` | Bundles manually invoked live-test entrypoints so stale imports fail before operators need them. |
| `bun run db:check` | Drizzle migration-history consistency. Reads the journal, needs no database. |
| `bun run check:connector-architecture` | Connector module boundaries and the production module size cap. |
| `bun run check:test-layout` | Every test sits in a `__tests__` directory beside its source area. |
| `bun run test:slack-socket-compat` | Slack Socket Mode heartbeat compatibility, run under Bun. |
| `bun run test:ci:backend` | Every suite outside the dashboard, over ephemeral Testcontainers Postgres and Valkey, pinned to the real Node the pipeline installs rather than whichever runtime resolves first. The only lane that starts a container stack, so a second lane copying it would boot and migrate twice. Fails unless the files it ran are exactly the files on disk for the lane. Includes the RLS isolation tests, which block merge. |
| `bun run test:ci:ui` | The dashboard suites, on the real Node the pipeline installs. The lane reaches no Postgres and no Valkey and starts no container, and the same file-set check enforces that boundary from both sides. |
| `bun run build` | Every workspace builds. |
| `uv lock --check` | The documentation Python lockfile matches `pyproject.toml`. |
| `uv run --locked --group docs mkdocs build --strict` | Strict documentation build: broken links, stale navigation, or a missing snippet fail here. |
| `bun run ci:container` | Production image builds and passes its smoke test. |
<!-- END generated:ci-gates -->

- **RLS isolation tests are required and block merge.**
- `.github/workflows/ci.yml` and `.gitlab-ci.yml` invoke the same six lane scripts, one job each, plus `docs.sh` and the container smoke. `bun run ci:verify` runs the same lanes serially and is the only way to reproduce CI locally; no provider invokes it. `docs.sh` also backs a GitHub Pages deploy (`.github/workflows/docs-deploy.yml`, on push to main): that is a publishing step, not a gate, so it is deliberately GitHub-only. GitLab runs `docs.sh` as a gate only and publishes no site, because the published copy is single-sourced. release-please owns the versioned Docker Hub images and moves Docker Hub `latest`; the internal pipeline owns its own registry's `dev` and `latest` tags.
- Docs updated with the change (mkdocs); notable decisions explained in the merge request.

## Anti-patterns to refuse

- Querying domain tables without tenant scoping or bypassing RLS.
- Re-introducing SQS, or any cross-provider LLM fallback.
- Talking to Slack from the engine instead of through the hub.
- Storing secrets in plaintext; committing the master key or any `.env`.
- Adding an architecture decision record or an `architecture/` directory; explain notable decisions in the merge request instead.
- Citing an issue or merge request number in a comment, a test name, a document, or a commit message. The tracker is private and its numbers rot; state the reason itself, so the claim survives without the ticket.
- Adding a new datastore (Neo4j, etc.) or a third-party secrets service without explicit review and sign-off.
- Calling a third-party embeddings API (embeddings are local and global).
- Minting an Incident from a computed metric (an error-budget burn, an anomaly score) instead of a conversation.
- Showing a reliability figure with no SLI query behind it, or storing SLI samples to compute one.
- Adding a drop path that records nothing. Every classifier outcome, `not_worthy` included, lands on the inbound receipt via `onOutcome`; a path that skips it is a regression, not a precedent.
- Recording a `ticket`/`log` signal from `candidate.raw` rather than the scrubbed text, or with no retention bound.
- Spending a full engine run on a signal whose disposition should have been `ticket` or `log`.
- Naming an individual as a cause in any generated postmortem, runbook or summary.
- A fifth golden signal, an SLO per endpoint, or a fixed enum of incident cause tags. [Ch 4 "as few SLOs as possible"; Ch 16 free-form tags]
