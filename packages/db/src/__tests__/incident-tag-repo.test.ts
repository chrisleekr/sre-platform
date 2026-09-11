import { seedMembership } from '../test-support';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  addIncidentTag,
  acceptIncidentTagSuggestion,
  agentToolCalls,
  createIncident,
  incidentTags,
  incidentTagSuggestions,
  incidents,
  investigationRuns,
  listIncidentTagSuggestions,
  listIncidentTags,
  listIncidentTagsTx,
  listTenantTagLinkRules,
  makeDb,
  memberships,
  recordAcceptedCauseTagSuggestions,
  recordToolCall,
  removeIncidentTagByValueTx,
  removeIncidentTag,
  removeTenantTagLinkRule,
  tenantTagLinkRules,
  tenants,
  setTenantTagLinkRule,
  withTenant,
  type DbHandle,
  users,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;
const FAKE_GITLAB_PAT = ['glpat', 'abcdefghijklmnopqrst'].join('-');

let admin: DbHandle;
let app: DbHandle;
const tenantA = randomUUID();
const tenantB = randomUUID();
let actorA: string;
let actorB: string;
const incidentIds: string[] = [];

async function incident(tenantId: string, service = 'checkout'): Promise<string> {
  const row = await createIncident(app.db, tenantId, {
    fingerprint: `tag-${randomUUID()}`,
    alertSource: 'slack',
    service,
    severity: 'sev3',
  });
  incidentIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'incident-tag-a' },
    { id: tenantB, name: 'incident-tag-b' },
  ]);
  actorA = await seedMembership(
    admin.db,
    { issuer: 'https://tag.test/', subject: `tag-actor-${randomUUID()}` },
    tenantA,
  );
  actorB = await seedMembership(
    admin.db,
    { issuer: 'https://tag.test/', subject: `tag-actor-${randomUUID()}` },
    tenantB,
  );
});

afterEach(async () => {
  if (!admin) return;
  await admin.db.delete(incidentTagSuggestions).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
  await admin.db.delete(incidentTags).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
});

