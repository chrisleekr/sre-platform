// Judgement the source cannot express, keyed by the identity the generator discovers.
//
// `gen.ts` derives *what exists* (workspaces on disk, commands in scripts/ci/*.sh, tools returned by
// a connector factory, panels in the dashboard menu). It cannot derive *what a thing is for*. Those
// sentences live here, keyed so that a new workspace with no note — or a note for a workspace that
// no longer exists — fails the build instead of shipping a half-documented table.

/** One line per Bun workspace, keyed by its path relative to the repo root. */
export const WORKSPACE_NOTES: Record<string, string> = {
  'apps/api':
    'Hono control plane: managed Slack Socket Mode, tenant/connector/surface config, queue producer, WebSocket hub.',
  'apps/dashboard': 'React + Vite responder dashboard.',
  'apps/dev-tunnels':
    'Local-development supervisor for loopback-only `kubectl port-forward` tunnels to Prometheus and Grafana.',
  'apps/surface-worker':
    'Consumes the hub fan-out stream and posts to external surfaces. `surface_deliveries` is the durable outbox; every post threads under the incident binding.',
  'apps/triage-worker': 'Queue consumer and Triage Engine host (Claude / OpenAI).',
  'packages/agent-tools': 'Triage tool implementations and the per-engine binding layer.',
  'packages/alerts':
    '`openIncidentWorkspace`, the sole atomic incident opener, plus the Slack `routeToIncident` adapter and platform subject identity.',
  'packages/connectors':
    'Compile-time connector catalog, provider modules, stable connector ports, and registries.',
  'packages/contracts':
    'Shared client/server wire contracts (WebSocket ingress cap and error-frame shape). Pure TypeScript, no runtime dependencies.',
  'packages/db':
    'Drizzle schema (tables, indexes, RLS policies), generated migrations, role/grant/FORCE-RLS bootstrap, `SecretStore`, `Embedder`.',
  'packages/hub': 'Canonical per-incident conversation: Postgres log plus Valkey pub/sub.',
  'packages/notifications':
    'Durable recipient inbox, lifecycle templates, and optional best-effort SMTP delivery.',
  'packages/platform-settings':
    'Typed platform-global settings backed by Postgres with bounded Valkey caching.',
  'packages/queue':
    'Valkey Streams work queue with Postgres as the durable source of truth, plus the reconciler.',
  'packages/slo':
    'Error-budget read model: objective evaluation, budget and burn computation, and status views.',
  'packages/surfaces': 'Slack API clients and the outbound surface registry.',
  'packages/topology': 'Service-graph queries, including the blast-radius CTE.',
};

/** One line per CI gate, keyed by the exact command the script runs. */
export const CI_GATE_NOTES: Record<string, string> = {
  'bun run typecheck --concurrency=2':
    'TypeScript strict, per package, Turbo-cached with bounded CI memory use.',
  'bun run typecheck:scripts':
    'TypeScript strict over the repository scripts, which sit outside the workspace task graph.',
  'bun run lint': 'oxlint, the public JSDoc contract gate, and `prettier --check`.',
  'bun run db:check':
    'Drizzle migration-history consistency. Reads the journal, needs no database.',
  'bun run check:connector-architecture':
    'Connector module boundaries and the production module size cap.',
  'bun run check:live-test-scripts':
    'Bundles manually invoked live-test entrypoints so stale imports fail before operators need them.',
  'bun run check:test-layout': 'Every test sits in a `__tests__` directory beside its source area.',
  'bun run test:slack-socket-compat': 'Slack Socket Mode heartbeat compatibility, run under Bun.',
  'bun run test:ci:backend':
    'Every suite outside the dashboard, over ephemeral Testcontainers Postgres and Valkey, pinned to the real Node the pipeline installs rather than whichever runtime resolves first. The only lane that starts a container stack, so a second lane copying it would boot and migrate twice. Fails unless the files it ran are exactly the files on disk for the lane. Includes the RLS isolation tests, which block merge.',
  'bun run test:ci:ui':
    'The dashboard suites, on the real Node the pipeline installs. The lane reaches no Postgres and no Valkey and starts no container, and the same file-set check enforces that boundary from both sides.',
  'bun run build': 'Every workspace builds.',
  'uv lock --check': 'The documentation Python lockfile matches `pyproject.toml`.',
  'uv run --locked --group docs mkdocs build --strict':
    'Strict documentation build: broken links, stale navigation, or a missing snippet fail here.',
  'bun run docs:gen --check':
    'Every generated documentation block matches the source it is derived from.',
  'bun run docs:lint':
    'Documentation prose rules: no em dashes, no tracker or decision-record references, no source paths.',
  'bun run ci:container': 'Production image builds and passes its smoke test.',
};

