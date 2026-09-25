import { isPlatformSubjectIdentityPart } from '@sre/alerts';
import {
  INVESTIGATION_EVIDENCE_KINDS,
  INVESTIGATION_GAP_CATEGORIES,
  type InvestigationGap,
} from '@sre/contracts';
import type { AutomaticInvestigationBudgetLimits } from '@sre/contracts';
import {
  getIncidentDetail,
  incidentMessages,
  INCIDENT_SEVERITY_RANKS,
  type Db,
  type EvidencePageCursor,
  type IncidentPageCursor,
  type IncidentSort,
  type IncidentStatus,
  type Tx,
} from '@sre/db';
import type { ConversationHub } from '@sre/hub';
import type { makeSlackDisplayResolver } from '@sre/surfaces';
import type { SnapshotCache } from '@sre/queue';
import type { IDataSourceConnector } from '@sre/connectors';
import { type Queue } from '@sre/queue';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type ResumeProducer } from '../approval-decision';
import { type AuthDeps } from '../auth';
import { type ObservationSubject } from '../incident-observations';
import { type Logger } from '../logger';

export interface IncidentRouteDeps {
  auth: AuthDeps;
  /** RLS-scoped (app_user) connection. */
  db: Db;
  /** Dedicated queue for runbook-generation jobs. */
  runbookQueue?: Queue;
  /** Triage-stream queue for incidents declared from platform observations. */
  declarationQueue?: Queue;
  cache: SnapshotCache;
  /**
   * The decide route needs three collaborators the list/runbook routes don't: a
   * system connection for the by-PK approval lookup, the hub to append the 'decided' reply, and a
   * resume-capable queue on the triage stream. Optional so suites exercising only list/runbook omit
   * them; the decide route returns 503 when any is absent.
   */
  adminDb?: Db;
  hub?: ConversationHub;
  resolveSlackDisplay?: ReturnType<typeof makeSlackDisplayResolver>;
  resumeQueue?: ResumeProducer;
  /** Resolve Slack-owned thread URLs at request time without exposing the stored bot token. */
  resolveSlackPermalink?: (
    tenantId: string,
    channel: string,
    threadId: string,
  ) => Promise<string | null>;
  /** Resolves enabled connector instances for entity coverage without making provider calls. */
  resolveConnectors?: (tenantId: string) => Promise<IDataSourceConnector[]>;
  /** Reads the platform-wide policy used to calculate the incident's current rolling budget. */
  getAutomaticInvestigationBudget?: () => Promise<AutomaticInvestigationBudgetLimits>;
  log?: Logger;
}

export const SUBJECT_KEYS: Record<ObservationSubject['kind'], readonly string[]> = {
  infrastructure_resource: ['kind', 'dataSourceId', 'entityId'],
  deployment: ['kind', 'deploymentId'],
  connector_verification: ['kind', 'connectorId'],
  topology_service: ['kind', 'service', 'subjectKey'],
};

export const MAX_DECLARATION_BODY_BYTES = 16 * 1024;
export const MAX_MANUAL_DECLARATION_BODY_BYTES = 32 * 1024;
export const MAX_ACTIVE_LOOKUP_BODY_BYTES = 384 * 1024;
export const MAX_FEEDBACK_BODY_BYTES = 8 * 1024;
export const MAX_ENTITY_MAPPING_BODY_BYTES = 16 * 1024;
export const MAX_RELATIONSHIP_BODY_BYTES = 64 * 1024;
// Allow six-byte JSON escapes for every bounded issue field plus envelope overhead.
export const MAX_ISSUE_BODY_BYTES = 160 * 1024;
export const MAX_POSTMORTEM_BODY_BYTES = 256 * 1024;
export const MANUAL_SEVERITIES = new Set(['sev1', 'sev2', 'sev3']);
export const DEFAULT_MANUAL_INCIDENTS_PER_MINUTE = 5;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ManualIncidentRequest {
  requestId: string;
  title: string;
  description: string;
  service: string;
  severity: 'sev1' | 'sev2' | 'sev3';
}

