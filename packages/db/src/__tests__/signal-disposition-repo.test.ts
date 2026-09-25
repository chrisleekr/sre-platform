import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  makeDb,
  acknowledgeSignalPrompt,
  claimDueSignalPrompts,
  applySignalObservation,
  createIncident,
  incidentSignals,
  incidents,
  isActionableSignalTicket,
  listProviderRecoveryReports,
  listSignalDispositions,
  PROVIDER_RECOVERY_REPORT_DECISION,
  PROVIDER_RECOVERY_REPORT_ROOT_DECISION,
  listSignalDispositionPage,
  markSignalEffectiveDisposition,
  recordSignalDisposition,
  setTenantSignalPolicy,
  releaseSignalPrompt,
  startSignalReview,
  signalDispositions,
  sweepExpiredSignalDispositions,
  tenantSignalPolicies,
  tenants,
  type DbHandle,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;

let admin: DbHandle;
let app: DbHandle;
const tenantA = randomUUID();
const tenantB = randomUUID();

const input = (eventKey: string, disposition: 'investigate' | 'ticket' | 'log' = 'ticket') => ({
  source: 'slack',
  sourceEventKey: eventKey,
  sourceEventAt: new Date(),
  signalKey: `slack:C-SIGNALS:${eventKey.split(':').at(-1)}`,
  surface: 'slack',
  channel: 'C-SIGNALS',
  threadId: eventKey.split(':').at(-1)!,
  summary: 'Credential [REDACTED] appeared in a provider alert.',
  reason: 'A real but nonurgent reliability risk.',
  service: 'checkout',
  severity: 'sev3',
  disposition,
  ticket:
    disposition === 'ticket'
      ? {
          action: 'Review the provider alert.',
          safeDeferralReason: 'No current user impact is established.',
          riskIfIgnored: 'The degradation may become customer-visible.',
          reviewHorizonMinutes: 120,
        }
      : null,
});

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'signal-disposition-a' },
    { id: tenantB, name: 'signal-disposition-b' },
  ]);
});

