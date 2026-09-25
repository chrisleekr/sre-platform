import { changeResolutionPolicy } from './hub/resolution-policy';
import {
  activeResponderTx,
  humanMessageFenceMatchesTx,
  applySignalObservationTx,
  correctIncidentSignalTx,
  incidentMessages,
  incidentSignals,
  incidents,
  lockResponseGroupWorkTx,
  prepareResponseGroupRecoveryTx,
  replayIncidentSignalCorrectionTx,
  setIncidentArchivedTx,
  transitionIncidentTx,
  withTenant,
  type Db,
  type IncidentArchiveResult,
  type IncidentStatus,
  type LifecycleTransitionResult,
  type SignalApplyResult,
  type SignalCorrectionResult,
  type SignalEventType,
  type SignalObservation,
  type SignalState,
  type Tx,
} from '@sre/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { toHubMessage, type Author, type HubMessage, type NewMessage } from './hub/contracts';
import { HubPublisher } from './hub/publisher';
import { HubRecovery } from './hub/recovery';
import { HubStore } from './hub/store';
export * from './hub/contracts';
/** Coordinates the durable incident conversation and its live surface projections. */
export class ConversationHub {
  private readonly store: HubStore;
  private readonly publisher: HubPublisher;
  private readonly subscriber: HubPublisher;
  private readonly recovery: HubRecovery;
  constructor(
    private readonly db: Db,
    redis: Redis,
    publishRedis: Redis = redis,
  ) {
    this.store = new HubStore(db);
    this.publisher = new HubPublisher(publishRedis);
    this.subscriber = new HubPublisher(redis);
    this.recovery = new HubRecovery(db, this.store, (message) =>
      this.publishAppendedBestEffort(message),
    );
  }

