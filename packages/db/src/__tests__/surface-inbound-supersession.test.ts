import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  acceptSurfaceInboundEventTx,
  applySignalObservationTx,
  cancelSurfaceMessageClassificationsTx,
  createIncident,
  incidents,
  incidentSignals,
  jobs,
  makeDb,
  setSurfaceMessageTerminalDispositionTx,
  surfaceConfigs,
  surfaceInboundEvents,
  tenants,
  withSurfaceInboundMessageLock,
  withSurfaceInboundRoutingFence,
  withTenant,
  type DbHandle,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;

let admin: DbHandle;
let app: DbHandle;
let coordination: DbHandle;
const tenantId = randomUUID();
let configId: string;

async function setTerminal(
  input: Parameters<typeof setSurfaceMessageTerminalDispositionTx>[1],
): Promise<number> {
  return withSurfaceInboundMessageLock(admin.db, input, async (tx) => {
    const result = await setSurfaceMessageTerminalDispositionTx(tx, input);
    return result.updatedCount;
  });
}

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  coordination = makeDb(ADMIN_URL);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'inbound-supersession-test' });
  const configs = await admin.db
    .insert(surfaceConfigs)
    .values({ tenantId, surface: 'slack' })
    .returning({ id: surfaceConfigs.id });
  configId = configs[0]!.id;
});

afterAll(async () => {
  if (admin) await admin.close();
  if (app) await app.close();
  if (coordination) await coordination.close();
});