/**
 * One row per dashboard menu entry, keyed by the panel's route path.
 *
 * `page` is the guide page relative to `docs/dashboard/`, where the generated table is included;
 * `answers` is the question a responder opens that page to answer. Labels and grouping come from
 * the dashboard's own panel list, so only the judgement lives here.
 */
export const DASHBOARD_PANEL_NOTES: Record<string, { page: string; answers: string }> = {
  '/w': { page: 'overview.md', answers: 'What needs me right now?' },
  '/w/incidents': { page: 'incidents.md', answers: 'Show me every case, filtered how I want.' },
  '/w/signals': {
    page: 'signals.md',
    answers: 'What came in, and was each signal routed to an investigation, a ticket, or the log?',
  },
  '/w/infrastructure': {
    page: 'infrastructure.md',
    answers: 'Which pods and nodes are unhealthy?',
  },
  '/w/deployments': { page: 'deployments.md', answers: 'What shipped, and did it succeed?' },
  '/w/changes': { page: 'changes.md', answers: 'What changed in source control?' },
  '/w/topology': { page: 'topology.md', answers: 'If this breaks, what else breaks?' },
  '/w/reliability': {
    page: 'reliability.md',
    answers: 'Is this period better or worse than the last one, and which causes recur?',
  },
  '/w/error-budgets': {
    page: 'error-budgets.md',
    answers: 'How much unreliability does each service have left, and how fast is it spending it?',
  },
  '/w/connectors': { page: 'connectors.md', answers: 'Which of my systems can it read?' },
  '/w/surfaces': {
    page: 'inbound.md',
    answers: 'Which Slack channels does it listen to, and what did it do with them?',
  },
  '/w/usage': { page: 'usage.md', answers: 'What has the model cost me?' },
  '/w/settings': {
    page: 'settings.md',
    answers: 'What is the workspace called, how do people sign in, and who belongs to it?',
  },
};

/**
 * Connector configurations to enumerate tools under.
 *
 * A connector whose tool surface does not branch on settings needs no entry: it is enumerated once,
 * under an empty config. Two connectors do branch, and an empty config would silently pick the
 * wrong side of the branch:
 *
 * - `makeGitLabTools` registers a group catalog tool set only when the data source carries
 *   `groupId` or `groupPath`. Both shapes are reachable, so both are listed.
 * - `makeArgoCdConnector` falls back to a single-project connector unless `settings.projects` is an
 *   array. That fallback is unreachable for a saved data source: `parseArgoCdSettings` rejects a
 *   missing or empty `projects`, so `save.ts` returns `400`. Only the multi-project shape is
 *   listed, because it is the only one an operator can create.
 */
export const CONNECTOR_SHAPES: Record<
  string,
  { label: string; settings: Record<string, unknown> }[]
> = {
  gitlab: [
    { label: 'Project-scoped data source', settings: {} },
    { label: 'Group-scoped data source', settings: { groupPath: 'example-group' } },
  ],
  argocd: [
    {
      label: '',
      settings: { projects: [{ project: 'example', applications: [{ name: 'example-app' }] }] },
    },
  ],
};

/**
 * Connectors that have a factory but legitimately expose no triage tools.
 *
 * A factory-less catalog entry such as `confluence` never reaches the check and does not belong
 * here. Every other connector must enumerate at least one tool, so a refactor that breaks one
 * connector's enumeration fails the build instead of publishing an empty table.
 */
export const TOOLLESS_CONNECTORS = new Set(['aws']);

/**
 * Lower bound on the total tool count across every connector.
 *
 * Complements the per-connector zero check rather than replacing it. The per-connector check fires
 * only at exactly zero, so it cannot see a connector that drops from 14 tools to 1; this floor can.
 * Conversely the floor alone is too coarse to notice one connector vanishing, since the real total
 * is 82 and GitLab alone is 21. Both are needed.
 */
export const MIN_TOTAL_CONNECTOR_TOOLS = 70;

/** One row per platform setting, keyed by the setting key the code declares. */
export const PLATFORM_SETTING_NOTES: Record<
  string,
  { bounds: string; fallback: string; effect: string }
