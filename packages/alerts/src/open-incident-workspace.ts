import {
  applySignalObservationTx,
  createIncident,
  enqueueConnectedSurfaceDeliveriesTx,
  findLatestSubjectIncidentTx,
  incidentMessages,
  insertInvestigationSubjectTx,
  recordIncidentRelationTx,
  recordSurfaceBinding,
  withTenant,
  type Db,
  type IncidentStatus,
  type IncidentCorrelationDecision,
  type InvestigationStatus,
  type InvestigationSubjectKind,
  type SignalEventType,
  type SignalObservation,
  type SignalState,
  type Surface,
  type Tx,
} from '@sre/db';
import type { AffectedEntityCandidate, InvestigationTrigger, SignalSource } from '@sre/contracts';
import type { Queue } from '@sre/queue';
import { createHash } from 'node:crypto';
import {
  isPlatformSubjectIdentityPart,
  platformSubjectFingerprint,
  platformSubjectSignalExternalId,
} from './platform-subject-identity';

const MAX_TEXT = 1_000;
const MAX_SNAPSHOT_BYTES = 8_192;

function bounded(value: string, max = MAX_TEXT): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : character;
  })
    .join('')
    .trim()
    .slice(0, max);
}

function safeSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SNAPSHOT_BYTES)
    throw new Error('investigation subject snapshot exceeds the allowed size');
  return JSON.parse(encoded) as Record<string, unknown>;
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export interface OpenIncidentSubject {
  kind: InvestigationSubjectKind;
  sourceId: string;
  subjectId: string;
  sourcePath: string;
  state: SignalState;
  summary: string;
  observedAt: Date;
  snapshot: Record<string, unknown>;
  contentHash?: string;
  syncEnabled?: boolean;
  signalSource?: SignalSource;
  affectedEntities?: AffectedEntityCandidate[];
}

interface OpenIncidentWorkspaceBaseInput {
  tenantId: string;
  source: string;
  service: string;
  severity: string;
  purpose?: 'incident' | 'health_check';
  title?: string;
  context?: unknown;
  investigationTrigger?: InvestigationTrigger;
  status?: IncidentStatus;
  investigationStatus?: InvestigationStatus;
  /** Resolves a provider correlation target while holding the workspace transaction. */
  resolveIncidentRouteTx?: (
    tx: Tx,
    requestedFingerprint: string,
  ) => Promise<{
    fingerprint: string;
    bindingRole?: 'primary' | 'source';
    correlationDecision?: IncidentCorrelationDecision;
  }>;
  binding?: { surface: Surface; channel: string; threadId: string };
  opener?: {
    author: 'human' | 'system';
    content: string;
    originSurface: Surface | 'dashboard';
    originMessageId: string;
    authorUserId?: string | null;
  };
  onOpenedTx?: (
    tx: Tx,
    result: {
      incidentId: string;
      bindingId: string | null;
      reused: boolean;
      signalId: string | null;
      correlationDecision?: IncidentCorrelationDecision;
    },
  ) => Promise<void>;
}

export type OpenIncidentWorkspaceInput =
  | (OpenIncidentWorkspaceBaseInput & {
      subject: OpenIncidentSubject;
      fingerprint?: never;
      signal?: never;
    })
  | (OpenIncidentWorkspaceBaseInput & {
      subject?: never;
      fingerprint: string;
      signal?: Omit<SignalObservation, 'incidentId'>;
      signals?: Omit<SignalObservation, 'incidentId'>[];
    });

export interface OpenIncidentWorkspaceDeps {
  appDb: Db;
  queue: Queue;
  appendOpenerTx?: (
    tx: Tx,
    tenantId: string,
    incidentId: string,
    opener: NonNullable<OpenIncidentWorkspaceInput['opener']>,
    observed?: { id: string; state: SignalState; eventType: SignalEventType },
  ) => Promise<{ incidentId: string; afterCommit?: () => Promise<void> }>;
}

export interface OpenIncidentWorkspaceResult {
  outcome: 'created' | 'existing';
  incidentId: string;
  jobId: string | null;
  bindingId: string | null;
}

/** Reports that a surface conversation already belongs to another incident. */
export class SurfaceThreadConflictError extends Error {
  constructor(readonly incidentId: string) {
    super('surface thread belongs to another incident');
    this.name = 'SurfaceThreadConflictError';
  }
}