afterAll(async () => {
  if (admin) {
    if (incidentTagSuggestions)
      await admin.db
        .delete(incidentTagSuggestions)
        .where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    if (incidentTags)
      await admin.db.delete(incidentTags).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    if (tenantTagLinkRules)
      await admin.db.delete(tenantTagLinkRules).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db
      .update(incidents)
      .set({ trustedAssessmentRunId: null, recoveryRunId: null })
      .where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(agentToolCalls).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(investigationRuns).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(users).where(sql`id in (${actorA}, ${actorB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('incident tag repository', () => {
  test('stores only safe tenant-owned HTTPS tag link templates', async () => {
    await expect(
      setTenantTagLinkRule(app.db, tenantA, {
        prefix: 'bug',
        urlTemplate: 'https://tracker.example/issues/{value}',
      }),
    ).resolves.toMatchObject({ prefix: 'bug' });
    await expect(
      setTenantTagLinkRule(app.db, tenantA, {
        prefix: 'bad',
        urlTemplate: 'javascript:alert({value})',
      }),
    ).rejects.toThrow('HTTPS');
    await expect(
      setTenantTagLinkRule(app.db, tenantA, {
        prefix: 'secret-query',
        urlTemplate: 'https://tracker.example/issues/{value}?access_token=short-secret',
      }),
    ).rejects.toThrow(/credential/i);
    await expect(
      setTenantTagLinkRule(app.db, tenantA, {
        prefix: 'secret-path',
        urlTemplate: `https://tracker.example/${FAKE_GITLAB_PAT}/issues/{value}`,
      }),
    ).rejects.toThrow(/credential/i);
    await expect(listTenantTagLinkRules(app.db, tenantB)).resolves.toEqual([]);
    await expect(removeTenantTagLinkRule(app.db, tenantA, 'bug')).resolves.toBe(true);
  });

  test('accepts tenant vocabulary and typos while enforcing whitespace, length, and ownership', async () => {
    const incidentA = await incident(tenantA);
    const incidentB = await incident(tenantB);

    for (const tag of ['cause:netwrok', 'problem-went-away', 'bogus']) {
      await expect(
        addIncidentTag(app.db, tenantA, {
          incidentId: incidentA,
          tag,
          actorUserId: actorA,
          source: 'dashboard',
        }),
      ).resolves.toEqual(expect.objectContaining({ tag }));
    }
    await expect(
      addIncidentTag(app.db, tenantA, {
        incidentId: incidentA,
        tag: 'cause:network switch',
        actorUserId: actorA,
        source: 'dashboard',
      }),
    ).rejects.toThrow(/whitespace/i);
    await expect(
      addIncidentTag(app.db, tenantA, {
        incidentId: incidentA,
        tag: 'x'.repeat(129),
        actorUserId: actorA,
        source: 'dashboard',
      }),
    ).rejects.toThrow(/128|length/i);
    for (const tag of [`token:${FAKE_GITLAB_PAT}`, 'password:hunter2']) {
      await expect(
        addIncidentTag(app.db, tenantA, {
          incidentId: incidentA,
          tag,
          actorUserId: actorA,
          source: 'dashboard',
        }),
      ).rejects.toThrow(/credential/i);
    }
    await expect(
      addIncidentTag(app.db, tenantA, {
        incidentId: incidentB,
        tag: 'cause:network',
        actorUserId: actorA,
        source: 'dashboard',
      }),
    ).rejects.toThrow();

    const tags = await listIncidentTags(app.db, tenantA, incidentA);
    expect(tags).toHaveLength(3);
    expect(tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: tenantA, tag: 'cause:netwrok' }),
        expect.objectContaining({ tenantId: tenantA, tag: 'problem-went-away' }),
        expect.objectContaining({ tenantId: tenantA, tag: 'bogus' }),
      ]),
    );
  });

  test('supports atomic Slack list and value-removal commands', async () => {
    const incidentA = await incident(tenantA);
    await addIncidentTag(app.db, tenantA, {
      incidentId: incidentA,
      tag: 'cause:network',
      actorUserId: actorA,
      source: 'slack',
    });

    await withTenant(app.db, tenantA, async (tx) => {
      await expect(listIncidentTagsTx(tx, tenantA, incidentA)).resolves.toEqual([
        expect.objectContaining({ tag: 'cause:network' }),
      ]);
      await expect(
        removeIncidentTagByValueTx(tx, tenantA, incidentA, 'cause:network'),
      ).resolves.toBe(true);
    });
    await expect(listIncidentTags(app.db, tenantA, incidentA)).resolves.toEqual([]);
  });

  test('ranks suggestions only from the tenant own applied-tag frequency', async () => {
    const tenantAIncidents = await Promise.all([
      incident(tenantA),
      incident(tenantA),
      incident(tenantA),
    ]);
    const tenantBIncident = await incident(tenantB);
    for (const id of tenantAIncidents) {
      await addIncidentTag(app.db, tenantA, {
        incidentId: id,
        tag: 'cause:database',
        actorUserId: actorA,
        source: 'dashboard',
      });
    }
    await addIncidentTag(app.db, tenantA, {
      incidentId: tenantAIncidents[0]!,
      tag: 'cause:deployment',
      actorUserId: actorA,
      source: 'dashboard',
    });
    await admin.db.insert(incidentTags).values({
      tenantId: tenantB,
      incidentId: tenantBIncident,
      tag: 'cause:foreign-popular',
      actorUserId: actorB,
      source: 'dashboard',
    });

    await expect(
      listIncidentTagSuggestions(app.db, tenantA, { prefix: 'cause:', limit: 10 }),
    ).resolves.toEqual([
      { tag: 'cause:database', appliedCount: 3 },
      { tag: 'cause:deployment', appliedCount: 1 },
    ]);
  });

  test('persists only unapplied cause suggestions linked to accepted conclusive evidence', async () => {
    const incidentA = await incident(tenantA, 'payments');
    const incidentOther = await incident(tenantA, 'database');
    const validEvidence = await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'prometheus_query',
      input: { query: 'rate(errors[5m])' },
      latencyMs: 10,
      outcome: 'data',
      output: { value: 0.42 },
    });
    const foreignEvidence = await recordToolCall(app.db, tenantA, {
      incidentId: incidentOther,
      tool: 'prometheus_query',
      input: { query: 'up' },
      latencyMs: 10,
      outcome: 'data',
      output: { value: 1 },
    });
    const runId = randomUUID();
    await admin.db.insert(investigationRuns).values({
      id: runId,
      tenantId: tenantA,
      incidentId: incidentA,
      operation: 'investigate',
      outcome: 'conclusive',
      result: { summary: 'A deployment introduced the error.' },
      evidenceIds: [validEvidence],
      completedAt: new Date(),
    });
    await admin.db
      .update(incidents)
      .set({ trustedAssessmentRunId: runId })
      .where(eq(incidents.id, incidentA));

    await recordAcceptedCauseTagSuggestions(app.db, tenantA, {
      incidentId: incidentA,
      runId,
      suggestions: [
        { tag: 'cause:deployment', evidenceIds: [validEvidence, foreignEvidence] },
        { tag: 'cause:unsupported', evidenceIds: [foreignEvidence] },
        { tag: 'action:rollback', evidenceIds: [validEvidence] },
        { tag: 'cause:AKIA1234567890ABCDEF', evidenceIds: [validEvidence] },
        { tag: 'cause:ghp_1234567890abcdefghijklmnop', evidenceIds: [validEvidence] },
        { tag: `cause:${FAKE_GITLAB_PAT}`, evidenceIds: [validEvidence] },
        { tag: 'cause:xoxb-1234567890-secret', evidenceIds: [validEvidence] },
        { tag: 'cause:Bearer secretvalue', evidenceIds: [validEvidence] },
        { tag: 'cause:aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV', evidenceIds: [validEvidence] },
      ],
    });

    const rows = await admin.db
      .select()
      .from(incidentTagSuggestions)
      .where(eq(incidentTagSuggestions.incidentId, incidentA));
    expect(rows).toEqual([
      expect.objectContaining({
        tag: 'cause:deployment',
        evidenceIds: [validEvidence],
        appliedAt: null,
      }),
    ]);
    await expect(listIncidentTags(app.db, tenantA, incidentA)).resolves.toEqual([]);

    const accepted = await acceptIncidentTagSuggestion(app.db, tenantA, {
      incidentId: incidentA,
      suggestionId: rows[0]!.id,
      tag: 'cause:deployment',
      actorUserId: actorA,
      source: 'dashboard',
    });
    expect(accepted).toMatchObject({ tag: 'cause:deployment' });
    const incidentB = await incident(tenantB, 'payments');
    const runB = randomUUID();
    await admin.db.insert(investigationRuns).values({
      id: runB,
      tenantId: tenantB,
      incidentId: incidentB,
      operation: 'investigate',
      outcome: 'conclusive',
      result: { summary: 'Tenant B result.' },
      completedAt: new Date(),
    });
    const foreignSuggestion = await admin.db
      .insert(incidentTagSuggestions)
      .values({
        tenantId: tenantB,
        incidentId: incidentB,
        runId: runB,
        tag: 'cause:database',
        evidenceIds: [randomUUID()],
      })
      .returning();
    await expect(
      admin.db
        .update(incidentTagSuggestions)
        .set({ appliedTagId: accepted!.id })
        .where(eq(incidentTagSuggestions.id, foreignSuggestion[0]!.id)),
    ).rejects.toThrow();
    await expect(removeIncidentTag(app.db, tenantA, incidentA, accepted!.id)).resolves.toBe(true);
    const retainedSuggestion = await admin.db
      .select()
      .from(incidentTagSuggestions)
      .where(eq(incidentTagSuggestions.id, rows[0]!.id));
    expect(retainedSuggestion[0]).toMatchObject({
      appliedAt: expect.any(Date),
      appliedTagId: null,
    });
  });
});