> = {
  MAX_TOKEN_LIFETIME_SEC: {
    bounds: '300–2592000',
    fallback: '`86400`',
    effect:
      'Maximum accepted legacy API bearer-token lifetime in seconds, separate from browser sessions.',
  },
  SESSION_IDLE_SECONDS: {
    bounds: '300–604800',
    fallback: '`86400`',
    effect:
      'Browser idle lifetime in seconds. Valid activity renews idle expiry without changing authentication time or absolute expiry.',
  },
  SESSION_ABSOLUTE_SECONDS: {
    bounds: '300–2592000',
    fallback: '`604800`',
    effect:
      'Absolute browser session lifetime from directory authentication. Applies when a session is created.',
  },
  CLASSIFY_FAIRNESS_WINDOW_SEC: {
    bounds: 'positive integer',
    fallback: '`3600`',
    effect: 'Window used to pick the least-recently-served tenant on the classify stream.',
  },
  INCIDENT_AUTO_ARCHIVE_DAYS: {
    bounds: '0–3650',
    fallback: '`7`',
    effect:
      'Age at which an inactive terminal incident is deleted. `0` disables automatic deletion.',
  },
  RECOVERY_MAX_CHECKS: {
    bounds: '1–10',
    fallback: '`3`',
    effect: 'Recovery verification attempts before the platform stops rechecking.',
  },
  EVIDENCE_ROW_LIMIT: {
    bounds: '289–10000',
    fallback: '`1000`',
    effect:
      'Newest-first ceiling on past tool results one investigation reads back. Bounds the database read, not what the investigator sees.',
  },
  EVIDENCE_BUDGET_CHARS: {
    bounds: '83–200000',
    fallback: '`24000`',
    effect:
      'Size cap on the prior evidence a continued investigation carries, spent newest first. This decides what the investigator sees.',
  },
  AUTO_INVESTIGATION_TENANT_LIMIT_24H: {
    bounds: 'non-negative integer',
    fallback: '`0`',
    effect: 'Rolling 24-hour cap on automatic investigations per tenant. `0` is unlimited.',
  },
  AUTO_INVESTIGATION_MONITOR_LIMIT_24H: {
    bounds: 'non-negative integer',
    fallback: '`0`',
    effect: 'Rolling 24-hour cap on automatic investigations per monitor. `0` is unlimited.',
  },
  AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H: {
    bounds: 'non-negative',
    fallback: '`0`',
    effect: 'Rolling 24-hour configured-cost cap per tenant, in USD. `0` is unlimited.',
  },
  AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H: {
    bounds: 'non-negative',
    fallback: '`0`',
    effect: 'Rolling 24-hour configured-cost cap per monitor, in USD. `0` is unlimited.',
  },
  REGISTRATION_MODE: {
    bounds: '`approval_required`, `open`, or `closed`',
    fallback: '`approval_required`',
    effect:
      'Controls whether workspace registration waits for platform approval, starts immediately, or is closed.',
  },
  PRODUCT_NAME: {
    bounds: '1–80 characters',
    fallback: '`PRODUCT_NAME` or `SRE Platform`',
    effect: 'Names the product on public onboarding surfaces.',
  },
  PRODUCT_VALUE_LINE: {
    bounds: '1–180 characters',
    fallback: '`PRODUCT_VALUE_LINE` or the built-in evidence-focused value line',
    effect: 'Explains the product on the public landing page.',
  },
  TERMS_URL: {
    bounds: 'HTTP(S) URL or disabled',
    fallback: '`TERMS_URL`',
    effect: 'Links the terms accepted during workspace registration.',
  },
  PRIVACY_URL: {
    bounds: 'HTTP(S) URL or disabled',
    fallback: '`PRIVACY_URL`',
    effect: 'Links the public privacy notice.',
  },
  SUPPORT_URL: {
    bounds: 'HTTP(S) URL or disabled',
    fallback: '`SUPPORT_URL`',
    effect: 'Links public and access-error screens to support.',
  },
  LLM_RUNTIME: {
    bounds: 'runtime / provider / model selection',
    fallback: 'the environment bootstrap value',
    effect:
      'Selects the active Triage Engine runtime, provider, model, turn cap, and custom pricing.',
  },
  SMTP: {
    bounds: 'validated host, port, sender, TLS mode, and optional username; or disabled',
    fallback: '`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, and `SMTP_USERNAME`',
    effect: 'Adds a plain-text email copy after the durable in-app notification is written.',
  },
};
