// The single decoder of a deploy-shaped NormalizedSnapshot's metadata. Both the API route and
// the poller's persist path used to carry byte-identical `metaStr` helpers with SILENTLY divergent
// fallbacks (persist wrote status '', the route wrote 'pending'). One decoder, one fallback contract:
// - status → coerced onto the DeployStatus union; unknown/absent → 'pending', never ''
//   - deployedAt → isoOrNull(metadata.deployedAt) ?? isoOrNull(observedAt) ?? now, always a valid ISO
//   - url     → present only when the connector carries a non-empty string
// Consumers adapt the canonical output to their own shape (Date vs ISO string, null vs '' ref).
import type { NormalizedSnapshot } from './types';

// the closed vocabulary of deploy outcomes the dashboard can render. This is the SERVER-SIDE
// source of truth; the dashboard's DeployStatus union (apps/dashboard/src/lib/types.ts) must mirror it.
export const DEPLOY_STATUSES = [
  'success',
  'failed',
  'running',
  'pending',
  'blocked',
  'error',
  'failure',
  'inactive',
  'canceled',
] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

// connector `status` is free text (GitHub 'failure', GitLab 'canceled'/'created',...). Map the
// known vocabularies onto the union so an out-of-union value never reaches the dashboard, where the
// STATUS_BADGE lookup would be undefined. Anything unrecognised or absent degrades to 'pending' (a
// deploy we know exists but whose outcome we cannot render), never '' or a raw connector token.
const STATUS_ALIASES: Record<string, DeployStatus> = {
  success: 'success',
  failed: 'failed',
  failure: 'failure',
  error: 'error',
  inactive: 'inactive',
  // GitHub Actions terminal-failure conclusions: a timed-out or startup-failed run has COMPLETED as a
  // failure, so it is 'failed', not 'pending'. ('action_required' stays 'pending' — genuinely awaiting a human.)
  timed_out: 'failed',
  startup_failure: 'failed',
  running: 'running',
  in_progress: 'running',
  pending: 'pending',
  created: 'pending',
  queued: 'pending',
  manual: 'pending',
  scheduled: 'pending',
  waiting_for_resource: 'pending',
  blocked: 'blocked',
  canceled: 'canceled',
  cancelled: 'canceled',
};

/**
 * Maps a provider status token onto the stable contract, treating missing or unknown values as pending.
 *
 * @param raw - Provider status token, if one was reported.
 */
export function coerceDeployStatus(raw?: string): DeployStatus {
  if (!raw) return 'pending';
  return STATUS_ALIASES[raw.toLowerCase()] ?? 'pending';
}

/** A metadata string field, undefined when empty/absent. */
function metaStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** A valid ISO timestamp from a possibly-malformed value, else undefined — avoids a `toISOString`
 *  RangeError on non-ISO connector data (these values flow in from a tenant's own external API). */
function isoOrNull(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : '';
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Canonical decoded deploy. `sha` is undefined for a non-deploy snapshot (the persist path skips it). */
export interface DecodedDeploy {
  source: string;
  providerId: string | null;
  repo: string;
  ref: string | null;
  environment: string | null;
  transientEnvironment: boolean;
  actor: string | null;
  sha: string | undefined;
  revisions: string[];
  operationPhase: string | null;
  service: string | null;
  /** Coerced onto the DeployStatus union; never a raw connector token. */
  status: DeployStatus;
  /** Always a valid ISO string. */
  deployedAt: string;
  providerCreatedAt: string | null;
  providerUpdatedAt: string | null;
  url?: string;
}

/**
 * Decodes bounded deployment metadata from a normalized connector snapshot.
 *
 * @param snapshot - Snapshot containing provider deployment metadata.
 */
export function decodeDeploySnapshot(snapshot: NormalizedSnapshot): DecodedDeploy {
  const m = snapshot.metadata;
  const url = metaStr(m.url);
  return {
    source: snapshot.source,
    providerId: metaStr(m.providerId) ?? null,
    repo: metaStr(m.repo) ?? '',
    ref: metaStr(m.ref) ?? null,
    environment: metaStr(m.environment) ?? null,
    transientEnvironment: m.transientEnvironment === true,
    actor: metaStr(m.actor) ?? null,
    sha: metaStr(m.sha),
    revisions: Array.isArray(m.revisions)
      ? m.revisions.filter(
          (revision): revision is string => typeof revision === 'string' && revision.length > 0,
        )
      : [],
    operationPhase: metaStr(m.operationPhase) ?? null,
    service: metaStr(m.service) ?? null,
    status: coerceDeployStatus(metaStr(m.status)),
    deployedAt:
      isoOrNull(m.deployedAt) ?? isoOrNull(snapshot.observedAt) ?? new Date().toISOString(),
    providerCreatedAt: isoOrNull(m.providerCreatedAt) ?? null,
    providerUpdatedAt: isoOrNull(m.providerUpdatedAt) ?? null,
    ...(url ? { url } : {}),
  };
}
