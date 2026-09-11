import { createHash, randomUUID } from 'node:crypto';
import { scrubSecrets } from '@sre/agent-tools';
import {
  acceptSurfaceInboundEventTx,
  linkSurfaceInboundJobTx,
  recordDroppedSurfaceInbound,
  updateSurfaceInboundState,
  type Db,
  type SurfaceInboundMetadata,
} from '@sre/db';
import { RetryableError, type Job, type JobHandler, type Queue } from '@sre/queue';
import type { SlackTeamRoute } from './slack-socket';

const SLACK_INBOUND_JOB = 'slack.inbound';
const OMITTED_SLACK_FIELDS = new Set([
  'token',
  'response_url',
  'response_urls',
  'bot_access_token',
  'access_token',
  'refresh_token',
  'client_secret',
]);

interface SlackInboundPayload {
  intakeId: string;
  kind: 'event' | 'interaction';
  route: SlackTeamRoute;
  body: Record<string, unknown>;
}

export interface SlackInboundPipelineDeps {
  db: Db;
  queue: Pick<Queue, 'insertJobTx' | 'publishJob'>;
  processEvent(
    route: SlackTeamRoute,
    body: Record<string, unknown>,
    context: { intakeId: string },
  ): Promise<string | void>;
  processInteraction(route: SlackTeamRoute, body: Record<string, unknown>): Promise<string | void>;
  onError?: (error: unknown, context: { operation: string; intakeId?: string }) => void;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Persist only a replayable, scrubbed Slack payload. Socket payloads can contain pasted credentials and
 * capability URLs; neither belongs in the durable jobs table. */
function durableSlackValue(value: unknown, key?: string): unknown {
  if (key && OMITTED_SLACK_FIELDS.has(key)) return undefined;
  if (typeof value === 'string') {
    if (key === 'trigger_id') return createHash('sha256').update(value).digest('hex');
    return scrubSecrets(value);
  }
  if (Array.isArray(value)) return value.map((item) => durableSlackValue(item));
  const record = objectRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).flatMap(([entryKey, entryValue]) => {
      const durable = durableSlackValue(entryValue, entryKey);
      return durable === undefined ? [] : [[entryKey, durable]];
    }),
  );
}

function durableSlackBody(body: Record<string, unknown>): Record<string, unknown> {
  return durableSlackValue(body) as Record<string, unknown>;
}

