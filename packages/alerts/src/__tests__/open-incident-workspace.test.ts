import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  incidentMessages,
  incidentSignals,
  incidents,
  investigationSubjects,
  jobs,
  makeDb,
  surfaceBindings,
  tenants,
  type DbHandle,
} from '@sre/db';
import { Queue } from '@sre/queue';
import { openIncidentWorkspace } from '../open-incident-workspace';
import {
  platformSubjectFingerprint,
  platformSubjectSignalExternalId,
} from '../platform-subject-identity';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;
const VALKEY_URL = process.env.VALKEY_URL!;

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let queue: Queue;
let tenantId: string;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
  queue = new Queue(admin.db, redis);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Workspace opener tests' });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(jobs).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidentMessages).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidentSignals).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(investigationSubjects).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(surfaceBindings).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.close();
  }
  if (app) await app.close();
  if (redis) await redis.quit();
});

function input() {
  const subjectId = `argocd/argocd-server-${randomUUID()}`;
  return {
    tenantId,
    source: 'platform',
    service: 'argocd',
    severity: 'sev3',
    title: 'Argo CD pod restarted after OOM kill',
    subject: {
      kind: 'infrastructure_resource' as const,
      sourceId: '00000000-0000-4000-8000-000000000281',
      subjectId,
      sourcePath: '/infrastructure',
      state: 'firing' as const,
      summary: 'Running and ready, one prior OOMKilled termination',
      observedAt: new Date('2026-08-28T00:00:00.000Z'),
      snapshot: {
        kind: 'pod',
        namespace: 'argocd',
        phase: 'Running',
        ready: true,
        restartCount: 1,
        reasons: ['OOMKilled'],
      },
    },
  };
}

const requestFingerprint = (request: ReturnType<typeof input>) =>
  platformSubjectFingerprint({
    kind: request.subject.kind,
    sourceId: request.subject.sourceId,
    subjectId: request.subject.subjectId,
  });

const countForFingerprint = async (fingerprint: string) => {
  const [row] = await admin.db.execute<{ count: string }>(
    sql`select count(*)::text as count from incidents where tenant_id = ${tenantId} and fingerprint = ${fingerprint}`,
  );
  return Number(row!.count);
};

