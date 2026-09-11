import { seedMembership } from '../test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  addIncidentTag,
  agentToolCalls,
  approvals,
  createApproval,
  createIncident,
  incidentFeedback,
  incidentMessages,
  incidentTags,
  incidents,
  investigationRuns,
  makeDb,
  memberships,
  readReliabilityReport,
  recordSignalDisposition,
  recordToolCall,
  reliabilityPeriodBounds,
  signalDispositions,
  setTenantSignalPolicy,
  tenantSignalPolicies,
  tenants,
  type DbHandle,
  users,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;
const NOW = new Date('2026-09-02T12:00:00.000Z');
const CURRENT_A = new Date('2026-09-01T10:00:00.000Z');
const CURRENT_B = new Date('2026-09-02T08:00:00.000Z');
const PREVIOUS = new Date('2026-08-25T10:00:00.000Z');

let admin: DbHandle;
let app: DbHandle;
const tenantA = randomUUID();
const tenantB = randomUUID();
const tenantC = randomUUID();
let actorA: string;
let actorB: string;
let currentA: string;
let currentB: string;
let previousA: string;
let oldA: string;
let foreignB: string;
let futureRows: Promise<void> | null = null;

async function seedIncident(
  tenantId: string,
  service: string,
  createdAt: Date,
  source = 'alertmanager',
): Promise<string> {
  const row = await createIncident(app.db, tenantId, {
    fingerprint: `reliability-${randomUUID()}`,
    alertSource: source,
    service,
    severity: 'sev3',
  });
  await admin.db
    .update(incidents)
    .set({ createdAt, updatedAt: createdAt })
    .where(eq(incidents.id, row.id));
  return row.id;
}

async function seedSignal(
  tenantId: string,
  incidentId: string,
  service: string,
  createdAt: Date,
): Promise<void> {
  const id = randomUUID();
  const row = await recordSignalDisposition(app.db, tenantId, {
    source: 'alertmanager',
    sourceEventKey: `alertmanager:${id}`,
    sourceEventAt: createdAt,
    signalKey: `alertmanager:${id}`,
    surface: 'slack',
    channel: 'C-RELIABILITY',
    threadId: `1790.${id.slice(0, 6)}`,
    summary: 'Provider signal accepted for investigation.',
    reason: 'Urgent and actionable.',
    service,
    severity: 'sev3',
    disposition: 'investigate',
    incidentId,
    ticket: null,
  });
  await admin.db
    .update(signalDispositions)
    .set({ createdAt, updatedAt: createdAt })
    .where(eq(signalDispositions.id, row.id));
}

