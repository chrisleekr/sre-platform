import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  applyTriageResult,
  createIncident,
  getIncident,
  incidentMessages,
  incidents,
  listIncidents,
  recordToolCall,
  setInvestigationStatus,
} from '../index';

import { startInvestigatingWithMessages } from '../incident-repo';

// active-set query + occurrence bump. Namespace access so a not-yet-exported symbol
// reads as `undefined` (a per-assertion RED: "not a function") instead of an ESM link error that
// would break the existing passing tests in this module.
import * as incidentRepo from '../incident-repo';

import { createFixture } from './incident-repo.fixture';

const __fixture = createFixture();

describe('incident lifecycle + RLS', () => {
  test('an incident with no promoted run projects null trusted provenance', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `legacy-provenance-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });

    expect(
      (
        (await getIncident(__fixture.app.db, __fixture.tenantA, id)) as {
          trustedAssessmentRunId?: string | null;
        } | null
      )?.trustedAssessmentRunId,
    ).toBeNull();
  });

  test('startInvestigatingWithMessages atomically opens + posts the opener once', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    // First open wins the progress CAS and both opener messages
    // (triage-started + blast-radius brief) are inserted in one transaction.
    const rows = await startInvestigatingWithMessages(__fixture.app.db, __fixture.tenantA, id, [
      { author: 'system', kind: 'text', content: 'Triage started.' },
      { author: 'system', kind: 'text', content: 'brief-xyz' },
    ]);
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows![0]!.id).toBeTruthy();
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, id))?.investigationStatus).toBe(
      'gathering',
    );
    // Both opener messages are durably in history (admin bypasses RLS for the assertion).
    const history = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(eq(incidentMessages.incidentId, id));
    expect(history).toHaveLength(2);
    const contents = history.map((m) => m.content);
    expect(contents).toContain('Triage started.');
    expect(contents).toContain('brief-xyz');
  });

  test('startInvestigatingWithMessages: a redelivery loses the CAS — null and no duplicate opener', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    expect(
      await startInvestigatingWithMessages(__fixture.app.db, __fixture.tenantA, id, [
        { author: 'system', kind: 'text', content: 'Triage started.' },
        { author: 'system', kind: 'text', content: 'brief-xyz' },
      ]),
    ).toHaveLength(2);
    // Redelivery: progress is no longer queued, so the CAS is lost — null, no duplicate messages.
    expect(
      await startInvestigatingWithMessages(__fixture.app.db, __fixture.tenantA, id, [
        { author: 'system', kind: 'text', content: 'Triage started.' },
        { author: 'system', kind: 'text', content: 'dupe brief' },
      ]),
    ).toBeNull();
    const history = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(eq(incidentMessages.incidentId, id));
    expect(history).toHaveLength(2);
  });

  test('startInvestigatingWithMessages refuses to open a non-open incident (resolved)', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, id, 'resolved');
    // The open-only CAS refuses the transition (returns null) and inserts nothing.
    expect(
      await startInvestigatingWithMessages(__fixture.app.db, __fixture.tenantA, id, [
        { author: 'system', kind: 'text', content: 'late opener' },
      ]),
    ).toBeNull();
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, id))?.status).toBe('resolved');
    const history = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(eq(incidentMessages.incidentId, id));
    expect(history).toHaveLength(0);
  });

  test('startInvestigatingWithMessages rolls back the CAS when a message insert fails mid-transaction', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    // A NOT NULL violation on content simulates a mid-post crash after the CAS fired.
    await expect(
      startInvestigatingWithMessages(__fixture.app.db, __fixture.tenantA, id, [
        { author: 'system', kind: 'text', content: null as unknown as string },
      ]),
    ).rejects.toThrow();
    // Atomicity: the CAS is undone, so the incident is STILL 'open' and has no messages —
    // a redelivery re-posts the opener cleanly instead of losing the brief.
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, id))?.status).toBe('open');
    const history = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(eq(incidentMessages.incidentId, id));
    expect(history).toHaveLength(0);
  });

  test('applyTriageResult does not reopen a resolved incident but still records the RCA (option B)', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, id, 'resolved');
    // A late triage result lands on a human-RESOLVED incident.
    await applyTriageResult(__fixture.app.db, __fixture.tenantA, id, {
      provider: 'claude',
      sessionId: 's1',
      summary: 'root cause X',
      // integer column: 0.9 would be rejected by Postgres, so confidence is a 0-100 int.
      confidence: 90,
      rankedHypotheses: [{ hypothesis: 'h', confidence: 0.9, evidence: 'e' }],
      unknowns: [
        {
          question: 'whether replicas are equally affected',
          category: 'observable',
          evidenceKind: 'runtime_state',
          attemptedEvidenceIds: [],
        },
      ],
      nextStep: 'Compare connection counts across replicas.',
      engineModel: 'claude-opus-4-8',
    });
    const inc = await getIncident(__fixture.app.db, __fixture.tenantA, id);
    // Option B: status stays resolved (NOT reopened) ...
    expect(inc?.status).toBe('resolved');
    // ... but the RCA fields are still recorded.
    expect(inc?.rcaSummary).toBe('root cause X');
    expect(inc?.confidence).toBe(90);
    expect(inc?.engineProvider).toBe('claude');
    expect(inc?.engineSessionId).toBe('s1');
    expect(inc?.engineModel).toBe('claude-opus-4-8');
    expect(inc?.rankedHypotheses).toEqual([{ hypothesis: 'h', confidence: 0.9, evidence: 'e' }]);
    expect(inc?.unknowns).toEqual([
      {
        question: 'whether replicas are equally affected',
        category: 'observable',
        evidenceKind: 'runtime_state',
        attemptedEvidenceIds: [],
      },
    ]);
    expect(inc?.nextStep).toBe('Compare connection counts across replicas.');
    expect(inc?.assessmentUpdatedAt).toBeInstanceOf(Date);
  });

  test('filters assessment citations to durable evidence from the same tenant and incident', async () => {
    const incidentA = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `citation-a-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    const siblingA = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `citation-sibling-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'payments',
      severity: 'sev2',
    });
    const foreign = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `citation-b-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    const persist = (tenantId: string, incidentId: string) =>
      recordToolCall(__fixture.app.db, tenantId, {
        incidentId,
        tool: 'prometheus_query_range',
        input: { query: 'up' },
        output: { data: { resultType: 'matrix', result: [] } },
        latencyMs: 1,
        outcome: 'data',
      });
    const validId = await persist(__fixture.tenantA, incidentA.id);
    const failedId = await recordToolCall(__fixture.app.db, __fixture.tenantA, {
      incidentId: incidentA.id,
      tool: 'prometheus_query_range',
      input: { query: 'up' },
      latencyMs: 1,
      outcome: 'error',
    });
    const siblingId = await persist(__fixture.tenantA, siblingA.id);
    const foreignId = await persist(__fixture.tenantB, foreign.id);
    const fabricatedId = randomUUID();

    await applyTriageResult(__fixture.app.db, __fixture.tenantA, incidentA.id, {
      provider: 'test',
      sessionId: 'citation-session',
      summary: 'Pool pressure is the leading explanation.',
      confidence: 75,
      currentState: 'Degraded but serving traffic',
      impact: 'Checkout latency is elevated.',
      assessmentEvidenceIds: [validId, failedId, siblingId, foreignId, fabricatedId, validId],
      rankedHypotheses: [
        {
          hypothesis: 'Pool pressure',
          confidence: 75,
          evidence: 'Connection count rose.',
          state: 'leading',
          supportingEvidenceIds: [validId, failedId, siblingId, foreignId, fabricatedId],
          contradictingEvidenceIds: [failedId, siblingId],
        },
      ],
      unknowns: [
        {
          question: 'Whether the failed read can be retried.',
          category: 'observable',
          evidenceKind: 'runtime_state',
          attemptedEvidenceIds: [failedId, siblingId, fabricatedId],
        },
      ],
    });

    const stored = await getIncident(__fixture.app.db, __fixture.tenantA, incidentA.id);
    expect(stored).toMatchObject({
      currentState: 'Degraded but serving traffic',
      impact: 'Checkout latency is elevated.',
      assessmentEvidenceIds: [validId],
      rankedHypotheses: [
        {
          hypothesis: 'Pool pressure',
          supportingEvidenceIds: [validId],
          contradictingEvidenceIds: [],
        },
      ],
      unknowns: [expect.objectContaining({ attemptedEvidenceIds: [failedId] })],
    });
  });

  test('applyTriageResult sets assessed progress and records the RCA', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantA, id, 'gathering');
    await applyTriageResult(__fixture.app.db, __fixture.tenantA, id, {
      provider: 'claude',
      sessionId: 's2',
      summary: 'root cause Y',
      confidence: 75,
      engineModel: 'claude-opus-4-8',
    });
    const inc = await getIncident(__fixture.app.db, __fixture.tenantA, id);
    expect(inc).toMatchObject({ status: 'open', investigationStatus: 'assessed' });
    expect(inc?.rcaSummary).toBe('root cause Y');
    expect(inc?.confidence).toBe(75);
    expect(inc?.engineProvider).toBe('claude');
    expect(inc?.engineSessionId).toBe('s2');
  });

  test('another tenant cannot read the incident (RLS)', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'svc',
      severity: 'sev3',
    });
    expect(await getIncident(__fixture.app.db, __fixture.tenantB, id)).toBeNull();
  });
});