export function slackDeliveryKey(envelopeType: string, body: Record<string, unknown>): string {
  if (typeof body.event_id === 'string') return `event:${body.event_id}`;
  const action = Array.isArray(body.actions) ? objectRecord(body.actions[0]) : undefined;
  const team = objectRecord(body.team);
  const user = objectRecord(body.user);
  const interactive = [
    team?.id,
    user?.id,
    action?.action_id,
    action?.action_ts,
    body.trigger_id,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);
  if (interactive.length > 0) {
    const digest = createHash('sha256').update(interactive.join('\0')).digest('hex');
    return `interaction:${digest}`;
  }
  return `${envelopeType}:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}

export function slackInboundMetadata(
  envelopeType: string,
  body: Record<string, unknown>,
  route?: SlackTeamRoute,
): SurfaceInboundMetadata {
  const event = objectRecord(body.event);
  const message = event?.subtype === 'message_changed' ? objectRecord(event.message) : event;
  return {
    tenantId: route?.tenantId,
    configId: route?.configId,
    surface: 'slack',
    deliveryKey: slackDeliveryKey(envelopeType, body),
    envelopeType,
    eventType:
      typeof event?.type === 'string'
        ? event.type
        : typeof body.type === 'string'
          ? body.type
          : undefined,
    eventSubtype: typeof event?.subtype === 'string' ? event.subtype : undefined,
    channel: typeof event?.channel === 'string' ? event.channel : undefined,
    externalMessageId: typeof message?.ts === 'string' ? message.ts : undefined,
  };
}

function payload(job: Job): SlackInboundPayload {
  if (job.type !== SLACK_INBOUND_JOB || !objectRecord(job.payload)) {
    throw new Error('invalid Slack inbound job');
  }
  const value = job.payload as Partial<SlackInboundPayload>;
  if (
    typeof value.intakeId !== 'string' ||
    (value.kind !== 'event' && value.kind !== 'interaction') ||
    !objectRecord(value.route) ||
    !objectRecord(value.body)
  ) {
    throw new Error('invalid Slack inbound payload');
  }
  return value as SlackInboundPayload;
}

export function makeSlackInboundPipeline(deps: SlackInboundPipelineDeps) {
  const accept = async (
    kind: SlackInboundPayload['kind'],
    route: SlackTeamRoute,
    body: Record<string, unknown>,
  ): Promise<'queued' | 'duplicate'> => {
    const envelopeType = kind === 'event' ? 'events_api' : 'interactive';
    const accepted = await deps.db.transaction(async (tx) => {
      const receipt = await acceptSurfaceInboundEventTx(
        tx,
        slackInboundMetadata(envelopeType, body, route),
      );
      if (!receipt.inserted)
        return { inserted: false as const, intakeId: receipt.row.id, jobId: receipt.row.jobId };
      const jobId = await deps.queue.insertJobTx(tx, {
        tenantId: route.tenantId,
        type: SLACK_INBOUND_JOB,
        payload: {
          intakeId: receipt.row.id,
          kind,
          route,
          body: durableSlackBody(body),
        } satisfies SlackInboundPayload,
      });
      await linkSurfaceInboundJobTx(tx, receipt.row.id, jobId);
      return { inserted: true as const, intakeId: receipt.row.id, jobId };
    });
    if (!accepted.inserted) return 'duplicate';
    void deps.queue
      .publishJob(accepted.jobId)
      .catch((error) =>
        deps.onError?.(error, { operation: 'publish', intakeId: accepted.intakeId }),
      );
    return 'queued';
  };

  const handler: JobHandler = async (job) => {
    const input = payload(job);
    await updateSurfaceInboundState(deps.db, input.intakeId, {
      state: 'processing',
      attemptCount: job.attempts,
    });
    try {
      const outcome =
        input.kind === 'event'
          ? await deps.processEvent(input.route, input.body, { intakeId: input.intakeId })
          : await deps.processInteraction(input.route, input.body);
      await updateSurfaceInboundState(deps.db, input.intakeId, {
        state: 'processed',
        outcome: outcome ?? 'processed',
        attemptCount: job.attempts,
        completed: true,
      });
    } catch (error) {
      deps.onError?.(error, { operation: 'process', intakeId: input.intakeId });
      await updateSurfaceInboundState(deps.db, input.intakeId, {
        state: 'retrying',
        outcome: 'processing_failed',
        errorCode: 'dependency_failure',
        attemptCount: job.attempts,
      }).catch((stateError) =>
        deps.onError?.(stateError, { operation: 'mark_retrying', intakeId: input.intakeId }),
      );
      throw new RetryableError('Slack inbound processing failed');
    }
  };

  return {
    acceptEvent: (route: SlackTeamRoute, body: Record<string, unknown>) =>
      accept('event', route, body),
    acceptInteraction: (route: SlackTeamRoute, body: Record<string, unknown>) =>
      accept('interaction', route, body),
    recordDrop: (
      envelopeType: string,
      body: Record<string, unknown>,
      outcome: string,
      route?: SlackTeamRoute,
    ) =>
      recordDroppedSurfaceInbound(deps.db, {
        ...slackInboundMetadata(envelopeType, body, route),
        outcome,
      }),
    handler,
  };
}

export async function startSlackInboundWorker(
  queue: Pick<Queue, 'ensureGroup' | 'process' | 'reconcile'>,
  handler: JobHandler,
  options: {
    pollMs?: number;
    reconcileMs?: number;
    consumer?: string;
    onError?: (error: unknown) => void;
  } = {},
): Promise<{ stop(): Promise<void> }> {
  const pollMs = options.pollMs ?? 250;
  const reconcileMs = options.reconcileMs ?? 60_000;
  const consumer = options.consumer ?? `slack-inbound-${randomUUID().slice(0, 8)}`;
  await queue.ensureGroup();
  let stopped = false;
  let running: Promise<void> | null = null;
  let lastReconcile = 0;
  const tick = (): void => {
    if (stopped || running) return;
    running = (async () => {
      await queue.process(consumer, handler);
      const now = Date.now();
      if (now - lastReconcile >= reconcileMs) {
        await queue.reconcile();
        lastReconcile = now;
      }
    })()
      .catch((error) => options.onError?.(error))
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, pollMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
