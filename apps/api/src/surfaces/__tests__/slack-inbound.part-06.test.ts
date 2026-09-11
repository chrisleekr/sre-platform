import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';
import {
  acceptSurfaceInboundEventTx,
  applySignalObservation,
  applySignalObservationTx,
  createIncident,
  incidentMessages,
  incidentSignals,
  jobs,
  lockCausalGraphTx,
  lockIncidentWorkTx,
  surfaceInboundEvents,
  withTenant,
} from '@sre/db';
import { handleSlackEvent } from '../slack-inbound';
import { createFixture } from './slack-inbound.fixture';

const __fixture = createFixture();

function controlEdit(rootTs: string, editTs: string) {
  return __fixture.rootEvent({
    channel: __fixture.CLS_SUB,
    subtype: 'message_changed',
    event_ts: editTs,
    message: {
      type: 'message',
      subtype: 'bot_message',
      bot_id: 'B_ALERT',
      text: '*Alert:* InfoInhibitor',
      ts: rootTs,
      edited: { ts: editTs },
      attachments: [
        {
          fields: [
            { title: 'Severity', value: 'none' },
            { title: 'Receiver', value: 'null' },
          ],
        },
      ],
    },
  });
}

async function acceptEdit(rootTs: string) {
  return __fixture.admin.db.transaction((tx) =>
    acceptSurfaceInboundEventTx(tx, {
      tenantId: __fixture.tenantB,
      configId: __fixture.classifyConfigId,
      surface: 'slack',
      deliveryKey: `event:control-edit-${randomUUID()}`,
      envelopeType: 'events_api',
      eventType: 'message',
      eventSubtype: 'message_changed',
      channel: __fixture.CLS_SUB,
      externalMessageId: rootTs,
    }),
  );
}