describe('openIncidentWorkspace', () => {
  test('atomically creates the canonical subject-backed workspace and one triage job', async () => {
    const request = input();
    const fingerprint = requestFingerprint(request);
    const startedAt = Date.now();
    const result = await openIncidentWorkspace({ appDb: app.db, queue }, request);

    expect(result).toMatchObject({
      outcome: 'created',
      incidentId: expect.any(String),
      jobId: expect.any(String),
      bindingId: null,
    });

    const [subjectRows, signalRows, messageRows, jobRows, syncRows] = await Promise.all([
      admin.db
        .select()
        .from(investigationSubjects)
        .where(sql`tenant_id = ${tenantId} and incident_id = ${result.incidentId}`),
      admin.db
        .select()
        .from(incidentSignals)
        .where(sql`tenant_id = ${tenantId} and incident_id = ${result.incidentId}`),
      admin.db
        .select()
        .from(incidentMessages)
        .where(sql`tenant_id = ${tenantId} and incident_id = ${result.incidentId}`),
      admin.db
        .select()
        .from(jobs)
        .where(sql`id = ${result.jobId}`),
      admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${tenantId} and type = 'subject.sync' and payload->>'incidentId' = ${result.incidentId}`,
        ),
    ]);
    expect(subjectRows).toHaveLength(1);
    expect(subjectRows[0]).toMatchObject({
      kind: 'infrastructure_resource',
      sourceId: request.subject.sourceId,
      subjectId: request.subject.subjectId,
      fingerprint,
    });
    expect(signalRows).toHaveLength(1);
    const contentHash = signalRows[0]!.contentHash;
    expect(contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(signalRows[0]).toMatchObject({
      provider: 'platform',
      providerFingerprint: null,
      surface: 'dashboard',
      channel: request.subject.sourcePath,
      externalMessageId: platformSubjectSignalExternalId(fingerprint, result.incidentId),
      state: 'firing',
      lastEventType: 'opened',
      materialHash: contentHash,
    });
    expect(messageRows.map((row) => row.kind)).toEqual(
      expect.arrayContaining(['lifecycle', 'text']),
    );
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({ type: 'triage', status: 'queued' });
    expect(jobRows[0]!.payload).toMatchObject({
      incidentId: result.incidentId,
      fingerprint,
      signalMaterials: [
        { signalId: signalRows[0]!.id, signalVersion: 1, materialHash: contentHash },
      ],
    });
    expect(syncRows).toHaveLength(1);
    expect(syncRows[0]).toMatchObject({
      type: 'subject.sync',
      status: 'queued',
      stream: 'sre:jobs',
    });
    expect(syncRows[0]!.availableAt.getTime()).toBeGreaterThanOrEqual(startedAt + 4 * 60_000);
  });

  test('preserves exact valid subject identities and rejects DEL without mutation', async () => {
    const request = input();
    request.subject.sourceId = ' topology ';
    request.subject.subjectId = ' checkout ';
    const opened = await openIncidentWorkspace({ appDb: app.db, queue }, request);
    const [stored] = await admin.db
      .select()
      .from(investigationSubjects)
      .where(eq(investigationSubjects.incidentId, opened.incidentId));
    expect(stored).toMatchObject({ sourceId: ' topology ', subjectId: ' checkout ' });

    const invalid = input();
    invalid.subject.subjectId = `invalid\u007fsubject`;
    const fingerprint = requestFingerprint(invalid);
    await expect(openIncidentWorkspace({ appDb: app.db, queue }, invalid)).rejects.toThrow(
      'investigation subject identity is invalid',
    );
    expect(await countForFingerprint(fingerprint)).toBe(0);
  });

  test('returns the active workspace without another subject, opener, signal, or job', async () => {
    const request = input();
    const created = await openIncidentWorkspace({ appDb: app.db, queue }, request);
    const existing = await openIncidentWorkspace({ appDb: app.db, queue }, request);

    expect(existing).toEqual({
      outcome: 'existing',
      incidentId: created.incidentId,
      jobId: null,
      bindingId: null,
    });
    const [subjects, signals, messages, triageJobs] = await Promise.all([
      admin.db
        .select()
        .from(investigationSubjects)
        .where(sql`tenant_id = ${tenantId} and incident_id = ${created.incidentId}`),
      admin.db
        .select()
        .from(incidentSignals)
        .where(sql`tenant_id = ${tenantId} and incident_id = ${created.incidentId}`),
      admin.db
        .select()
        .from(incidentMessages)
        .where(sql`tenant_id = ${tenantId} and incident_id = ${created.incidentId}`),
      admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${tenantId} and type = 'triage' and payload->>'incidentId' = ${created.incidentId}`,
        ),
    ]);
    expect(subjects).toHaveLength(1);
    expect(signals).toHaveLength(1);
    expect(messages.map((row) => row.kind).sort()).toEqual(['lifecycle', 'text']);
    expect(triageJobs).toHaveLength(1);
  });

  test('opens one workspace with every distinct signal from a grouped delivery', async () => {
    const fingerprint = `slack-group-${randomUUID()}`;
    const observedAt = new Date('2026-08-29T00:00:00.000Z');
    const result = await openIncidentWorkspace(
      { appDb: app.db, queue },
      {
        tenantId,
        source: 'slack',
        fingerprint,
        service: 'checkout',
        severity: 'sev2',
        title: 'Grouped checkout alerts',
        signals: [
          {
            surface: 'slack',
            channel: 'C1',
            externalMessageId: '1.1#latency',
            state: 'firing',
            summary: 'Checkout latency high',
            contentHash: 'latency-hash',
            eventKey: 'event:latency',
            eventAt: observedAt,
            provider: 'prometheus-alertmanager',
            alertName: 'Checkout latency high',
          },
          {
            surface: 'slack',
            channel: 'C1',
            externalMessageId: '1.1#errors',
            state: 'firing',
            summary: 'Checkout errors high',
            contentHash: 'errors-hash',
            eventKey: 'event:errors',
            eventAt: observedAt,
            provider: 'prometheus-alertmanager',
            alertName: 'Checkout errors high',
          },
        ],
      },
    );

    const signals = await admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, result.incidentId));
    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.alertName).sort()).toEqual([
      'Checkout errors high',
      'Checkout latency high',
    ]);
  });

  test('rolls back every workspace record when the transactional job insert fails', async () => {
    const request = input();
    request.subject.subjectId = `argocd/rollback-${randomUUID()}`;
    const failingQueue = {
      insertJobTx: vi.fn(async () => {
        throw new Error('queue insert failed');
      }),
      publishJob: vi.fn(),
    };

    await expect(
      openIncidentWorkspace({ appDb: app.db, queue: failingQueue as unknown as Queue }, request),
    ).rejects.toThrow('queue insert failed');

    const fingerprint = requestFingerprint(request);
    expect(await countForFingerprint(fingerprint)).toBe(0);
    const [subjects, signals, messages, queued] = await Promise.all([
      admin.db
        .select()
        .from(investigationSubjects)
        .where(sql`tenant_id = ${tenantId} and subject_id = ${request.subject.subjectId}`),
      admin.db
        .select({ id: incidentSignals.id })
        .from(incidentSignals)
        .innerJoin(incidents, eq(incidents.id, incidentSignals.incidentId))
        .where(and(eq(incidents.tenantId, tenantId), eq(incidents.fingerprint, fingerprint))),
      admin.db
        .select({ id: incidentMessages.id })
        .from(incidentMessages)
        .innerJoin(incidents, eq(incidents.id, incidentMessages.incidentId))
        .where(and(eq(incidents.tenantId, tenantId), eq(incidents.fingerprint, fingerprint))),
      admin.db
        .select()
        .from(jobs)
        .where(sql`tenant_id = ${tenantId} and payload->>'fingerprint' = ${fingerprint}`),
    ]);
    expect(subjects).toHaveLength(0);
    expect(signals).toHaveLength(0);
    expect(messages).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  test('rolls back the full workspace when delayed subject synchronization cannot be inserted', async () => {
    const request = input();
    request.subject.subjectId = `argocd/sync-rollback-${randomUUID()}`;
    const failingQueue = {
      insertJobTx: queue.insertJobTx.bind(queue),
      insertSubjectSyncTx: vi.fn(async () => {
        throw new Error('subject sync insert failed');
      }),
      publishJob: vi.fn(),
    };

    await expect(
      openIncidentWorkspace({ appDb: app.db, queue: failingQueue as unknown as Queue }, request),
    ).rejects.toThrow('subject sync insert failed');

    const fingerprint = requestFingerprint(request);
    expect(await countForFingerprint(fingerprint)).toBe(0);
    expect(
      await admin.db
        .select()
        .from(jobs)
        .where(sql`tenant_id = ${tenantId} and payload->>'fingerprint' = ${fingerprint}`),
    ).toHaveLength(0);
  });

  test('rejects an oversized subject snapshot and rolls back the incident', async () => {
    const request = input();
    request.subject.subjectId = `argocd/oversized-${randomUUID()}`;
    request.subject.snapshot = { ...request.subject.snapshot, reasons: ['x'.repeat(9_000)] };

    await expect(openIncidentWorkspace({ appDb: app.db, queue }, request)).rejects.toThrow(
      'investigation subject snapshot exceeds the allowed size',
    );

    expect(await countForFingerprint(requestFingerprint(request))).toBe(0);
  });
});