/**
 * Creates or reuses a canonical incident workspace atomically.
 *
 * @param deps - Persistence, queue, hub, and subject synchronization dependencies.
 * @param input - Trusted incident seed and optional originating surface binding.
 */
export async function openIncidentWorkspace(
  deps: OpenIncidentWorkspaceDeps,
  input: OpenIncidentWorkspaceInput,
): Promise<OpenIncidentWorkspaceResult> {
  let publishOpener: (() => Promise<void>) | undefined;
  let subjectSyncJobId: string | null = null;
  const result = await withTenant(deps.appDb, input.tenantId, async (tx) => {
    const sourceId = input.subject?.sourceId ?? null;
    const subjectId = input.subject?.subjectId ?? null;
    if (
      input.subject &&
      (!isPlatformSubjectIdentityPart(sourceId!) || !isPlatformSubjectIdentityPart(subjectId!))
    )
      throw new Error('investigation subject identity is invalid');
    const requestedFingerprint = input.subject
      ? platformSubjectFingerprint({
          kind: input.subject.kind,
          sourceId: sourceId!,
          subjectId: subjectId!,
        })
      : bounded(input.fingerprint, 500);
    const route = input.resolveIncidentRouteTx
      ? await input.resolveIncidentRouteTx(tx, requestedFingerprint)
      : { fingerprint: requestedFingerprint };
    const fingerprint = bounded(route.fingerprint, 500);
    const prior = input.subject ? await findLatestSubjectIncidentTx(tx, fingerprint) : null;
    const created = await createIncident(tx, input.tenantId, {
      fingerprint,
      alertSource: bounded(input.source, 100),
      service: bounded(input.service, 200),
      severity: bounded(input.severity, 32),
      purpose: input.purpose,
      title: input.title ? bounded(input.title, 300) : undefined,
      status: input.status,
      investigationStatus: input.investigationStatus,
    });

    let bindingId: string | null = null;
    if (input.binding) {
      const binding = await recordSurfaceBinding(tx, input.tenantId, {
        incidentId: created.id,
        surface: input.binding.surface,
        channel: bounded(input.binding.channel, 200),
        threadId: bounded(input.binding.threadId, 300),
        role: created.reused ? route.bindingRole : 'primary',
      });
      if (binding.incidentId !== created.id)
        throw new SurfaceThreadConflictError(binding.incidentId);
      bindingId = binding.id;
    }

    if (created.reused) {
      await input.onOpenedTx?.(tx, {
        incidentId: created.id,
        bindingId,
        reused: true,
        signalId: null,
        correlationDecision: route.correlationDecision,
      });
      return {
        outcome: 'existing' as const,
        incidentId: created.id,
        jobId: null,
        bindingId,
      };
    }

    let observed: Awaited<ReturnType<typeof applySignalObservationTx>> | null = null;
    let observedSignals: Awaited<ReturnType<typeof applySignalObservationTx>>[] = [];
    if (input.subject) {
      const externalSignalId = platformSubjectSignalExternalId(fingerprint, created.id);
      const snapshot = safeSnapshot(input.subject.snapshot);
      const summary = bounded(input.subject.summary, 2_000);
      const hash =
        input.subject.contentHash ??
        contentHash({
          state: input.subject.state,
          summary,
          snapshot,
        });
      await insertInvestigationSubjectTx(tx, input.tenantId, created.id, {
        kind: input.subject.kind,
        sourceId: sourceId!,
        subjectId: subjectId!,
        fingerprint,
        sourcePath: bounded(input.subject.sourcePath, 500),
        state: input.subject.state,
        summary,
        snapshot,
        contentHash: hash,
        observedAt: input.subject.observedAt,
        syncEnabled: input.subject.syncEnabled ?? input.subject.kind !== 'deployment',
      });
      observed = await applySignalObservationTx(tx, input.tenantId, {
        incidentId: created.id,
        provider: 'platform',
        alertName: input.title ? bounded(input.title, 300) : undefined,
        materialHash: hash,
        signalSource: input.subject.signalSource,
        affectedEntities: input.subject.affectedEntities,
        surface: 'dashboard',
        channel: bounded(input.subject.sourcePath, 500),
        externalMessageId: externalSignalId,
        state: input.subject.state,
        summary,
        contentHash: hash,
        eventKey: `${externalSignalId}:${hash}`,
        eventAt: input.subject.observedAt,
      });
      observedSignals = [observed];

      const lifecycleRows = await tx
        .insert(incidentMessages)
        .values({
          tenantId: input.tenantId,
          incidentId: created.id,
          author: 'system',
          kind: 'lifecycle',
          content: 'Incident opened from a platform observation.',
          lifecycleTo: 'open',
          lifecycleVersion: 0,
          transitionKey: `platform-open:${created.id}`,
        })
        .returning({ id: incidentMessages.id });
      const openerRows = await tx
        .insert(incidentMessages)
        .values({
          tenantId: input.tenantId,
          incidentId: created.id,
          author: 'system',
          kind: 'text',
          content: summary,
          originSurface: 'dashboard',
          originMessageId: externalSignalId,
          signalId: observed.signal.id,
          signalState: observed.signal.state,
          signalEventType: observed.eventType,
        })
        .returning({ id: incidentMessages.id });
      if (lifecycleRows[0])
        await enqueueConnectedSurfaceDeliveriesTx(
          tx,
          input.tenantId,
          created.id,
          lifecycleRows[0].id,
          'lifecycle',
        );
      if (openerRows[0])
        await enqueueConnectedSurfaceDeliveriesTx(
          tx,
          input.tenantId,
          created.id,
          openerRows[0].id,
          'text',
          'dashboard',
        );

      if (prior && prior.incidentId !== created.id) {
        await recordIncidentRelationTx(tx, input.tenantId, {
          sourceIncidentId: created.id,
          targetIncidentId: prior.incidentId,
          type: 'recurrence_of',
          rationale: 'The same platform subject opened a new incident episode.',
          evidence: [fingerprint],
          decidedBy: 'system',
        });
      }
    } else {
      const observations = input.signals?.length
        ? input.signals
        : input.signal
          ? [input.signal]
          : [];
      for (const signal of observations) {
        observedSignals.push(
          await applySignalObservationTx(tx, input.tenantId, {
            ...signal,
            incidentId: created.id,
          }),
        );
      }
      observed = observedSignals[0] ?? null;
    }

    if (input.opener) {
      if (!deps.appendOpenerTx) throw new Error('incident opener writer not configured');
      const opener = await deps.appendOpenerTx(
        tx,
        input.tenantId,
        created.id,
        input.opener,
        observed
          ? {
              id: observed.signal.id,
              state: observed.signal.state as SignalState,
              eventType: observed.eventType,
            }
          : undefined,
      );
      if (opener.incidentId !== created.id) throw new SurfaceThreadConflictError(opener.incidentId);
      publishOpener = opener.afterCommit;
    }

    await input.onOpenedTx?.(tx, {
      incidentId: created.id,
      bindingId,
      reused: false,
      signalId: observed?.signal.id ?? null,
      correlationDecision: route.correlationDecision,
    });

    const signalMaterials = observedSignals.flatMap((item) =>
      item.signal.materialHash
        ? [
            {
              signalId: item.signal.id,
              signalVersion: item.signal.version,
              materialHash: item.signal.materialHash,
            },
          ]
        : [],
    );
    const jobId = await deps.queue.insertJobTx(tx, {
      tenantId: input.tenantId,
      type: 'triage',
      payload: {
        incidentId: created.id,
        title: input.title,
        alert: input.subject ? safeSnapshot(input.subject.snapshot) : input.context,
        fingerprint,
        ...(signalMaterials.length > 0 ? { signalMaterials } : {}),
        investigationTrigger:
          input.investigationTrigger ??
          ({
            reason: 'new_episode',
            automatic: true,
            monitorKey: `${bounded(input.source, 100)}:${fingerprint}`,
          } satisfies InvestigationTrigger),
      },
    });
    if (input.subject && (input.subject.syncEnabled ?? input.subject.kind !== 'deployment')) {
      subjectSyncJobId = (
        await deps.queue.insertSubjectSyncTx(
          tx,
          input.tenantId,
          created.id,
          new Date(Date.now() + 5 * 60_000),
        )
      ).jobId;
    }
    return {
      outcome: 'created' as const,
      incidentId: created.id,
      jobId,
      bindingId,
    };
  });

  await publishOpener?.().catch(() => undefined);
  if (result.jobId) await deps.queue.publishJob(result.jobId).catch(() => undefined);
  if (subjectSyncJobId) await deps.queue.publishJob(subjectSyncJobId).catch(() => undefined);
  return result;
}
