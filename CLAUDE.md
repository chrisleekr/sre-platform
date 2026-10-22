# CLAUDE.md

Rules for agents changing this repository. Everything else lives elsewhere:

- Domain language: [CONTEXT.md](CONTEXT.md)
- Workspace layout, setup and the CI gate list: [docs/build/index.md](docs/build/index.md)
- Workflow, commits, dependency policy and tests: [CONTRIBUTING.md](CONTRIBUTING.md)
- SRE doctrine and what is built today: [docs/understand/philosophy.md](docs/understand/philosophy.md)
- Dashboard work: [apps/dashboard/AGENTS.md](apps/dashboard/AGENTS.md)

## How to work

- Confirm the design before writing code. Name the simplest option that keeps the invariants below,
  and cite official docs or release notes for any version or API claim.
- Preserve upgrade paths for existing installations and stored data. Make breaking changes explicit
  and migrate durable state deliberately.
- Push back when a request would break an invariant. Ask instead of guessing.

## Invariants

- **Tenant isolation is absolute.** Every domain table carries `tenant_id` and Postgres RLS enforces
  it. A verified `(issuer, subject)` identifies the user and exactly one membership selects the
  tenant per request. RLS isolation tests block merge.
- **Postgres is the durable source of truth.** Write each unit of work to Postgres before its Valkey
  Stream entry. Consumers and the reconciler are idempotent. No SQS.
- **One LLM provider per deployment.** Claude or OpenAI by config, never a cross-provider fallback.
  Resilience is degrade-and-redeliver.
- **The Conversation Hub owns triage dialogue.** The engine reads and writes only the hub. Slack and
  the dashboard are thin adapters.
- **One incident opener.** `openIncidentWorkspace` is the only ingress. Only
  `packages/alerts/src/open-incident-workspace.ts` and `packages/db/src/incident-repo/create.ts` may
  call `createIncident`, enforced by `packages/alerts/src/__tests__/ingress-invariant.test.ts`.
- **Inbound is always a conversation.** A signal enters only as a message a human can see and reply
  to. Never mint an Incident from a computed metric such as a budget burn or an anomaly score.
- **Secrets stay encrypted.** Connector credentials are AES-256-GCM encrypted in Postgres under RLS
  and decrypted only at point of use. Never commit the master key or any `.env`.
- **No new datastore.** Postgres (with pgvector) and Valkey only. Anything else, including a
  third-party secrets service, needs sign-off on the merge request.
- **Embeddings are local.** Never call a third-party embeddings API.

## Doctrine rules for new code

The reasoning and current status of each lives in the philosophy page.

- Every reliability figure resolves to an SLI query a human can re-run. Store SLO definitions and
  burn events, never SLI samples.
- Every classifier outcome, `not_worthy` included, is recorded through `onOutcome`. `investigate` is
  never the default. Retain `ticket` and `log` signals from the candidate text, never `candidate.raw`,
  and always with a retention bound.
- No generated postmortem, runbook or summary names a person as a cause.
- No fifth golden signal, no SLO per endpoint, no fixed enum of cause tags.

## Stack

Bun, Hono, React with Vite and Tailwind, strict TypeScript. PostgreSQL with pgvector through Drizzle,
where drizzle-kit owns all schema DDL including RLS policies. Valkey for streams, pub/sub and cache.
Kubernetes via Helm and Argo CD. Docker Compose for local development.

## Commands

- `bun run dev:setup` then `bun run dev` for local development.
- `bun run typecheck`, `bun run lint`, `bun run test`. Tests need a Docker daemon: the backend
  project boots its own Postgres and Valkey through Testcontainers. Never point tests at shared or
  development infrastructure.
- `bun run docs:gen` after changing workspaces or CI scripts. Edit `scripts/docs/notes.ts`, never a
  generated block.
- `bun run ci:verify` reproduces every CI lane locally.
- A long-lived local database that predates the squashed baseline migration needs
  `bun run db:reset`.

## Never

- Bypass RLS or query a domain table without tenant scoping.
- Talk to Slack from the engine instead of through the hub.
- Add an architecture decision record or an `architecture/` directory. Explain notable decisions in
  the merge request.
- Cite an issue or merge request number in code, tests, docs or commit messages. State the reason
  itself.