describe('surface inbound supersession', () => {
  test('treats a missing exact decision version as the end of its millisecond', async () => {
    const externalMessageId = `message-imprecise-${randomUUID()}`;
    const receipt = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId,
        configId,
        surface: 'slack',
        deliveryKey: `event:imprecise-${randomUUID()}`,
        envelopeType: 'events_api',
        eventType: 'message',
        channel: 'C-imprecise',
        externalMessageId,
      }),
    );
    const eventAt = new Date('2026-08-29T00:00:11.000Z');
    const impreciseVersion = BigInt(eventAt.getTime()) * 1000n + 999n;
    const identity = {
      tenantId,
      surface: 'slack',
      channel: 'C-imprecise',
      externalMessageId,
    };

    await expect(
      setTerminal({
        ...identity,
        disposition: 'suppressed_provider_control_notification',
        eventAt,
      }),
    ).resolves.toBe(1);
    await expect(
      withSurfaceInboundRoutingFence(
        admin.db,
        {
          ...identity,
          intakeId: receipt.row.id,
          eventAt,
          eventVersion: String(impreciseVersion - 499n),
        },
        async () => 'must not route',
      ),
    ).resolves.toEqual({ status: 'superseded' });
    await expect(
      admin.db
        .select({ version: surfaceInboundEvents.terminalDispositionEventVersion })
        .from(surfaceInboundEvents)
        .where(eq(surfaceInboundEvents.id, receipt.row.id)),
    ).resolves.toEqual([{ version: Number(impreciseVersion) }]);
  });

  test('a terminal decision cancels older classify work and rejects a rolling old-worker route', async () => {
    const channel = 'C-rolling-guard';
    const externalMessageId = `rolling-guard-${randomUUID()}`;
    const receipt = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId,
        configId,
        surface: 'slack',
        deliveryKey: `event:rolling-guard-${randomUUID()}`,
        envelopeType: 'events_api',
        eventType: 'message',
        channel,
        externalMessageId,
      }),
    );
    const eventAt = new Date('2026-08-29T00:00:12.000Z');
    const terminalVersion = BigInt(eventAt.getTime()) * 1000n + 500n;
    const inserted = await admin.db
      .insert(jobs)
      .values([
        {
          tenantId,
          type: 'classify',
          payload: {
            intakeId: receipt.row.id,
            eventKey: `slack:${channel}:${externalMessageId}:root`,
            channel,
            externalId: externalMessageId,
            eventAt: eventAt.toISOString(),
            eventVersion: String(terminalVersion - 1n),
          },
          status: 'processing',
          stream: 'sre:classify',
        },
        {
          tenantId,
          type: 'classify',
          payload: {
            eventKey: `slack:${channel}:${externalMessageId}:newer`,
            channel,
            externalId: externalMessageId,
            eventAt: eventAt.toISOString(),
            eventVersion: String(terminalVersion + 1n),
          },
          status: 'queued',
          stream: 'sre:classify',
        },
      ])
      .returning({ id: jobs.id });
    let dispositionReady!: () => void;
    let releaseDisposition!: () => void;
    let suppressionBackendPid: number | undefined;
    const ready = new Promise<void>((resolve) => {
      dispositionReady = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseDisposition = resolve;
    });
    const identity = { tenantId, surface: 'slack', channel, externalMessageId };
    const suppression = withSurfaceInboundMessageLock(admin.db, identity, async (tx) => {
      const backend = await tx.execute(sql`select pg_backend_pid()::int as pid`);
      suppressionBackendPid = Number((backend as unknown as Array<{ pid: number }>)[0]!.pid);
      await setSurfaceMessageTerminalDispositionTx(tx, {
        ...identity,
        disposition: 'suppressed_provider_control_notification',
        eventAt,
        eventVersion: String(terminalVersion),
      });
      await cancelSurfaceMessageClassificationsTx(tx, {
        ...identity,
        eventAt,
        eventVersion: String(terminalVersion),
      });
      dispositionReady();
      await release;
    });
    await ready;

    const fingerprint = `rolling-old-worker-${randomUUID()}`;
    let lateRouteBackendPid: number | undefined;
    let markLateRouteEntered!: () => void;
    const lateRouteEntered = new Promise<void>((resolve) => {
      markLateRouteEntered = resolve;
    });
    let lateRouteSettled = false;
    const lateRoute = withTenant(app.db, tenantId, async (tx) => {
      const backend = await tx.execute(sql`select pg_backend_pid()::int as pid`);
      lateRouteBackendPid = Number((backend as unknown as Array<{ pid: number }>)[0]!.pid);
      markLateRouteEntered();
      const incident = await createIncident(tx, tenantId, {
        fingerprint,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      });
      await applySignalObservationTx(tx, tenantId, {
        incidentId: incident.id,
        surface: 'slack',
        channel,
        externalMessageId,
        state: 'firing',
        summary: 'Older root finished after its terminal edit.',
        contentHash: 'rolling-old-worker',
        eventKey: `slack:${channel}:${externalMessageId}:root`,
        eventAt,
        eventVersion: String(terminalVersion - 1n),
      });
      return incident.id;
    })
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => {
        lateRouteSettled = true;
      });
    await lateRouteEntered;
    let waitFailure: unknown;
    try {
      await expect
        .poll(async () => {
          const blockers = await admin.sql<Array<{ blockers: number[] }>>`
          SELECT pg_blocking_pids(${lateRouteBackendPid!}) AS blockers
        `;
          return blockers[0]!.blockers;
        })
        .toContain(suppressionBackendPid);
      expect(lateRouteSettled).toBe(false);
    } catch (error) {
      waitFailure = error;
    }
    releaseDisposition();
    await suppression;

    await expect(lateRoute).resolves.toMatchObject({ cause: { code: 'P2871' } });
    if (waitFailure) throw waitFailure;
    await expect(
      admin.db
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.fingerprint, fingerprint)),
    ).resolves.toEqual([]);
    await expect(
      admin.db
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(sql`id in (${inserted[0]!.id}, ${inserted[1]!.id})`)
        .orderBy(jobs.id),
    ).resolves.toEqual(
      [
        { id: inserted[0]!.id, status: 'done' },
        { id: inserted[1]!.id, status: 'queued' },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    await admin.db.delete(jobs).where(sql`id in (${inserted[0]!.id}, ${inserted[1]!.id})`);
  });

  test('the routing fence reports superseded when a terminal edit wins during its callback', async () => {
    const channel = 'C-routing-race';
    const externalMessageId = `routing-race-${randomUUID()}`;
    const receipt = await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId,
        configId,
        surface: 'slack',
        deliveryKey: `event:routing-race-${randomUUID()}`,
        envelopeType: 'events_api',
        eventType: 'message',
        channel,
        externalMessageId,
      }),
    );
    const eventAt = new Date('2026-08-29T00:00:13.000Z');
    const rootVersion = BigInt(eventAt.getTime()) * 1000n + 100n;
    let callbackReady!: () => void;
    let writeSignal!: () => void;
    const ready = new Promise<void>((resolve) => {
      callbackReady = resolve;
    });
    const allowed = new Promise<void>((resolve) => {
      writeSignal = resolve;
    });
    const identity = { tenantId, surface: 'slack', channel, externalMessageId };
    const fingerprint = `routing-race-${randomUUID()}`;
    const routed = withSurfaceInboundRoutingFence(
      coordination.db,
      {
        ...identity,
        intakeId: receipt.row.id,
        eventAt,
        eventVersion: String(rootVersion),
      },
      async () => {
        callbackReady();
        await allowed;
        return withTenant(app.db, tenantId, async (tx) => {
          const incident = await createIncident(tx, tenantId, {
            fingerprint,
            alertSource: 'slack',
            service: 'checkout',
            severity: 'sev2',
          });
          await applySignalObservationTx(tx, tenantId, {
            incidentId: incident.id,
            surface: 'slack',
            channel,
            externalMessageId,
            state: 'firing',
            summary: 'Root route lost a race with its terminal edit.',
            contentHash: 'routing-race',
            eventKey: `slack:${channel}:${externalMessageId}:root`,
            eventAt,
            eventVersion: String(rootVersion),
          });
          return incident.id;
        });
      },
    );
    await ready;
    await withSurfaceInboundMessageLock(admin.db, identity, (tx) =>
      setSurfaceMessageTerminalDispositionTx(tx, {
        ...identity,
        disposition: 'suppressed_provider_control_notification',
        eventAt,
        eventVersion: String(rootVersion + 1n),
      }),
    );
    writeSignal();

    await expect(routed).resolves.toEqual({ status: 'superseded' });
    await expect(
      admin.db
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.fingerprint, fingerprint)),
    ).resolves.toEqual([]);
  });

  test('the terminal guard rejects cross-tenant writes before inspecting message state', async () => {
    const otherTenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: otherTenantId, name: 'terminal guard tenant' });
    const [otherConfig] = await admin.db
      .insert(surfaceConfigs)
      .values({ tenantId: otherTenantId, surface: 'slack' })
      .returning({ id: surfaceConfigs.id });
    const channel = 'C-cross-tenant-guard';
    const terminalMessageId = `terminal-${randomUUID()}`;
    const absentMessageId = `absent-${randomUUID()}`;
    const eventAt = new Date('2026-08-29T00:00:14.000Z');
    const incident = await createIncident(admin.db, otherTenantId, {
      fingerprint: `cross-tenant-guard-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId: otherTenantId,
        configId: otherConfig!.id,
        surface: 'slack',
        deliveryKey: `event:cross-tenant-${randomUUID()}`,
        envelopeType: 'events_api',
        eventType: 'message_changed',
        channel,
        externalMessageId: terminalMessageId,
      }),
    );
    await setTerminal({
      tenantId: otherTenantId,
      surface: 'slack',
      channel,
      externalMessageId: terminalMessageId,
      disposition: 'suppressed_provider_control_notification',
      eventAt,
    });

    try {
      for (const externalMessageId of [terminalMessageId, absentMessageId]) {
        const failure = await withTenant(app.db, tenantId, (tx) =>
          tx.insert(incidentSignals).values({
            tenantId: otherTenantId,
            incidentId: incident.id,
            surface: 'slack',
            channel,
            externalMessageId,
            state: 'firing',
            lastEventType: 'opened',
            summary: 'Cross-tenant write must fail before terminal lookup.',
            contentHash: randomUUID(),
            lastEventKey: `cross-tenant:${randomUUID()}`,
            lastEventAt: eventAt,
            firstSeenAt: eventAt,
            lastSeenAt: eventAt,
          }),
        ).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({ cause: { code: '42501' } });
      }
    } finally {
      await admin.db
        .delete(surfaceInboundEvents)
        .where(eq(surfaceInboundEvents.tenantId, otherTenantId));
      await admin.db.delete(incidents).where(eq(incidents.tenantId, otherTenantId));
      await admin.db.delete(surfaceConfigs).where(eq(surfaceConfigs.tenantId, otherTenantId));
      await admin.db.delete(tenants).where(eq(tenants.id, otherTenantId));
    }
  });
});