  /** Publishes live delivery best-effort after the durable message and surface outbox commit. */
  async publishAppendedBestEffort(message: HubMessage): Promise<void> {
    await this.publisher.publishAppended(message).catch((error) =>
      console.warn(
        JSON.stringify({
          level: 'warn',
          pkg: '@sre/hub',
          event: 'hub.post_commit_delivery_failed',
          incidentId: message.incidentId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      ),
    );
  }

  appendTx(...args: Parameters<HubStore['appendTx']>): ReturnType<HubStore['appendTx']> {
    return this.store.appendTx(...args);
  }

  appendTxOnce(
    ...args: Parameters<HubStore['appendTxOnce']>
  ): ReturnType<HubStore['appendTxOnce']> {
    return this.store.appendTxOnce(...args);
  }

  publishAppended(
    ...args: Parameters<HubPublisher['publishAppended']>
  ): ReturnType<HubPublisher['publishAppended']> {
    return this.publisher.publishAppended(...args);
  }

  appendedByOrigin(
    ...args: Parameters<HubStore['appendedByOrigin']>
  ): ReturnType<HubStore['appendedByOrigin']> {
    return this.store.appendedByOrigin(...args);
  }

  appendedByTransition(
    ...args: Parameters<HubStore['appendedByTransition']>
  ): ReturnType<HubStore['appendedByTransition']> {
    return this.store.appendedByTransition(...args);
  }

  async append(tenantId: string, incidentId: string, msg: NewMessage): Promise<HubMessage> {
    return (await this.appendOnce(tenantId, incidentId, msg)).message;
  }

  /**
   * {@link append}, reporting whether it wrote the row. With `originMessageId` a redelivered append is a
   * no-op that returns the existing line (`inserted:false`); `inserted` is INFORMATION for the caller,
   * not a gate on the fan-out.
   */
  async appendOnce(
    tenantId: string,
    incidentId: string,
    msg: NewMessage,
  ): Promise<{ message: HubMessage; inserted: boolean }> {
    const result = await withTenant(this.db, tenantId, (tx) =>
      this.store.appendTxOnce(tx, tenantId, incidentId, msg),
    );
    // Publish on EVERY delivery, including a redelivered no-op: delivery 1 may commit and die before
    // publishing, and gating on `inserted` would leave a line no open dashboard renders until reload.
    // Duplicates are absorbed downstream (session.ts and useWsStream dedupe by message id; surface
    // delivery claims CAS the outbox row). A failed live delivery is logged; durable replay remains.
    await this.publishAppendedBestEffort(result.message);
    return result;
  }

  /**
   * Apply one lifecycle transition and append its immutable audit line in the same transaction. A
   * transition key identifies the cause, so API retries and queue redelivery return the first result.
   */
  async transitionIncident(
    tenantId: string,
    incidentId: string,
    input: {
      to: IncidentStatus;
      reason: string;
      transitionKey: string;
      author: Author;
      originSurface?: string;
      authorUserId?: string | null;
      expectedVersion?: number;
      humanMessageFence?: string | null;
      expectedSignals?: Array<{ id: string; version: number; state: SignalState }>;
      idleBefore?: Date;
    },
  ): Promise<{ transition: LifecycleTransitionResult; message: HubMessage | null }> {
    const result = await withTenant(this.db, tenantId, async (tx) => {
      if (
        input.author === 'human' &&
        !(await activeResponderTx(tx, tenantId, input.authorUserId))
      ) {
        return {
          transition: {
            outcome: 'forbidden',
            from: null,
            to: input.to,
            version: null,
          } satisfies LifecycleTransitionResult,
          message: null,
          publish: false,
        };
      }
      // Serialize the idempotency key before checking it. Without this, two concurrent requests using
      // the same key but different targets can both pass the read, apply two state changes, and then
      // collapse onto one audit row at the unique constraint.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${input.transitionKey}`}, 0))`,
      );
      const existing = await tx
        .select()
        .from(incidentMessages)
        .where(
          and(
            eq(incidentMessages.incidentId, incidentId),
            eq(incidentMessages.transitionKey, input.transitionKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        const message = toHubMessage(existing[0]);
        return {
          transition: {
            outcome: 'noop',
            from: message.lifecycleFrom as IncidentStatus,
            to: message.lifecycleTo as IncidentStatus,
            version: message.lifecycleVersion ?? null,
          } satisfies LifecycleTransitionResult,
          message,
          // Republish a durable retry. Dashboard consumers dedupe by message id and the surface outbox
          // claim absorbs duplicate stream entries; suppressing it would preserve a commit-to-publish gap.
          publish: true,
        };
      }
      // Take group locks before the human-message fence locks the incident row.
      await lockResponseGroupWorkTx(tx, tenantId, incidentId);
      if (!(await humanMessageFenceMatchesTx(tx, incidentId, input.humanMessageFence)))
        return {
          transition: {
            outcome: 'precondition_failed',
            from: null,
            to: input.to,
            version: null,
          } satisfies LifecycleTransitionResult,
          message: null,
          publish: false,
        };
      const transition = await transitionIncidentTx(tx, incidentId, input.to, {
        expectedVersion: input.expectedVersion,
        expectedSignals: input.expectedSignals,
        idleBefore: input.idleBefore,
      });
      if (transition.outcome !== 'applied') {
        return { transition, message: null, publish: false };
      }
      const content = `${transition.to === 'open' && transition.from !== 'open' ? 'Incident reopened' : `Incident ${transition.to}`}: ${input.reason}`;
      const message = await this.store.appendTx(tx, tenantId, incidentId, {
        author: input.author,
        kind: 'lifecycle',
        content,
        originSurface: input.originSurface,
        authorUserId: input.authorUserId,
        lifecycleFrom: transition.from,
        lifecycleTo: transition.to,
        lifecycleVersion: transition.version!,
        transitionKey: input.transitionKey,
      });
      return { transition, message, publish: true };
    });
    if (result.publish && result.message) await this.publishAppendedBestEffort(result.message);
    return { transition: result.transition, message: result.message };
  }

  /**
   * Correct one signal projection and append the responder's immutable audit line atomically. The
   * caller publishes the returned line so a Redis failure cannot prevent a committed recovery job
   * from being dispatched.
   */
  async correctSignal(
    tenantId: string,
    incidentId: string,
    signalId: string,
    input: {
      reason: string;
      correctionKey: string;
      author: Author;
      originSurface?: string;
      authorUserId?: string | null;
      expectedVersion: number;
      resolvedAt: Date;
      enqueueRecoveryTx?: (
        tx: Tx,
        context: { incidentId: string; lifecycleVersion: number; signalFence: string },
      ) => Promise<string | null>;
    },
  ): Promise<{
    correction: SignalCorrectionResult;
    message: HubMessage | null;
    recoveryJobId: string | null;
  }> {
    const result = await withTenant(this.db, tenantId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${input.correctionKey}`}, 0))`,
      );
      const existing = await tx
        .select()
        .from(incidentMessages)
        .where(
          and(
            eq(incidentMessages.incidentId, incidentId),
            eq(incidentMessages.transitionKey, input.correctionKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        const correction = await replayIncidentSignalCorrectionTx(tx, incidentId, signalId);
        return {
          correction,
          message: toHubMessage(existing[0]),
          recoveryJobId: null,
        };
      }

      await lockResponseGroupWorkTx(tx, tenantId, incidentId);
      const correction = await correctIncidentSignalTx(tx, incidentId, signalId, {
        expectedVersion: input.expectedVersion,
        resolvedAt: input.resolvedAt,
      });
      if (correction.outcome !== 'applied') {
        return { correction, message: null, recoveryJobId: null };
      }
      const message = await this.store.appendTx(tx, tenantId, incidentId, {
        author: input.author,
        kind: 'signal',
        content: `Provider signal corrected to resolved: ${input.reason}`,
        originSurface: input.originSurface,
        authorUserId: input.authorUserId,
        transitionKey: input.correctionKey,
        signalId: correction.signal.id,
        signalState: 'resolved',
        signalEventType: 'resolved',
      });
      const recovery = await prepareResponseGroupRecoveryTx(tx, tenantId, incidentId);
      const recoveryJobId =
        recovery && input.enqueueRecoveryTx
          ? await input.enqueueRecoveryTx(tx, {
              incidentId: recovery.rootIncidentId,
              lifecycleVersion: recovery.lifecycleVersion,
              signalFence: recovery.signalFence,
            })
          : null;
      return { correction, message, recoveryJobId };
    });
    return {
      correction: result.correction,
      message: result.message,
      recoveryJobId: result.recoveryJobId,
    };
  }

  /** Delete one terminal incident and append its dashboard-only audit line atomically. */
  async setIncidentArchived(
    tenantId: string,
    incidentId: string,
    input: {
      archived: true;
      reason: string;
      archiveKey: string;
      author: Author;
      originSurface?: string;
      authorUserId?: string | null;
      expectedVersion?: number;
      idleBefore?: Date;
      allowActiveSignalsForClosed?: boolean;
    },
  ): Promise<{ archive: IncidentArchiveResult; message: HubMessage | null }> {
    const result = await withTenant(this.db, tenantId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${input.archiveKey}`}, 0))`,
      );
      const existing = await tx
        .select()
        .from(incidentMessages)
        .where(
          and(
            eq(incidentMessages.incidentId, incidentId),
            eq(incidentMessages.transitionKey, input.archiveKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        const incidentRows = await tx
          .select({
            archivedAt: incidents.archivedAt,
            lifecycleVersion: incidents.lifecycleVersion,
          })
          .from(incidents)
          .where(eq(incidents.id, incidentId))
          .limit(1);
        const incident = incidentRows[0];
        return {
          archive: {
            outcome: 'noop',
            archivedAt: incident?.archivedAt ?? null,
            lifecycleVersion: incident?.lifecycleVersion ?? null,
          } satisfies IncidentArchiveResult,
          message: toHubMessage(existing[0]),
          publish: true,
        };
      }

      // The human audit append takes group work locks; take them before the archive locks the row.
      await lockResponseGroupWorkTx(tx, tenantId, incidentId);
      const archive = await setIncidentArchivedTx(tx, incidentId, input.archived, {
        expectedVersion: input.expectedVersion,
        idleBefore: input.idleBefore,
        allowActiveSignalsForClosed: input.allowActiveSignalsForClosed,
      });
      if (archive.outcome !== 'applied') return { archive, message: null, publish: false };
      const message = await this.store.appendTx(tx, tenantId, incidentId, {
        author: input.author,
        kind: 'archive',
        content: `Incident deleted: ${input.reason}`,
        originSurface: input.originSurface,
        authorUserId: input.authorUserId,
        transitionKey: input.archiveKey,
      });
      return { archive, message, publish: true };
    });
    if (result.publish && result.message) await this.publishAppendedBestEffort(result.message);
    return { archive: result.archive, message: result.message };
  }

  /** Persist a monotonic signal observation and its immutable transcript line on the caller's tx. */
  async observeSignalTx(
    tx: Tx,
    tenantId: string,
    observation: SignalObservation,
    content: string,
  ): Promise<{ observation: SignalApplyResult; message: HubMessage | null }> {
    // The event key is the immutable remote observation identity. Serialize it before selecting a signal
    // target so an at-least-once retry cannot apply one resolved root to a different unresolved signal.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${observation.eventKey}`}, 0))`,
    );
    const claimed = await tx
      .select()
      .from(incidentMessages)
      .where(eq(incidentMessages.originMessageId, observation.eventKey))
      .limit(1);
    if (claimed[0]) {
      const existingMessage = toHubMessage(claimed[0]);
      if (!claimed[0].signalId || !claimed[0].signalEventType) {
        throw new Error('signal event claim is missing signal metadata');
      }
      const signals = await tx
        .select()
        .from(incidentSignals)
        .where(eq(incidentSignals.id, claimed[0].signalId))
        .limit(1);
      const signal = signals[0];
      if (!signal) throw new Error('signal event claim references a missing signal');
      if (
        signal.surface !== observation.surface ||
        signal.channel !== observation.channel ||
        signal.externalMessageId !== observation.externalMessageId
      )
        return {
          observation: {
            signal,
            applied: false,
            eventType: claimed[0].signalEventType as SignalEventType,
            previousState: signal.state as SignalState,
            allResolved: false,
            investigationTriggerReason: 'unchanged_renotification' as const,
          },
          message: existingMessage,
        };
      const applied = await applySignalObservationTx(tx, tenantId, observation);
      if (applied.signal.id !== signal.id)
        throw new Error('signal event claim resolved to a different signal');
      return {
        observation: applied,
        message: existingMessage,
      };
    }
    const applied = await applySignalObservationTx(tx, tenantId, observation);
    if (!applied.applied) return { observation: applied, message: null };
    const appended = await this.store.appendTxOnce(tx, tenantId, observation.incidentId, {
      author: 'system',
      kind: 'signal',
      content,
      originSurface: observation.surface,
      originMessageId: observation.eventKey,
      signalId: applied.signal.id,
      signalState: applied.signal.state as SignalState,
      signalEventType: applied.eventType,
    });
    return { observation: applied, message: appended.message };
  }

  /** Audits an authorized resolution-policy change and schedules its reevaluation. */
  changeResolutionPolicy(
    tenantId: string,
    incidentId: string,
    input: Parameters<typeof changeResolutionPolicy>[4],
  ) {
    return changeResolutionPolicy(this.db, this.store, tenantId, incidentId, input);
  }

  /** Applies the explicit provider-clear policy before model admission. */
  resolveProviderClear(
    ...args: Parameters<HubRecovery['resolveProviderClear']>
  ): ReturnType<HubRecovery['resolveProviderClear']> {
    return this.recovery.resolveProviderClear(...args);
  }

  finalizeRecovery(
    ...args: Parameters<HubRecovery['finalizeRecovery']>
  ): ReturnType<HubRecovery['finalizeRecovery']> {
    return this.recovery.finalizeRecovery(...args);
  }

  completeVerifiedRecoveryAfterApprovalTx(
    ...args: Parameters<HubRecovery['completeVerifiedRecoveryAfterApprovalTx']>
  ): ReturnType<HubRecovery['completeVerifiedRecoveryAfterApprovalTx']> {
    return this.recovery.completeVerifiedRecoveryAfterApprovalTx(...args);
  }

  publishPersisted(
    ...args: Parameters<HubPublisher['publishPersisted']>
  ): ReturnType<HubPublisher['publishPersisted']> {
    return this.publisher.publishPersisted(...args);
  }

  history(...args: Parameters<HubStore['history']>): ReturnType<HubStore['history']> {
    return this.store.history(...args);
  }

  opener(...args: Parameters<HubStore['opener']>): ReturnType<HubStore['opener']> {
    return this.store.opener(...args);
  }

  subscribe(...args: Parameters<HubPublisher['subscribe']>): ReturnType<HubPublisher['subscribe']> {
    return this.subscriber.subscribe(...args);
  }
}