function seedFutureReliabilityRows(): Promise<void> {
  futureRows ??= (async () => {
    await Promise.all([
      seedSignal(tenantA, currentA, 'checkout', new Date('2026-09-01T10:00:00.000Z')),
      seedSignal(tenantA, currentA, 'checkout', new Date('2026-09-01T10:01:00.000Z')),
      seedSignal(tenantA, currentB, 'payments', new Date('2026-09-02T08:00:00.000Z')),
      seedSignal(tenantA, currentB, 'payments', new Date('2026-09-02T08:01:00.000Z')),
      seedSignal(tenantA, previousA, 'checkout', PREVIOUS),
      seedSignal(tenantB, foreignB, 'checkout', CURRENT_A),
    ]);
    await admin.db
      .update(tenantSignalPolicies)
      .set({ measurementStartedAt: new Date('2026-08-24T00:00:00.000Z') })
      .where(eq(tenantSignalPolicies.tenantId, tenantA));

    for (const incidentId of [currentA, currentB]) {
      await addIncidentTag(app.db, tenantA, {
        incidentId,
        tag: 'cause:deployment',
        actorUserId: actorA,
        source: 'dashboard',
      });
    }
    await addIncidentTag(app.db, tenantB, {
      incidentId: foreignB,
      tag: 'cause:foreign',
      actorUserId: actorB,
      source: 'dashboard',
    });
  })();
  return futureRows;
}

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'reliability-a' },
    { id: tenantB, name: 'reliability-b' },
    { id: tenantC, name: 'reliability-no-incidents' },
  ]);
  actorA = await seedMembership(
    admin.db,
    { issuer: 'https://reliability.test/', subject: `actor-a-${randomUUID()}` },
    tenantA,
  );
  actorB = await seedMembership(
    admin.db,
    { issuer: 'https://reliability.test/', subject: `actor-b-${randomUUID()}` },
    tenantB,
  );
  currentA = await seedIncident(tenantA, 'checkout', CURRENT_A);
  currentB = await seedIncident(tenantA, 'payments', CURRENT_B);
  previousA = await seedIncident(tenantA, 'checkout', PREVIOUS);
  oldA = await seedIncident(tenantA, 'legacy-api', new Date('2026-08-01T00:00:00.000Z'));
  foreignB = await seedIncident(tenantB, 'checkout', CURRENT_A);

  const approval = await createApproval(app.db, tenantA, {
    incidentId: currentA,
    actionId: 'rollback-current-a',
    prompt: 'Roll back?',
    options: [{ id: 'approve', label: 'Approve' }],
  });
  await admin.db
    .update(approvals)
    .set({ createdAt: CURRENT_A })
    .where(eq(approvals.id, approval.row.id));
  await admin.db.insert(incidentMessages).values([
    {
      tenantId: tenantA,
      incidentId: oldA,
      author: 'agent',
      kind: 'clarification_request',
      content: 'Which dependency is still failing?',
      createdAt: new Date('2026-09-02T09:00:00.000Z'),
    },
    {
      tenantId: tenantA,
      incidentId: currentA,
      author: 'agent',
      kind: 'clarification_request',
      content: 'Which region is affected?',
      createdAt: new Date('2026-09-01T10:02:00.000Z'),
    },
    {
      tenantId: tenantA,
      incidentId: currentA,
      author: 'agent',
      kind: 'degraded_reask',
      content: 'Please repeat the deployment identifier.',
      createdAt: new Date('2026-09-01T10:03:00.000Z'),
    },
    {
      tenantId: tenantA,
      incidentId: currentA,
      author: 'human',
      kind: 'text',
      content: 'Both regions are affected.',
      originSurface: 'slack',
      authorUserId: actorA,
      createdAt: new Date('2026-09-01T10:04:00.000Z'),
    },
    {
      tenantId: tenantA,
      incidentId: currentA,
      author: 'human',
      kind: 'text',
      content: 'The deployment is checkout-42.',
      originSurface: 'slack',
      authorUserId: actorA,
      createdAt: new Date('2026-09-01T10:05:00.000Z'),
    },
  ]);
  await admin.db.insert(incidentFeedback).values({
    tenantId: tenantA,
    incidentId: currentA,
    targetType: 'finding',
    targetId: 'finding-current-a',
    decision: 'correct',
    rationale: 'The deployment, not the database, caused the errors.',
    correction: { cause: 'deployment' },
    createdByUserId: actorA,
    createdAt: new Date('2026-09-01T10:06:00.000Z'),
  });

  const runbookEvidence = await recordToolCall(app.db, tenantA, {
    incidentId: currentA,
    tool: 'search_runbooks',
    input: { query: 'checkout rollback' },
    latencyMs: 20,
    outcome: 'data',
    output: { source: 'runbooks/checkout.md' },
  });
  const runId = randomUUID();
  await admin.db.insert(investigationRuns).values({
    id: runId,
    tenantId: tenantA,
    incidentId: currentA,
    operation: 'investigate',
    outcome: 'conclusive',
    result: {
      summary: 'The deployment caused the errors.',
      rankedHypotheses: [{ hypothesis: 'Deployment regression', confidence: 80 }],
    },
    evidenceIds: [runbookEvidence],
    startedAt: CURRENT_A,
    completedAt: new Date('2026-09-01T10:05:00.000Z'),
  });
  await admin.db
    .update(incidents)
    .set({
      trustedAssessmentRunId: runId,
      assessmentUpdatedAt: new Date('2026-09-01T10:05:00.000Z'),
    })
    .where(eq(incidents.id, currentA));
  await admin.db
    .update(incidents)
    .set({
      status: 'resolved',
      resolvedAt: new Date('2026-09-02T08:10:00.000Z'),
      investigationStatus: 'assessed',
    })
    .where(eq(incidents.id, currentB));
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentFeedback).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(approvals).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidentMessages).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    if (incidentTags)
      await admin.db.delete(incidentTags).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    if (signalDispositions)
      await admin.db
        .delete(signalDispositions)
        .where(sql`tenant_id in (${tenantA}, ${tenantB}, ${tenantC})`);
    await admin.db.delete(agentToolCalls).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db
      .update(incidents)
      .set({ trustedAssessmentRunId: null, recoveryRunId: null })
      .where(sql`tenant_id in (${tenantA}, ${tenantB}, ${tenantC})`);
    await admin.db.delete(investigationRuns).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB}, ${tenantC})`);
    await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(users).where(sql`id in (${actorA}, ${actorB})`);
    await admin.db
      .delete(tenantSignalPolicies)
      .where(sql`tenant_id in (${tenantA}, ${tenantB}, ${tenantC})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB}, ${tenantC})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('UTC reliability period boundaries', () => {
  test.each([
    [
      'week',
      '2026-08-31T00:00:00.000Z',
      '2026-09-07T00:00:00.000Z',
      '2026-08-24T00:00:00.000Z',
      '2026-08-31T00:00:00.000Z',
    ],
    [
      'month',
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    ],
    [
      'quarter',
      '2026-07-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ],
  ] as const)('computes current and immediately preceding %s periods', (period, ...expected) => {
    const bounds = reliabilityPeriodBounds(period, NOW);
    expect([
      bounds.current.start.toISOString(),
      bounds.current.end.toISOString(),
      bounds.previous.start.toISOString(),
      bounds.previous.end.toISOString(),
    ]).toEqual(expected);
  });
});

describe('tenant reliability read model', () => {
  test('health checks are visible records but excluded from outage aggregates', async () => {
    const tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'Health-check reliability' });
    try {
      const input = {
        fingerprint: randomUUID(),
        service: 'checkout',
        severity: 'sev2',
        alertSource: 'manual',
        purpose: 'health_check' as const,
      };
      const row = await createIncident(app.db, tenantId, input);
      await admin.db
        .update(incidents)
        .set({ createdAt: CURRENT_A, updatedAt: CURRENT_A })
        .where(eq(incidents.id, row.id));
      const report = await readReliabilityReport(app.db, tenantId, { period: 'week', now: NOW });
      expect(report.outages.current.incidentCount).toBe(0);
      expect(
        await admin.db.select({ id: incidents.id }).from(incidents).where(eq(incidents.id, row.id)),
      ).toEqual([{ id: row.id }]);
    } finally {
      await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
      await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  });

  test('reports outage comparison, explicit denominators, causes, and truthful toil proxies', async () => {
    await seedFutureReliabilityRows();
    const report = await readReliabilityReport(app.db, tenantA, { period: 'week', now: NOW });

    expect(report.outages.current).toMatchObject({
      incidentCount: 2,
      alertCount: 4,
      alertsPerIncident: {
        value: 2,
        numerator: 4,
        denominator: 2,
        alertDefinition: 'terminal classified signal records',
        incidentDefinition: 'incidents opened in the UTC period',
      },
    });
    expect(report.outages.signalCoverage).toMatchObject({
      currentComplete: true,
      previousComplete: true,
    });
    expect(report.outages.previous).toMatchObject({ incidentCount: 1, alertCount: 1 });
    expect(report.outages.byService).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: 'checkout', currentIncidents: 1, previousIncidents: 1 }),
        expect.objectContaining({
          service: 'payments',
          currentIncidents: 1,
          previousIncidents: 0,
          currentAlerts: 2,
          currentAlertsPerIncident: 2,
          previousAlertsPerIncident: null,
        }),
      ]),
    );
    expect(report.outages.topCauses).toEqual([{ tag: 'cause:deployment', incidentCount: 2 }]);
    expect(report.outages.topCauseCaveat).toMatch(/monitoring|sensitive/i);
    expect(report.outages.topCauseCaveat).toMatch(/severity|difficulty/i);

    expect(report.toil.created).toEqual({
      approvalDemands: 1,
      clarificationRequests: 2,
      degradedReasks: 1,
      findingCorrections: 1,
    });
    expect(report.toil.removed).toMatchObject({
      averageFirstHypothesisSeconds: 300,
      humanTurnsPerProviderIncident: { numerator: 2, denominator: 2, value: 1 },
      citedRunbookAdoption: { numerator: 1, denominator: 1, rate: 1 },
      resolvedWithoutResponderOrApprovedAction: { numerator: 1, denominator: 2, rate: 0.5 },
    });
    expect(report.toil.definitions).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/responder turn.*proxy/i),
        expect.stringMatching(/cited.*search_runbooks/i),
      ]),
    );
  });

  test('pages the complete service breakdown with a stable service cursor', async () => {
    await seedFutureReliabilityRows();
    const first = await readReliabilityReport(app.db, tenantA, {
      period: 'week',
      now: NOW,
      serviceLimit: 1,
    });
    expect(first.outages.byService).toHaveLength(1);
    expect(first.outages.byServiceNextCursor).toBe(first.outages.byService[0]?.service);
    const second = await readReliabilityReport(app.db, tenantA, {
      period: 'week',
      now: NOW,
      serviceLimit: 1,
      serviceAfter: first.outages.byServiceNextCursor!,
    });
    expect(second.outages.byService[0]?.service).not.toBe(first.outages.byService[0]?.service);
  });

  test('does not keep aging a resolved or superseded unpromoted ticket', async () => {
    const ticket = await recordSignalDisposition(app.db, tenantA, {
      source: 'slack-human',
      sourceEventKey: `ticket:${randomUUID()}`,
      sourceEventAt: CURRENT_A,
      signalKey: `ticket:${randomUUID()}`,
      surface: 'slack',
      channel: 'C-RELIABILITY',
      threadId: `1790.${randomUUID().slice(0, 6)}`,
      summary: 'Deferred risk later recovered.',
      reason: 'No current impact.',
      service: 'checkout',
      disposition: 'ticket',
      ticket: {
        action: 'Review capacity.',
        safeDeferralReason: 'Capacity is currently sufficient.',
        riskIfIgnored: 'A later node loss could reduce capacity.',
        reviewHorizonMinutes: 60,
      },
    });
    await admin.db
      .update(signalDispositions)
      .set({ createdAt: CURRENT_A, resolvedAt: new Date('2026-09-01T11:00:00.000Z') })
      .where(eq(signalDispositions.id, ticket.id));

    const report = await readReliabilityReport(app.db, tenantA, { period: 'week', now: NOW });
    expect(report.outages.ticketFlow.current.averageOpenAgeSeconds).toBeNull();
  });

  test('marks historical periods incomplete when retained signal coverage is shorter', async () => {
    await seedFutureReliabilityRows();
    await setTenantSignalPolicy(app.db, tenantA, {
      retentionDays: 1,
      unsolvedAfterMinutes: 60,
      secondTeamEnabled: true,
      customerVisibleEnabled: true,
    });
    const report = await readReliabilityReport(app.db, tenantA, { period: 'quarter', now: NOW });
    expect(report.outages.signalCoverage).toMatchObject({
      currentComplete: false,
      previousComplete: false,
    });
    expect(report.outages.current.alertsPerIncident.value).toBeNull();
    expect(report.outages.previous.alertsPerIncident.value).toBeNull();
    await setTenantSignalPolicy(app.db, tenantA, {
      retentionDays: 30,
      unsolvedAfterMinutes: 60,
      secondTeamEnabled: true,
      customerVisibleEnabled: true,
    });
  });

  test('does not claim pre-measurement alerts for historical incidents', async () => {
    await seedIncident(tenantC, 'historical', PREVIOUS);
    const report = await readReliabilityReport(app.db, tenantC, { period: 'week', now: NOW });
    expect(report.outages.signalCoverage.measurementStartedAt).toBeNull();
    expect(report.outages.previous.alertsPerIncident.value).toBeNull();
  });

  test('never includes another tenant in outage, cause, load, or toil metrics', async () => {
    await seedFutureReliabilityRows();
    const report = await readReliabilityReport(app.db, tenantA, { period: 'week', now: NOW });
    expect(JSON.stringify(report)).not.toContain('cause:foreign');
    expect(report.outages.current.incidentCount).toBe(2);
    expect(report.outages.current.alertCount).toBe(5);
  });

  test('reports ratios as unavailable when the denominator is zero', async () => {
    const signal = await recordSignalDisposition(app.db, tenantC, {
      source: 'slack-provider',
      sourceEventKey: `signal:${randomUUID()}`,
      sourceEventAt: CURRENT_A,
      signalKey: `signal:${randomUUID()}`,
      surface: 'slack',
      channel: 'C-RELIABILITY',
      threadId: `1790.${randomUUID().slice(0, 6)}`,
      summary: 'Deferred capacity warning.',
      reason: 'No immediate impact.',
      disposition: 'log',
    });
    await admin.db
      .update(signalDispositions)
      .set({ createdAt: CURRENT_A, updatedAt: CURRENT_A })
      .where(eq(signalDispositions.id, signal.id));
    const report = await readReliabilityReport(app.db, tenantC, { period: 'week', now: NOW });
    expect(report.outages.current.alertsPerIncident).toMatchObject({
      numerator: 1,
      denominator: 0,
      value: null,
    });
    expect(report.toil.removed.humanTurnsPerProviderIncident.value).toBeNull();
    expect(report.toil.removed.citedRunbookAdoption.rate).toBeNull();
  });

  test('counts only enforced effective tickets in operational ticket metrics', async () => {
    const createTicket = async (
      mode: 'shadow' | 'enforce',
      effective: 'ticket' | 'investigate',
    ) => {
      const row = await recordSignalDisposition(app.db, tenantC, {
        source: 'slack-human',
        sourceEventKey: `ticket:${randomUUID()}`,
        sourceEventAt: CURRENT_A,
        signalKey: `ticket:${randomUUID()}`,
        surface: 'slack',
        channel: 'C-RELIABILITY',
        threadId: `1790.${randomUUID().slice(0, 6)}`,
        summary: 'Deferred reliability risk.',
        reason: 'No immediate impact.',
        disposition: 'ticket',
        classificationMode: mode,
        effectiveDisposition: effective,
        ticket: {
          action: 'Review capacity.',
          safeDeferralReason: 'No impact now.',
          riskIfIgnored: 'Capacity may be exhausted.',
          reviewHorizonMinutes: 60,
        },
      });
      await admin.db
        .update(signalDispositions)
        .set({ createdAt: CURRENT_A, updatedAt: CURRENT_A })
        .where(eq(signalDispositions.id, row.id));
    };
    await createTicket('shadow', 'investigate');
    await createTicket('enforce', 'ticket');
    const report = await readReliabilityReport(app.db, tenantC, { period: 'week', now: NOW });
    expect(report.outages.ticketFlow.current.ticketCount).toBe(1);
  });
});
