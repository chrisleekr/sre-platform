import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Db } from '@sre/db';
import type { Job, Queue } from '@sre/queue';
import { makeSlackInboundPipeline, slackDeliveryKey } from '../slack-intake';

const mocks = vi.hoisted(() => ({
  acceptSurfaceInboundEventTx: vi.fn(),
  linkSurfaceInboundJobTx: vi.fn(async () => undefined),
  recordDroppedSurfaceInbound: vi.fn(async () => undefined),
  updateSurfaceInboundState: vi.fn(async () => undefined),
}));

vi.mock('@sre/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...mocks,
}));

const route = {
  configId: 'config-1',
  tenantId: 'tenant-1',
  appId: 'app-1',
  botUserId: 'bot-user-1',
};
const body = {
  team_id: 'team-1',
  api_app_id: 'app-1',
  event_id: 'event-1',
  event: { type: 'message', channel: 'channel-1', ts: '1.1', text: 'alert' },
};

function setup() {
  const tx = {};
  const db = {
    transaction: vi.fn(async (operation: (value: unknown) => Promise<unknown>) => operation(tx)),
  } as unknown as Db;
  const insertJobTx = vi.fn(async (_tx: unknown, _job: unknown) => 'job-1');
  const publishJob = vi.fn(async () => undefined);
  const queue = {
    insertJobTx,
    publishJob,
    ensureGroup: vi.fn(),
    process: vi.fn(),
    reconcile: vi.fn(),
  } as unknown as Queue;
  const processEvent = vi.fn(async () => 'classify_enqueued');
  const processInteraction = vi.fn(async () => 'interaction_processed');
  const pipeline = makeSlackInboundPipeline({
    db,
    queue,
    processEvent,
    processInteraction,
  });
  return { pipeline, db, queue, insertJobTx, publishJob, processEvent, processInteraction };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acceptSurfaceInboundEventTx.mockResolvedValue({
    inserted: true,
    row: { id: 'intake-1', jobId: null },
  });
});

describe('durable Slack inbound pipeline', () => {
  test('commits the intake and durable job without running downstream processing on the ack path', async () => {
    const { pipeline, insertJobTx, publishJob, processEvent } = setup();

    await expect(pipeline.acceptEvent(route, body)).resolves.toBe('queued');

    expect(mocks.acceptSurfaceInboundEventTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-1',
        configId: 'config-1',
        deliveryKey: 'event:event-1',
        eventType: 'message',
        channel: 'channel-1',
      }),
    );
    expect(insertJobTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-1', type: 'slack.inbound' }),
    );
    expect(mocks.linkSurfaceInboundJobTx).toHaveBeenCalledWith(
      expect.anything(),
      'intake-1',
      'job-1',
    );
    expect(processEvent).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(publishJob).toHaveBeenCalledWith('job-1'));
  });

  test('scrubs persisted event text and omits Slack capability fields before inserting the job', async () => {
    const { pipeline, insertJobTx } = setup();
    const secret = 'AKIAIOSFODNN7EXAMPLE';

    await pipeline.acceptEvent(route, {
      ...body,
      token: 'legacy-verification-token',
      response_url: 'https://hooks.slack.test/actions/capability-secret',
      event: { ...body.event, text: `retry with ${secret}` },
    });

    const inserted = insertJobTx.mock.calls[0]![1] as {
      payload: { body: Record<string, unknown> };
    };
    const persisted = JSON.stringify(inserted.payload.body);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('legacy-verification-token');
    expect(persisted).not.toContain('capability-secret');
  });

  test('hashes a short-lived interaction trigger while keeping the action replayable', async () => {
    const { pipeline, insertJobTx } = setup();
    const trigger = '123456789.123456789.abcdef';

    await pipeline.acceptInteraction(route, {
      type: 'block_actions',
      trigger_id: trigger,
      user: { id: 'user-1' },
      actions: [{ action_id: 'incident_lifecycle:resolved', action_ts: '1.2', value: '{}' }],
    });

    const inserted = insertJobTx.mock.calls[0]![1] as {
      payload: { body: Record<string, unknown> };
    };
    expect(inserted.payload.body.trigger_id).not.toBe(trigger);
    expect(inserted.payload.body.trigger_id).toMatch(/^[0-9a-f]{64}$/);
    expect(
      slackDeliveryKey('interactive', {
        type: 'block_actions',
        trigger_id: trigger,
        user: { id: 'user-1' },
        actions: [{ action_id: 'incident_lifecycle:resolved', action_ts: '1.2' }],
      }),
    ).not.toContain(trigger);
    expect(inserted.payload.body.actions).toEqual([
      { action_id: 'incident_lifecycle:resolved', action_ts: '1.2', value: '{}' },
    ]);
  });

  test('a Slack redelivery reuses the receipt and never creates a second job', async () => {
    mocks.acceptSurfaceInboundEventTx.mockResolvedValue({
      inserted: false,
      row: { id: 'intake-1', jobId: 'job-1' },
    });
    const { pipeline, insertJobTx, publishJob } = setup();

    await expect(pipeline.acceptEvent(route, body)).resolves.toBe('duplicate');

    expect(insertJobTx).not.toHaveBeenCalled();
    expect(publishJob).not.toHaveBeenCalled();
  });

  test('the worker records the exact terminal outcome after processing', async () => {
    const { pipeline, processEvent } = setup();
    const job: Job = {
      id: 'job-1',
      tenantId: 'tenant-1',
      type: 'slack.inbound',
      attempts: 1,
      payload: { intakeId: 'intake-1', kind: 'event', route, body },
    };

    await pipeline.handler(job, { signal: new AbortController().signal });

    expect(processEvent).toHaveBeenCalledWith(route, body, { intakeId: 'intake-1' });
    expect(mocks.updateSurfaceInboundState).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'intake-1',
      {
        state: 'processing',
        attemptCount: 1,
      },
    );
    expect(mocks.updateSurfaceInboundState).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'intake-1',
      {
        state: 'processed',
        outcome: 'classify_enqueued',
        attemptCount: 1,
        completed: true,
      },
    );
  });

  test('unrouteable envelopes get a durable dropped receipt before acknowledgement', async () => {
    const { pipeline } = setup();

    await pipeline.recordDrop('events_api', body, 'unknown_team');

    expect(mocks.recordDroppedSurfaceInbound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deliveryKey: slackDeliveryKey('events_api', body),
        outcome: 'unknown_team',
      }),
    );
  });
});