// --- title, active-set query, occurrence bump -------------------------------------
// createIncident gains an optional `title` persisted on the row and surfaced on IncidentSummary.
// listActiveIncidents returns only active lifecycle incidents updated since a
// cutoff, tenant-scoped (RLS). bumpIncidentOccurrenceOnce increments occurrence_count and bumps
// updated_at (the automated-flap belongs_to path, C2), at most once per inbound surface message.
describe('correlation repo', () => {
  test('C5 createIncident persists title, surfaced on listIncidents/IncidentSummary', async () => {
    const fp = `fp-${randomUUID()}`;
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
      // title is the additive field on NewIncident; cast until the type carries it (Phase B).
      title: 'Checkout 5xx spike',
    } as Parameters<typeof createIncident>[2]);
    const rows = await listIncidents(__fixture.app.db, __fixture.tenantA, { limit: 200 });
    const row = rows.find((r) => r.id === id) as (typeof rows)[number] & { title?: string };
    expect(row).toBeDefined();
    expect(row!.title).toBe('Checkout 5xx spike');
  });

  test('C7/C8 listActiveIncidents returns only active + recent incidents, tenant-scoped', async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000); // now - 1h
    // Active + recent (must be returned).
    const { id: activeId } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'api',
      severity: 'sev2',
    });
    // Resolved (excluded by status).
    const { id: resolvedId } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'api',
      severity: 'sev2',
    });
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, resolvedId, 'resolved');
    // Active but stale (updated_at before `since` — excluded by recency).
    const { id: staleId } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'api',
      severity: 'sev2',
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ updatedAt: sql`now() - interval '2 hours'` })
      .where(eq(incidents.id, staleId));
    // Active + recent under tenant B (cross-tenant: must never appear in tenant A's list).
    const { id: otherTenantId } = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'api',
      severity: 'sev2',
    });

    const active = await incidentRepo.listActiveIncidents(__fixture.app.db, __fixture.tenantA, {
      since,
    });
    const ids = active.map((r) => r.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(resolvedId);
    expect(ids).not.toContain(staleId);
    expect(ids).not.toContain(otherTenantId);

    // Tenant B never sees tenant A's active incident (RLS).
    const activeB = await incidentRepo.listActiveIncidents(__fixture.app.db, __fixture.tenantB, {
      since,
    });
    expect(activeB.map((r) => r.id)).not.toContain(activeId);
  });

  test('C2 bumpIncidentOccurrenceOnce increments occurrence_count and bumps updated_at', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'api',
      severity: 'sev2',
    });
    const before = (await getIncident(__fixture.app.db, __fixture.tenantA, id)) as {
      occurrenceCount?: number;
      updatedAt: Date;
    } | null;
    expect(before!.occurrenceCount).toBe(1); // default 1 on create
    // Age updated_at so the bump is observably newer.
    await __fixture.admin.db
      .update(incidents)
      .set({ updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(incidents.id, id));
    const aged = (await getIncident(__fixture.app.db, __fixture.tenantA, id)) as {
      updatedAt: Date;
    } | null;

    expect(
      await incidentRepo.bumpIncidentOccurrenceOnce(
        __fixture.app.db,
        __fixture.tenantA,
        id,
        `slack:C1:${id}`,
      ),
    ).toBe(true);

    const after = (await getIncident(__fixture.app.db, __fixture.tenantA, id)) as {
      occurrenceCount?: number;
      updatedAt: Date;
    } | null;
    expect(after!.occurrenceCount).toBe(2);
    expect(new Date(after!.updatedAt).getTime()).toBeGreaterThan(
      new Date(aged!.updatedAt).getTime(),
    );
  });
});