describe('Slack inbound suppression integrity', () => {
  test('commits terminal state before reconciling an incident locked by classification', async () => {
    const rootTs = '1788001800.000100';
    const classificationTs = '1788001805.000100';
    const editTs = '1788001810.000100';
    const incident = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `suppression-lock-order-${randomUUID()}`,
      alertSource: 'slack',
      service: 'monitoring',
      severity: 'sev3',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantB, {
      incidentId: incident.id,
      surface: 'slack',
      channel: __fixture.CLS_SUB,
      externalMessageId: rootTs,
      state: 'firing',
      summary: 'Provider signal awaiting correction.',
      contentHash: 'suppression-lock-order-root',
      eventKey: `slack:${__fixture.CLS_SUB}:${rootTs}:root`,
      eventAt: new Date((Number(rootTs) - 10) * 1000),
      eventVersion: rootTs.replace('.', ''),
    });
    const receipt = await acceptEdit(rootTs);
    let releaseClassification!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseClassification = resolve;
    });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let classificationPid = 0;
    const classification = withTenant(__fixture.app.db, __fixture.tenantB, async (tx) => {
      const [session] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      classificationPid = session!.pid;
      await tx.execute(sql`set local lock_timeout = '1s'`);
      await lockCausalGraphTx(tx, __fixture.tenantB);
      await lockIncidentWorkTx(tx, __fixture.tenantB, [incident.id]);
      markLocked();
      await gate;
      return applySignalObservationTx(tx, __fixture.tenantB, {
        incidentId: incident.id,
        surface: 'slack',
        channel: __fixture.CLS_SUB,
        externalMessageId: rootTs,
        state: 'firing',
        summary: 'Older classification completed late.',
        contentHash: 'suppression-lock-order-late',
        eventKey: `slack:${__fixture.CLS_SUB}:${rootTs}:late`,
        eventAt: new Date(Number(classificationTs) * 1000),
        eventVersion: classificationTs.replace('.', ''),
      });
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await locked;

    const suppression = handleSlackEvent(
      __fixture.classifyDeps,
      __fixture.classifyConfigId,
      __fixture.tenantBConfig(),
      controlEdit(rootTs, editTs),
      { intakeId: receipt.row.id },
    );
    let visibilityFailure: unknown;
    try {
      // Observe reconciliation waiting on our lock before checking its preceding commit.
      await vi.waitFor(
        async () => {
          const [waiting] = await __fixture.admin.sql`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE ${classificationPid} = ANY(pg_blocking_pids(pid))
            ) AS blocked`;
          expect(waiting!.blocked).toBe(true);
        },
        { timeout: 10_000 },
      );
      const [row] = await __fixture.admin.db
        .select({ disposition: surfaceInboundEvents.terminalDisposition })
        .from(surfaceInboundEvents)
        .where(eq(surfaceInboundEvents.id, receipt.row.id));
      expect(row?.disposition).toBe('suppressed_provider_control_notification');
    } catch (error) {
      visibilityFailure = error;
    } finally {
      releaseClassification();
    }

    const classificationResult = await classification;
    const suppressionResult = await suppression;
    if (visibilityFailure) throw visibilityFailure;
    expect(classificationResult).toMatchObject({ cause: { code: 'P2871' } });
    expect(suppressionResult).toBe('suppressed_provider_control_notification');
    await expect(
      __fixture.admin.db
        .select({ state: incidentSignals.state })
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, incident.id)),
    ).resolves.toEqual([{ state: 'resolved' }]);
  }, 15_000);

  test('post-commit Redis failures do not replay durable suppression', async () => {
    const rootTs = '1788001900.000100';
    const editTs = '1788001910.000100';
    const incident = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `suppression-post-commit-${randomUUID()}`,
      alertSource: 'slack',
      service: 'monitoring',
      severity: 'sev3',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantB, {
      incidentId: incident.id,
      surface: 'slack',
      channel: __fixture.CLS_SUB,
      externalMessageId: rootTs,
      state: 'firing',
      summary: 'Provider signal awaiting correction.',
      contentHash: 'suppression-post-commit-root',
      eventKey: `slack:${__fixture.CLS_SUB}:${rootTs}:root`,
      eventAt: new Date((Number(rootTs) - 10) * 1000),
      eventVersion: rootTs.replace('.', ''),
    });
    const receipt = await acceptEdit(rootTs);
    const failure = new Error('Valkey unavailable');
    const publishHub = vi.spyOn(__fixture.hub, 'publishAppended').mockRejectedValue(failure);
    const publishJob = vi.fn(async () => {
      throw failure;
    });
    const onError = vi.fn();
    let hubPublishCount = 0;

    try {
      await expect(
        handleSlackEvent(
          {
            ...__fixture.classifyDeps,
            queue: { ...__fixture.classifyDeps.queue, publishJob },
            onError,
          },
          __fixture.classifyConfigId,
          __fixture.tenantBConfig(),
          controlEdit(rootTs, editTs),
          { intakeId: receipt.row.id },
        ),
      ).resolves.toBe('suppressed_provider_control_notification');
    } finally {
      hubPublishCount = publishHub.mock.calls.length;
      publishHub.mockRestore();
    }

    expect(hubPublishCount).toBe(1);
    expect(publishJob).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(2);
    await expect(
      __fixture.admin.db
        .select({ state: incidentSignals.state })
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, incident.id)),
    ).resolves.toEqual([{ state: 'resolved' }]);
  });

  test('an equal-version retry completes reconciliation after its first transaction fails', async () => {
    const rootTs = '1788002000.000100';
    const editTs = '1788002010.000100';
    const incident = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `suppression-retry-${randomUUID()}`,
      alertSource: 'slack',
      service: 'monitoring',
      severity: 'sev3',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantB, {
      incidentId: incident.id,
      surface: 'slack',
      channel: __fixture.CLS_SUB,
      externalMessageId: rootTs,
      state: 'firing',
      summary: 'Provider signal awaiting correction.',
      contentHash: 'suppression-retry-root',
      eventKey: `slack:${__fixture.CLS_SUB}:${rootTs}:root`,
      eventAt: new Date((Number(rootTs) - 10) * 1000),
      eventVersion: rootTs.replace('.', ''),
    });
    const receipt = await acceptEdit(rootTs);
    const event = controlEdit(rootTs, editTs);
    const reconciliationFailure = new Error('transient reconciliation failure');
    const observeSignal = vi
      .spyOn(__fixture.hub, 'observeSignalTx')
      .mockRejectedValueOnce(reconciliationFailure);
    const deps = { ...__fixture.classifyDeps, queue: __fixture.realQueue };

    try {
      await expect(
        handleSlackEvent(deps, __fixture.classifyConfigId, __fixture.tenantBConfig(), event, {
          intakeId: receipt.row.id,
        }),
      ).rejects.toBe(reconciliationFailure);
      await expect(
        __fixture.admin.db
          .select({ disposition: surfaceInboundEvents.terminalDisposition })
          .from(surfaceInboundEvents)
          .where(eq(surfaceInboundEvents.id, receipt.row.id)),
      ).resolves.toEqual([{ disposition: 'suppressed_provider_control_notification' }]);
      await expect(
        __fixture.admin.db
          .select({ state: incidentSignals.state })
          .from(incidentSignals)
          .where(eq(incidentSignals.incidentId, incident.id)),
      ).resolves.toEqual([{ state: 'firing' }]);

      await expect(
        handleSlackEvent(deps, __fixture.classifyConfigId, __fixture.tenantBConfig(), event, {
          intakeId: receipt.row.id,
        }),
      ).resolves.toBe('suppressed_provider_control_notification');
    } finally {
      observeSignal.mockRestore();
    }

    await expect(
      __fixture.admin.db
        .select({ state: incidentSignals.state })
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, incident.id)),
    ).resolves.toEqual([{ state: 'resolved' }]);
    await expect(
      __fixture.admin.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          sql`${jobs.tenantId} = ${__fixture.tenantB} and ${jobs.type} = 'recovery.verify' and ${jobs.payload}->>'incidentId' = ${incident.id}`,
        ),
    ).resolves.toHaveLength(1);
    await expect(
      __fixture.admin.db
        .select({ id: incidentMessages.id })
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, incident.id)),
    ).resolves.toHaveLength(1);
  });
});