export class ManualIncidentRateLimitError extends Error {}

export function manualIncidentsPerMinute(): number {
  const configured = Number(process.env.MANUAL_INCIDENT_RATE_LIMIT_PER_MINUTE);
  return Number.isInteger(configured) && configured > 0 && configured <= 100
    ? configured
    : DEFAULT_MANUAL_INCIDENTS_PER_MINUTE;
}

export async function enforceManualIncidentAdmission(
  tx: Tx,
  tenantId: string,
  userId: string | null,
): Promise<void> {
  const actor = userId ?? 'unattributed';
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`manual-incident:${tenantId}:${actor}`}, 0))`,
  );
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(incidentMessages)
    .where(
      and(
        eq(incidentMessages.tenantId, tenantId),
        userId ? eq(incidentMessages.authorUserId, userId) : isNull(incidentMessages.authorUserId),
        eq(incidentMessages.originSurface, 'dashboard'),
        sql`${incidentMessages.originMessageId} like 'dashboard:manual:%'`,
        sql`${incidentMessages.createdAt} >= statement_timestamp() - interval '1 minute'`,
      ),
    );
  if ((rows[0]?.count ?? 0) >= manualIncidentsPerMinute())
    throw new ManualIncidentRateLimitError('manual incident rate limit exceeded');
}

export function parseManualIncidentRequest(value: unknown): ManualIncidentRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set(['requestId', 'title', 'description', 'service', 'severity']);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (typeof record.requestId !== 'string' || !UUID_RE.test(record.requestId)) return null;
  if (typeof record.title !== 'string' || typeof record.description !== 'string') return null;
  if (typeof record.service !== 'string' || typeof record.severity !== 'string') return null;
  const title = record.title.trim();
  const description = record.description.trim();
  const service = record.service.trim();
  if (!title || title.length > 300) return null;
  if (!description || description.length > 4_000) return null;
  if (!service || service.length > 200) return null;
  if (!MANUAL_SEVERITIES.has(record.severity)) return null;
  return {
    requestId: record.requestId,
    title,
    description,
    service,
    severity: record.severity as ManualIncidentRequest['severity'],
  };
}

export function parseObservationSubject(value: unknown): ObservationSubject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== 'string' || !(kind in SUBJECT_KEYS)) return null;
  const keys = SUBJECT_KEYS[kind as ObservationSubject['kind']];
  if (Object.keys(record).some((key) => !keys.includes(key))) return null;
  const boundedIdentifier = (name: string, uuid = false): string | null => {
    const item = record[name];
    if (typeof item !== 'string' || !isPlatformSubjectIdentityPart(item)) return null;
    if (uuid && !UUID_RE.test(item)) return null;
    return item;
  };
  if (kind === 'infrastructure_resource') {
    const dataSourceId = boundedIdentifier('dataSourceId', true);
    const entityId = boundedIdentifier('entityId');
    return dataSourceId && entityId ? { kind, dataSourceId, entityId } : null;
  }
  if (kind === 'deployment') {
    const deploymentId = boundedIdentifier('deploymentId', true);
    return deploymentId ? { kind, deploymentId } : null;
  }
  if (kind === 'connector_verification') {
    const connectorId = boundedIdentifier('connectorId', true);
    return connectorId ? { kind, connectorId } : null;
  }
  const service = boundedIdentifier('service');
  const key = record.subjectKey;
  if (
    key !== undefined &&
    (typeof key !== 'string' ||
      !key.length ||
      key.length > 8192 ||
      Array.from(key).some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      }))
  )
    return null;
  return service
    ? { kind: 'topology_service', service, ...(typeof key === 'string' ? { subjectKey: key } : {}) }
    : null;
}

const LIFECYCLE_STATUSES = new Set<IncidentStatus>(['open', 'mitigated', 'resolved', 'closed']);

export function isLifecycleStatus(value: unknown): value is IncidentStatus {
  return typeof value === 'string' && LIFECYCLE_STATUSES.has(value as IncidentStatus);
}

export function isStatus(value: string | undefined): value is IncidentStatus {
  return isLifecycleStatus(value);
}

export function safeSlackPermalink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const slackHost = url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !slackHost ||
      !url.pathname.startsWith('/archives/')
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

// The history cursor is opaque to the client: a base64url of the keyset position plus the ordering it
// was minted under. Decoding fails closed (null, so the route 400s) so a tampered or truncated cursor
// never silently returns page one. A cursor without `sort` predates sorting and means `newest`.
export function encodeCursor(cursor: IncidentPageCursor, sort: IncidentSort): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt,
      id: cursor.id,
      sort,
      ...(cursor.severityRank === undefined ? {} : { severityRank: cursor.severityRank }),
    }),
  ).toString('base64url');
}
export function decodeCursor(
  raw: string,
): (IncidentPageCursor & { sort: Exclude<IncidentSort, 'priority'> }) | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
      sort?: unknown;
      severityRank?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    // The id addresses a uuid column: a well-formed cursor carrying a non-UUID id would otherwise reach
    // Postgres and 22P02 (500), contradicting the malformed-cursor→400 contract. Validate it here.
    if (!UUID_RE.test(parsed.id)) return null;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    const sort = parsed.sort ?? 'newest';
    if (sort !== 'newest' && sort !== 'oldest' && sort !== 'severity') return null;
    if (sort !== 'severity') return { createdAt, id: parsed.id, sort };
    // Only ranks the server mints: any other integer (e.g. beyond int4) would fail in Postgres, not 400.
    if (
      typeof parsed.severityRank !== 'number' ||
      !INCIDENT_SEVERITY_RANKS.has(parsed.severityRank)
    )
      return null;
    return { createdAt, id: parsed.id, sort, severityRank: parsed.severityRank };
  } catch {
    return null;
  }
}

export function encodeEvidenceCursor(cursor: EvidencePageCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id })).toString(
    'base64url',
  );
}

// Evidence paging has one fixed order, so its cursor is only the keyset position and is validated
// independently of the incident-list sort rules.
export function decodeEvidenceCursor(raw: string): EvidencePageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    if (!UUID_RE.test(parsed.id)) return null;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export function encodeMessageCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeMessageCursor(raw: string): { createdAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt)))
      return null;
    if (typeof parsed.id !== 'string' || !UUID_RE.test(parsed.id)) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}
// A caller-supplied page size, clamped to a sane cap; anything non-positive/non-integer falls back to the
// repo default. Bounds the work per request so a huge `?limit=` cannot scan a whole scope at once.
export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return Math.min(n, 100);
}

export function safeAssessment(incident: Awaited<ReturnType<typeof getIncidentDetail>>) {
  if (!incident) return null;
  const hypothesesValid =
    incident.rankedHypotheses === null ||
    (Array.isArray(incident.rankedHypotheses) &&
      incident.rankedHypotheses.every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          typeof item.hypothesis === 'string' &&
          typeof item.confidence === 'number' &&
          typeof item.evidence === 'string' &&
          (item.state === undefined ||
            ['leading', 'plausible', 'disfavored', 'disproven'].includes(item.state)) &&
          (item.supportingEvidenceIds === undefined ||
            (Array.isArray(item.supportingEvidenceIds) &&
              item.supportingEvidenceIds.every(
                (evidenceId) => typeof evidenceId === 'string' && UUID_RE.test(evidenceId),
              ))) &&
          (item.contradictingEvidenceIds === undefined ||
            (Array.isArray(item.contradictingEvidenceIds) &&
              item.contradictingEvidenceIds.every(
                (evidenceId) => typeof evidenceId === 'string' && UUID_RE.test(evidenceId),
              ))),
      ));
  const gapCategories = new Set<string>(INVESTIGATION_GAP_CATEGORIES);
  const evidenceKinds = new Set<string>(INVESTIGATION_EVIDENCE_KINDS);
  const normalizeGap = (item: unknown): InvestigationGap | null => {
    if (typeof item === 'string') {
      return {
        question: item,
        category: 'partial_evidence',
        evidenceKind: null,
        attemptedEvidenceIds: [],
      };
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const gap = item as Record<string, unknown>;
    if (
      typeof gap.question === 'string' &&
      typeof gap.category === 'string' &&
      gapCategories.has(gap.category) &&
      (gap.evidenceKind === null ||
        (typeof gap.evidenceKind === 'string' && evidenceKinds.has(gap.evidenceKind))) &&
      Array.isArray(gap.attemptedEvidenceIds) &&
      gap.attemptedEvidenceIds.every(
        (evidenceId) => typeof evidenceId === 'string' && UUID_RE.test(evidenceId),
      )
    ) {
      return {
        question: gap.question,
        category: gap.category as InvestigationGap['category'],
        evidenceKind: gap.evidenceKind as InvestigationGap['evidenceKind'],
        attemptedEvidenceIds: gap.attemptedEvidenceIds as string[],
      };
    }
    return null;
  };
  const normalizedUnknowns = Array.isArray(incident.unknowns)
    ? incident.unknowns.map(normalizeGap)
    : incident.unknowns;
  const unknownsValid =
    normalizedUnknowns === null ||
    (Array.isArray(normalizedUnknowns) && normalizedUnknowns.every((item) => item !== null));
  const assessmentEvidenceValid =
    incident.assessmentEvidenceIds === null ||
    (Array.isArray(incident.assessmentEvidenceIds) &&
      incident.assessmentEvidenceIds.every(
        (evidenceId) => typeof evidenceId === 'string' && UUID_RE.test(evidenceId),
      ));
  const recoveryEvidenceValid =
    incident.recoveryEvidenceIds === null ||
    (Array.isArray(incident.recoveryEvidenceIds) &&
      incident.recoveryEvidenceIds.every(
        (evidenceId) => typeof evidenceId === 'string' && UUID_RE.test(evidenceId),
      ));
  const recoveryUnknownsValid =
    incident.recoveryUnknowns === null ||
    (Array.isArray(incident.recoveryUnknowns) &&
      incident.recoveryUnknowns.every((item) => typeof item === 'string'));
  const recoveryQuestionsValid =
    incident.recoveryQuestions == null ||
    (Array.isArray(incident.recoveryQuestions) &&
      incident.recoveryQuestions.every(
        (question) =>
          question &&
          typeof question === 'object' &&
          typeof question.question === 'string' &&
          typeof question.nextAction === 'string' &&
          question.nextAction.trim().length > 0 &&
          ['blocking', 'follow_up'].includes(question.resolutionRelevance) &&
          INVESTIGATION_GAP_CATEGORIES.includes(question.category) &&
          (question.evidenceKind === null ||
            INVESTIGATION_EVIDENCE_KINDS.includes(question.evidenceKind)) &&
          Array.isArray(question.attemptedEvidenceIds) &&
          question.attemptedEvidenceIds.every((id) => typeof id === 'string' && UUID_RE.test(id)),
      ));
  const valid =
    recoveryQuestionsValid &&
    hypothesesValid &&
    unknownsValid &&
    assessmentEvidenceValid &&
    recoveryEvidenceValid &&
    recoveryUnknownsValid;
  if (!valid) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        app: 'api',
        msg: 'invalid structured incident assessment',
        incidentId: incident.id,
      }),
    );
  }
  return {
    incident: {
      ...incident,
      rankedHypotheses: hypothesesValid ? incident.rankedHypotheses : [],
      unknowns: unknownsValid ? (normalizedUnknowns as InvestigationGap[] | null) : [],
      assessmentEvidenceIds: assessmentEvidenceValid ? incident.assessmentEvidenceIds : [],
      recoveryEvidenceIds: recoveryEvidenceValid ? incident.recoveryEvidenceIds : [],
      recoveryUnknowns: recoveryUnknownsValid ? incident.recoveryUnknowns : [],
      recoveryQuestions: recoveryQuestionsValid ? incident.recoveryQuestions : null,
    },
    assessmentState: !valid ? 'invalid' : incident.rcaSummary ? 'available' : 'pending',
  } as const;
}

/** Incident routes: tenant-scoped list/detail reads and runbook-generation/approval commands. */