afterAll(async () => {
  if (admin) {
    if (signalDispositions)
      await admin.db.delete(signalDispositions).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    if (tenantSignalPolicies)
      await admin.db.delete(tenantSignalPolicies).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidentSignals).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('signal disposition repository', () => {
  test('enforces tenant RLS and same-event idempotency', async () => {
    const eventKey = `slack:C-SIGNALS:${randomUUID()}`;
    const first = await recordSignalDisposition(app.db, tenantA, input(eventKey));
    const duplicate = await recordSignalDisposition(app.db, tenantA, input(eventKey));
    await recordSignalDisposition(app.db, tenantB, input(`slack:C-SIGNALS:${randomUUID()}`, 'log'));

    expect(duplicate.id).toBe(first.id);
    await expect(listSignalDispositions(app.db, tenantA, { limit: 50 })).resolves.toEqual([
      expect.objectContaining({ id: first.id, tenantId: tenantA, disposition: 'ticket' }),
    ]);
    await expect(listSignalDispositions(app.db, tenantB, { limit: 50 })).resolves.toEqual([
      expect.objectContaining({ tenantId: tenantB, disposition: 'log' }),
    ]);
  });

  test('retains a bounded projection instead of rejecting a valid long signal', async () => {
    const created = await recordSignalDisposition(app.db, tenantA, {
      ...input(`slack:C-SIGNALS:${randomUUID()}`),
      summary: `Long provider observation ${'x'.repeat(20_000)}`,
    });
    expect(created.summary).toHaveLength(2_000);
    expect(created.summary).toMatch(/^Long provider observation/);
  });

  test('persists only the scrubbed bounded record, never an extra raw candidate', async () => {
    const rawMarker = `RAW-SECRET-${randomUUID()}`;
    const created = await recordSignalDisposition(app.db, tenantA, {
      ...input(`slack:C-SIGNALS:${randomUUID()}`),
      raw: { token: rawMarker },
    } as Parameters<typeof recordSignalDisposition>[2]);
    const rows = await admin.db
      .select()
      .from(signalDispositions)
      .where(eq(signalDispositions.id, created.id));

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain('[REDACTED]');
    expect(JSON.stringify(rows[0])).not.toContain(rawMarker);
    const columns = await admin.db.execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'signal_dispositions'
    `);
    expect([...columns].map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(['raw', 'candidate', 'payload']),
    );
  });

  test('scrubs common credentials from every free-form persisted field', async () => {
    const privateKey =
      '-----BEGIN PRIVATE KEY-----\nplain-private-material\n-----END PRIVATE KEY-----';
    const created = await recordSignalDisposition(app.db, tenantA, {
      ...input(`slack:C-SIGNALS:${randomUUID()}`),
      summary: 'password=hunter2',
      reason: 'postgres://alice:secret@db.example/app',
      proposedTitle: privateKey,
      ticket: {
        action: 'rotate password=hunter2',
        safeDeferralReason: 'postgres://alice:secret@db.example/app is reachable',
        riskIfIgnored: privateKey,
        reviewHorizonMinutes: 60,
      },
    });
    const persisted = JSON.stringify(created);
    for (const secret of ['hunter2', 'alice:secret', 'plain-private-material'])
      expect(persisted).not.toContain(secret);
    expect(persisted).toContain('[REDACTED]');
  });

  test('records the effective legacy-safe decision beside a shadow proposal', async () => {
    const eventKey = `slack:C-SIGNALS:${randomUUID()}`;
    const created = await recordSignalDisposition(app.db, tenantA, {
      ...input(eventKey),
      classificationMode: 'shadow',
    });
    await expect(
      markSignalEffectiveDisposition(app.db, tenantA, 'slack', eventKey, 'investigate'),
    ).resolves.toEqual(
      expect.objectContaining({ id: created.id, effectiveDisposition: 'investigate' }),
    );
    await expect(
      markSignalEffectiveDisposition(app.db, tenantB, 'slack', eventKey, 'log'),
    ).resolves.toBeNull();
  });

  test('never exposes a shadow or existing-incident-correlated ticket as promotable', async () => {
    const shadow = await recordSignalDisposition(
      app.db,
      tenantA,
      input(`slack:C-SIGNALS:${randomUUID()}`),
    );
    expect(isActionableSignalTicket(shadow)).toBe(false);

    const incident = await createIncident(app.db, tenantA, {
      fingerprint: `signal-ticket-target-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const correlated = await recordSignalDisposition(app.db, tenantA, {
      ...input(`slack:C-SIGNALS:${randomUUID()}`),
      classificationMode: 'enforce',
      effectiveDisposition: 'ticket',
      correlationDecision: 'belongs_to',
      correlatedIncidentId: incident.id,
    });
    expect(isActionableSignalTicket(correlated)).toBe(false);
    await expect(startSignalReview(app.db, tenantA, correlated.id)).resolves.toBeNull();
  });

  test('lists only current recovery reports linked to the incident, under tenant RLS', async () => {
    const incident = await createIncident(app.db, tenantA, {
      fingerprint: `recovery-report-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const observed = await applySignalObservation(app.db, tenantA, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-SIGNALS',
      externalMessageId: `root-${randomUUID()}`,
      state: 'unknown',
      summary: 'Checkout error rate is high.',
      contentHash: 'recovery-report-content',
      eventKey: `slack:C-SIGNALS:${randomUUID()}:producer:bot:B1`,
      eventAt: new Date('2026-09-20T00:00:00.000Z'),
    });
    const signalKey = `slack:monitor-${randomUUID()}`;
    const reportedAt = new Date('2026-09-20T00:05:00.000Z');
    const linked = (eventKey: string, sourceEventAt: Date, correlationDecision: string) => ({
      ...input(eventKey, 'log'),
      signalKey,
      sourceEventAt,
      correlationDecision,
      correlatedIncidentId: incident.id,
      correlatedSignalId: observed.signal.id,
    });
    await recordSignalDisposition(
      app.db,
      tenantA,
      linked(`slack:C-SIGNALS:${randomUUID()}`, reportedAt, 'recovery_reported'),
    );
    await recordSignalDisposition(app.db, tenantA, {
      ...linked(`slack:C-SIGNALS:${randomUUID()}`, reportedAt, 'belongs_to'),
      signalKey: `slack:other-${randomUUID()}`,
    });

    await expect(listProviderRecoveryReports(app.db, tenantA, incident.id)).resolves.toEqual([
      { signalId: observed.signal.id, reportedAt },
    ]);
    await expect(listProviderRecoveryReports(app.db, tenantB, incident.id)).resolves.toEqual([]);

    // A later event for the same monitor supersedes the report, so it no longer reads as recovered.
    await recordSignalDisposition(
      app.db,
      tenantA,
      linked(`slack:C-SIGNALS:${randomUUID()}`, new Date('2026-09-20T00:10:00.000Z'), 'belongs_to'),
    );
    await expect(listProviderRecoveryReports(app.db, tenantA, incident.id)).resolves.toEqual([]);
  });

  const groupedIncident = async () => {
    const incident = await createIncident(app.db, tenantA, {
      fingerprint: `recovery-group-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const observe = (
      externalMessageId: string,
      channel = 'C-SIGNALS',
      eventAt = new Date('2026-09-20T00:00:00.000Z'),
    ) =>
      applySignalObservation(app.db, tenantA, {
        incidentId: incident.id,
        surface: 'slack',
        channel,
        externalMessageId,
        state: 'unknown',
        summary: 'Checkout error rate is high.',
        contentHash: `content-${externalMessageId}`,
        eventKey: `slack:${channel}:${externalMessageId}:producer:bot:B1`,
        eventAt,
      });
    const reportedAt = new Date('2026-09-20T00:05:00.000Z');
    const report = (correlatedSignalId: string, correlationDecision: string) =>
      recordSignalDisposition(app.db, tenantA, {
        ...input(`slack:C-SIGNALS:${randomUUID()}`, 'log'),
        signalKey: `slack:monitor-${randomUUID()}`,
        sourceEventAt: reportedAt,
        correlationDecision,
        correlatedIncidentId: incident.id,
        correlatedSignalId,
      });
    const covered = async () =>
      (await listProviderRecoveryReports(app.db, tenantA, incident.id)).map((row) => row.signalId);
    return { incident, observe, reportedAt, report, covered };
  };

  test('an edit-scoped report covers the active signals of its Slack message, not those of another message', async () => {
    const { incident, observe, reportedAt, report } = await groupedIncident();
    const root = `grouped-${randomUUID()}`;
    const first = await observe(`${root}#alert-a`);
    const second = await observe(`${root}#alert-b`);
    const otherMessage = await observe(`other-${randomUUID()}#alert-a`);
    const otherChannel = await observe(`${root}#alert-c`, 'C-ELSEWHERE');
    await report(first.signal.id, PROVIDER_RECOVERY_REPORT_ROOT_DECISION);

    const covered = await listProviderRecoveryReports(app.db, tenantA, incident.id);

    expect(covered.map((row) => row.signalId).sort()).toEqual(
      [first.signal.id, second.signal.id].sort(),
    );
    expect(covered.every((row) => row.reportedAt.getTime() === reportedAt.getTime())).toBe(true);
    expect(covered.map((row) => row.signalId)).not.toContain(otherMessage.signal.id);
    expect(covered.map((row) => row.signalId)).not.toContain(otherChannel.signal.id);
  });

  test('a report from a new message covers only its linked signal, not a sibling of the original message', async () => {
    const { observe, report, covered } = await groupedIncident();
    const root = `grouped-${randomUUID()}`;
    const first = await observe(`${root}#alert-a`);
    await observe(`${root}#alert-b`);
    await report(first.signal.id, PROVIDER_RECOVERY_REPORT_DECISION);

    await expect(covered()).resolves.toEqual([first.signal.id]);
  });

  test('an edit-scoped report does not cover a sibling that re-fired after it or is already resolved', async () => {
    const { observe, report, covered } = await groupedIncident();
    const root = `grouped-${randomUUID()}`;
    const first = await observe(`${root}#alert-a`);
    const refired = await observe(
      `${root}#alert-b`,
      'C-SIGNALS',
      new Date('2026-09-20T00:10:00.000Z'),
    );
    const resolved = await observe(`${root}#alert-c`);
    await admin.db
      .update(incidentSignals)
      .set({ state: 'resolved' })
      .where(eq(incidentSignals.id, resolved.signal.id));
    await report(first.signal.id, PROVIDER_RECOVERY_REPORT_ROOT_DECISION);

    const ids = await covered();

    expect(ids).toContain(first.signal.id);
    expect(ids).not.toContain(refired.signal.id);
    expect(ids).not.toContain(resolved.signal.id);
  });

  test('a later event on the same Slack message retires an edit-scoped report, one on another message does not', async () => {
    const { incident, observe, reportedAt, covered } = await groupedIncident();
    const root = `grouped-${randomUUID()}`;
    const first = await observe(`${root}#alert-a`);
    const second = await observe(`${root}#alert-b`);
    // Slack versions are microsecond timestamps, so they order the edits exactly as their times do.
    const onMessage = (
      threadId: string,
      signalKey: string,
      sourceEventAt: Date,
      extra: Partial<Parameters<typeof recordSignalDisposition>[2]> = {},
    ) =>
      recordSignalDisposition(app.db, tenantA, {
        ...input(`slack:C-SIGNALS:${randomUUID()}`, 'log'),
        threadId,
        signalKey,
        sourceEventAt,
        sourceEventVersion: String(sourceEventAt.getTime() * 1000),
        ...extra,
      });
    await onMessage(root, `slack:monitor-a-${randomUUID()}`, reportedAt, {
      correlationDecision: PROVIDER_RECOVERY_REPORT_ROOT_DECISION,
      correlatedIncidentId: incident.id,
      correlatedSignalId: first.signal.id,
    });
    await onMessage(
      `other-${randomUUID()}`,
      `slack:monitor-x-${randomUUID()}`,
      new Date('2026-09-20T00:07:00.000Z'),
    );

    expect((await covered()).sort()).toEqual([first.signal.id, second.signal.id].sort());

    // The message was edited back to firing and its first alert is now a different monitor, so
    // supersession by monitor does not reach the report.
    await onMessage(root, `slack:monitor-b-${randomUUID()}`, new Date('2026-09-20T00:08:00.000Z'));

    await expect(covered()).resolves.toEqual([]);
    await expect(listProviderRecoveryReports(app.db, tenantB, incident.id)).resolves.toEqual([]);
  });

  test('retries failed ticket reminders and acknowledges only delivered claims', async () => {
    await setTenantSignalPolicy(app.db, tenantA, {
      retentionDays: 30,
      secondTeamEnabled: true,
      customerVisibleEnabled: true,
      unsolvedAfterMinutes: 1,
    });
    const created = await recordSignalDisposition(app.db, tenantA, {
      ...input(`slack:C-SIGNALS:${randomUUID()}`),
      classificationMode: 'enforce',
      effectiveDisposition: 'ticket',
    });
    await startSignalReview(app.db, tenantA, created.id);
    await admin.db
      .update(signalDispositions)
      .set({ reviewStartedAt: new Date(Date.now() - 300_000) })
      .where(eq(signalDispositions.id, created.id));

    const [first] = await claimDueSignalPrompts(app.db, tenantA, 10);
    expect(first).toMatchObject({ id: created.id, promotionSuggestedAt: null });
    await releaseSignalPrompt(app.db, tenantA, created.id, first!.promotionPromptClaimId);
    const [retry] = await claimDueSignalPrompts(app.db, tenantA, 10);
    expect(retry).toMatchObject({ id: created.id });
    await acknowledgeSignalPrompt(app.db, tenantA, created.id, retry!.promotionPromptClaimId);
    await expect(claimDueSignalPrompts(app.db, tenantA, 10)).resolves.toEqual([]);
  });

  test('an explicit null reminder threshold disables due-ticket claims', async () => {
    await setTenantSignalPolicy(app.db, tenantA, {
      retentionDays: 30,
      secondTeamEnabled: true,
      customerVisibleEnabled: true,
      unsolvedAfterMinutes: null,
    });
    const created = await recordSignalDisposition(app.db, tenantA, {
      ...input(`slack:C-SIGNALS:${randomUUID()}`),
      classificationMode: 'enforce',
      effectiveDisposition: 'ticket',
    });
    await startSignalReview(app.db, tenantA, created.id);
    await admin.db
      .update(signalDispositions)
      .set({ reviewStartedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(signalDispositions.id, created.id));

    await expect(claimDueSignalPrompts(app.db, tenantA, 10)).resolves.toEqual([]);
  });

  test('pages older tickets by created time and id without hiding them behind newer rows', async () => {
    const first = await recordSignalDisposition(
      app.db,
      tenantA,
      input(`slack:C-SIGNALS:${randomUUID()}`),
    );
    const second = await recordSignalDisposition(
      app.db,
      tenantA,
      input(`slack:C-SIGNALS:${randomUUID()}`),
    );
    await admin.db
      .update(signalDispositions)
      .set({ createdAt: new Date('2026-09-02T10:00:00.000Z') })
      .where(eq(signalDispositions.id, first.id));
    await admin.db
      .update(signalDispositions)
      .set({ createdAt: new Date('2026-09-02T09:00:00.000Z') })
      .where(eq(signalDispositions.id, second.id));

    const page1 = await listSignalDispositionPage(app.db, tenantA, {
      limit: 1,
      disposition: 'ticket',
    });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listSignalDispositionPage(app.db, tenantA, {
      limit: 1,
      disposition: 'ticket',
      before: page1.nextCursor!,
    });
    expect(page2.signals[0]?.id).not.toBe(page1.signals[0]?.id);
  });

  test('keeps a late older classification as history without replacing the current signal', async () => {
    const signalKey = `slack:C-SIGNALS:ordered-${randomUUID()}`;
    const newer = await recordSignalDisposition(app.db, tenantA, {
      ...input(`slack:C-SIGNALS:newer-${randomUUID()}`, 'investigate'),
      signalKey,
      sourceEventAt: new Date('2026-09-02T02:00:00.000Z'),
    });
    const older = await recordSignalDisposition(app.db, tenantA, {
      ...input(`slack:C-SIGNALS:older-${randomUUID()}`, 'log'),
      signalKey,
      sourceEventAt: new Date('2026-09-02T01:00:00.000Z'),
    });

    const current = await listSignalDispositions(app.db, tenantA, { limit: 100 });
    expect(current).toContainEqual(expect.objectContaining({ id: newer.id }));
    expect(current).not.toContainEqual(expect.objectContaining({ id: older.id }));
    const history = await listSignalDispositions(app.db, tenantA, {
      limit: 100,
      currentOnly: false,
    });
    expect(history).toContainEqual(
      expect.objectContaining({ id: older.id, supersededAt: expect.any(Date) }),
    );
  });

  test('applies each tenant retention policy in bounded idempotent batches', async () => {
    const now = new Date('2026-09-02T12:00:00.000Z');
    await setTenantSignalPolicy(app.db, tenantA, {
      retentionDays: 7,
      secondTeamEnabled: true,
      customerVisibleEnabled: true,
      unsolvedAfterMinutes: 60,
    });
    await setTenantSignalPolicy(app.db, tenantB, {
      retentionDays: 30,
      secondTeamEnabled: true,
      customerVisibleEnabled: true,
      unsolvedAfterMinutes: 60,
    });

    const oldA = await Promise.all(
      Array.from({ length: 3 }, () =>
        recordSignalDisposition(app.db, tenantA, input(`slack:C-SIGNALS:${randomUUID()}`)),
      ),
    );
    const oldB = await recordSignalDisposition(
      app.db,
      tenantB,
      input(`slack:C-SIGNALS:${randomUUID()}`),
    );
    await admin.db
      .update(signalDispositions)
      .set({ createdAt: new Date('2026-08-20T00:00:00.000Z') })
      .where(sql`id in (${sql.join([...oldA.map((row) => row.id), oldB.id], sql`, `)})`);

    await expect(sweepExpiredSignalDispositions(app.db, tenantA, { now, limit: 2 })).resolves.toBe(
      2,
    );
    await expect(sweepExpiredSignalDispositions(app.db, tenantA, { now, limit: 2 })).resolves.toBe(
      1,
    );
    await expect(sweepExpiredSignalDispositions(app.db, tenantA, { now, limit: 2 })).resolves.toBe(
      0,
    );

    const tenantBRows = await listSignalDispositions(app.db, tenantB, { limit: 50 });
    expect(tenantBRows.some((row) => row.id === oldB.id)).toBe(true);
  });
});
