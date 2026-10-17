import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { incidentSignals, incidents } from '@sre/db';
import {
  CHANNEL,
  PRODUCER,
  admin,
  disposition,
  foreignTenantId,
  handler,
  job,
  reportMessages,
  resolvedCandidate,
  trackedIncident,
  useRecoveryFixture,
} from './recovery-report.fixture';

useRecoveryFixture();

describe('Slack recovery notices', () => {
  test('an Alertmanager edit links by its exact Slack root and records root scope', async () => {
    const tracked = await trackedIncident(`slack:monitor-${randomUUID()}`);
    const { handle, onOutcome } = handler();
    const candidate = resolvedCandidate('unused', {
      externalId: tracked.root,
      eventKey: `slack:${CHANNEL}:${tracked.root}:edit:2:producer:${PRODUCER}`,
      isEdit: true,
      observations: undefined,
    });

    await handle(job(candidate));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_reported' }),
    );
    expect(await reportMessages(tracked.incidentId)).toHaveLength(1);
    // Root scope lets the workspace cover every alert the edited message carried.
    expect(await disposition(candidate.eventKey)).toEqual([
      expect.objectContaining({
        correlationDecision: 'recovery_reported_root',
        correlatedSignalId: tracked.signalId,
      }),
    ]);
  });

  test('an edit that opens firing and lists a resolved alert records signal scope', async () => {
    const tracked = await trackedIncident(`slack:monitor-${randomUUID()}`);
    const { handle } = handler();
    const text = '[FIRING:1] Checkout latency is high.\nResolved: Checkout error rate is high.';
    const candidate = resolvedCandidate('unused', {
      externalId: tracked.root,
      eventKey: `slack:${CHANNEL}:${tracked.root}:edit:2:producer:${PRODUCER}`,
      isEdit: true,
      text,
      contentHash: createHash('sha256').update(text).digest('hex'),
      observations: undefined,
    });

    await handle(job(candidate));

    expect(await disposition(candidate.eventKey)).toEqual([
      expect.objectContaining({
        correlationDecision: 'recovery_reported',
        correlatedSignalId: tracked.signalId,
      }),
    ]);
  });

  test('the link and message do not depend on disposition recording', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    const { handle, onOutcome } = handler(false);
    const candidate = resolvedCandidate(monitorKey);

    await handle(job(candidate));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_reported' }),
    );
    expect(await reportMessages(tracked.incidentId)).toHaveLength(1);
    expect(await disposition(candidate.eventKey)).toEqual([]);
  });

  test.each([
    { name: 'no open signal carries the monitor', incidents: 0 },
    { name: 'two open incidents carry the monitor', incidents: 2 },
  ])('an ambiguous notice stays unmatched when $name', async ({ incidents: count }) => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await Promise.all(
      Array.from({ length: count }, () => trackedIncident(monitorKey)),
    );
    const { handle, onOutcome } = handler();
    const candidate = resolvedCandidate(monitorKey);

    await handle(job(candidate));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
    for (const item of tracked) expect(await reportMessages(item.incidentId)).toEqual([]);
    expect(await disposition(candidate.eventKey)).toEqual([
      expect.objectContaining({ disposition: 'log', correlatedIncidentId: null }),
    ]);
  });

  test('a notice for an already resolved incident is not linked', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    await admin.db
      .update(incidents)
      .set({ status: 'resolved' })
      .where(eq(incidents.id, tracked.incidentId));
    const { handle, onOutcome } = handler();

    await handle(job(resolvedCandidate(monitorKey)));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
    expect(await reportMessages(tracked.incidentId)).toEqual([]);
  });

  test.each([
    { name: 'new message', edit: false },
    { name: 'root edit', edit: true },
  ])('a $name from another producer is not linked', async ({ edit }) => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    const { handle, onOutcome } = handler();
    const other = 'bot:B_OTHER';
    const candidate = resolvedCandidate(monitorKey, {
      producerId: other,
      eventKey: `slack:${CHANNEL}:${randomUUID()}:producer:${other}`,
      ...(edit ? { externalId: tracked.root, isEdit: true } : {}),
    });

    await handle(job(candidate));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
    expect(await reportMessages(tracked.incidentId)).toEqual([]);
  });

  test.each([
    { name: 'new message', edit: false },
    { name: 'root edit', edit: true },
  ])("a $name never links to another tenant's incident", async ({ edit }) => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const foreign = await trackedIncident(monitorKey, undefined, foreignTenantId);
    const foreignSignals = () =>
      admin.db
        .select({ id: incidentSignals.id, state: incidentSignals.state })
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, foreign.incidentId));
    const signalsBefore = await foreignSignals();
    const { handle, onOutcome } = handler();
    const candidate = resolvedCandidate(
      monitorKey,
      edit
        ? {
            externalId: foreign.root,
            eventKey: `slack:${CHANNEL}:${foreign.root}:edit:2:producer:${PRODUCER}`,
            isEdit: true,
            observations: undefined,
          }
        : {},
    );

    await handle(job(candidate));

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_unmatched' }),
    );
    expect(await reportMessages(foreign.incidentId)).toEqual([]);
    await expect(foreignSignals()).resolves.toEqual(signalsBefore);
    expect(await disposition(candidate.eventKey)).toEqual([
      expect.objectContaining({ correlatedIncidentId: null, correlatedSignalId: null }),
    ]);
  });
});
