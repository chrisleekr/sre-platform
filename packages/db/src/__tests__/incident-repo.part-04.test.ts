import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  applySignalObservation,
  applyTriageResult,
  createIncident,
  degradeIncidentWithMessages,
  getIncident,
  inboundChannels,
  incidentMessages,
  incidents,
  jobs,
  listIncidentRelations,
  listIncidents,
  listUnresolvedSignals,
  recordIncidentRelation,
  setInvestigationStatus,
  surfaceBindings,
  withTenant,
} from '../index';

// active-set query + occurrence bump. Namespace access so a not-yet-exported symbol
// reads as `undefined` (a per-assertion RED: "not a function") instead of an ESM link error that
// would break the existing passing tests in this module.
import * as incidentRepo from '../incident-repo';

import { createFixture } from './incident-repo.fixture';

const __fixture = createFixture();

// --- resume watermark advance + human-message batch drain ------------------------
describe('resume watermark', () => {
  async function seedMsg(
    tenant: string,
    inc: string,
    author: string,
    content: string,
    secondsAgo: number,
  ): Promise<string> {
    const [r] = await __fixture.admin.db
      .insert(incidentMessages)
      .values({
        tenantId: tenant,
        incidentId: inc,
        author,
        kind: 'text',
        content,
        createdAt: sql`now() - make_interval(secs => ${secondsAgo})`,
      })
      .returning({ id: incidentMessages.id });
    return r!.id;
  }

  test('advanceResumeWatermark stamps last_resume_message_id only, fencing a redelivery (is distinct from)', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    // A prior RCA on the incident: the watermark advance must NOT touch it (reply/silent never overwrite).
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantA, id, 'gathering');
    await applyTriageResult(__fixture.app.db, __fixture.tenantA, id, {
      provider: 'claude',
      sessionId: 's',
      summary: 'ORIGINAL RCA',
      confidence: 70,
    });

    await incidentRepo.advanceResumeWatermark(__fixture.app.db, __fixture.tenantA, id, 'msg-1');
    let inc = await getIncident(__fixture.app.db, __fixture.tenantA, id);
    expect(inc?.lastResumeMessageId).toBe('msg-1');
    // RCA + lifecycle/progress untouched by the watermark advance.
    expect(inc?.rcaSummary).toBe('ORIGINAL RCA');
    expect(inc).toMatchObject({ status: 'open', investigationStatus: 'assessed' });

    // Age updated_at, then a redelivery of the SAME id: the `is distinct from` fence matches 0 rows, so
    // updated_at does not move (a correct no-op).
    await __fixture.admin.db
      .update(incidents)
      .set({ updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(incidents.id, id));
    const aged = await getIncident(__fixture.app.db, __fixture.tenantA, id);
    await incidentRepo.advanceResumeWatermark(__fixture.app.db, __fixture.tenantA, id, 'msg-1');
    inc = await getIncident(__fixture.app.db, __fixture.tenantA, id);
    expect(new Date(inc!.updatedAt).getTime()).toBe(new Date(aged!.updatedAt).getTime());

    // A NEW id advances the watermark (and bumps updated_at).
    await incidentRepo.advanceResumeWatermark(__fixture.app.db, __fixture.tenantA, id, 'msg-2');
    inc = await getIncident(__fixture.app.db, __fixture.tenantA, id);
    expect(inc?.lastResumeMessageId).toBe('msg-2');
    expect(new Date(inc!.updatedAt).getTime()).toBeGreaterThan(new Date(aged!.updatedAt).getTime());
  });

  test('a newer signal reassessment supersedes prior resume findings without moving the human watermark', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `signal-after-resume-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantA, id, {
      provider: 'fake',
      sessionId: 'initial',
      summary: 'Initial assessment',
      confidence: 50,
    });
    await incidentRepo.advanceResumeWatermark(
      __fixture.app.db,
      __fixture.tenantA,
      id,
      'human-reply-1',
    );
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantA, id, 'gathering');

    await applyTriageResult(__fixture.app.db, __fixture.tenantA, id, {
      provider: 'fake',
      sessionId: 'signal-version-2',
      summary: 'New signal assessment',
      confidence: 85,
      assessmentCause: 'signal',
    });

    expect(await getIncident(__fixture.app.db, __fixture.tenantA, id)).toMatchObject({
      rcaSummary: 'New signal assessment',
      confidence: 85,
      investigationStatus: 'assessed',
      lastResumeMessageId: 'human-reply-1',
    });
  });

  test('a signal reassessment cannot overwrite the recorded RCA after lifecycle becomes terminal', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `terminal-signal-assessment-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantA, id, {
      provider: 'fake',
      sessionId: 'settled',
      summary: 'Recorded terminal RCA',
      confidence: 80,
    });
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, id, 'resolved');

    await applyTriageResult(__fixture.app.db, __fixture.tenantA, id, {
      provider: 'fake',
      sessionId: 'late-signal',
      summary: 'Late signal reassessment',
      confidence: 40,
      assessmentCause: 'signal',
    });

    expect(await getIncident(__fixture.app.db, __fixture.tenantA, id)).toMatchObject({
      status: 'resolved',
      rcaSummary: 'Recorded terminal RCA',
      confidence: 80,
    });
  });

  test('advanceResumeWatermark leaves lifecycle and degraded progress untouched', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantA, id, 'gathering');
    await applyTriageResult(__fixture.app.db, __fixture.tenantA, id, {
      provider: 'claude',
      sessionId: 's',
      summary: 'ORIGINAL RCA',
      confidence: 70,
    });
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantA, id, 'gathering');
    // Degrade the current verification run; the lifecycle remains open.
    await degradeIncidentWithMessages(__fixture.app.db, __fixture.tenantA, id, [
      { author: 'system', kind: 'finding', content: 'brief' },
    ]);
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, id))?.investigationStatus).toBe(
      'degraded',
    );

    await incidentRepo.advanceResumeWatermark(__fixture.app.db, __fixture.tenantA, id, 'reply-1');
    const inc = await getIncident(__fixture.app.db, __fixture.tenantA, id);
    expect(inc).toMatchObject({ status: 'open', investigationStatus: 'degraded' });
    expect(inc?.lastResumeMessageId).toBe('reply-1');
    expect(inc?.rcaSummary).toBe('ORIGINAL RCA');
  });

  test('advanceResumeWatermark leaves a degraded incident degraded', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantA, id, 'gathering');
    await degradeIncidentWithMessages(__fixture.app.db, __fixture.tenantA, id, [
      { author: 'system', kind: 'finding', content: 'brief' },
    ]);
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, id))?.investigationStatus).toBe(
      'degraded',
    );

    await incidentRepo.advanceResumeWatermark(__fixture.app.db, __fixture.tenantA, id, 'silent-1');
    const inc = await getIncident(__fixture.app.db, __fixture.tenantA, id);
    expect(inc).toMatchObject({ status: 'open', investigationStatus: 'degraded' });
    expect(inc?.lastResumeMessageId).toBe('silent-1');
  });

  test('humanMessagesSince returns only human rows after the watermark, oldest-first, tenant-scoped', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    const m1 = await seedMsg(__fixture.tenantA, id, 'human', 'first reply', 300);
    await seedMsg(__fixture.tenantA, id, 'agent', 'agent note', 200); // excluded: not human
    const m2 = await seedMsg(__fixture.tenantA, id, 'human', 'second reply', 100);
    const m3 = await seedMsg(__fixture.tenantA, id, 'human', 'third reply', 50);

    // Null watermark: every human message, oldest-first, agent excluded.
    const all = await incidentRepo.humanMessagesSince(
      __fixture.app.db,
      __fixture.tenantA,
      id,
      null,
    );
    expect(all.map((r) => r.id)).toEqual([m1, m2, m3]);
    expect(all.map((r) => r.content)).toEqual(['first reply', 'second reply', 'third reply']);

    // After m1: only the strictly-newer human replies.
    const afterM1 = await incidentRepo.humanMessagesSince(
      __fixture.app.db,
      __fixture.tenantA,
      id,
      m1,
    );
    expect(afterM1.map((r) => r.id)).toEqual([m2, m3]);

    // After the newest: an empty batch (a redelivered job with nothing new drains nothing).
    expect(
      await incidentRepo.humanMessagesSince(__fixture.app.db, __fixture.tenantA, id, m3),
    ).toHaveLength(0);

    // Tenant-scoped: tenant B sees none of tenant A's human messages (RLS).
    expect(
      await incidentRepo.humanMessagesSince(__fixture.app.db, __fixture.tenantB, id, null),
    ).toHaveLength(0);
  });

  test('humanMessagesSince uses the message id tie-breaker when timestamps share a millisecond', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `same-ms-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const createdAt = new Date('2026-08-22T10:00:00.123Z');
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
      tx.insert(incidentMessages).values(
        ids.map((messageId, index) => ({
          id: messageId,
          tenantId: __fixture.tenantA,
          incidentId: id,
          author: 'human',
          content: `same-ms-${index + 1}`,
          createdAt,
        })),
      ),
    );

    const afterFirst = await incidentRepo.humanMessagesSince(
      __fixture.app.db,
      __fixture.tenantA,
      id,
      ids[0]!,
    );
    expect(afterFirst.map((message) => message.id)).toEqual(ids.slice(1));
  });
});

// listIncidents LEFT JOINs surface_bindings to surface the incident's origin channel. The join MUST
// carry a `surface` predicate: without it an incident bound on two surfaces fans out to duplicate rows,
// and the LIMIT counts the duplicates — silently returning fewer distinct incidents than asked for.
describe('listIncidents origin-channel join', () => {
  test('returns exactly one row per incident, even when bound on two surfaces', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    // A second surface's binding for the SAME incident. Written with the admin handle because the
    // Surface union is 'slack'-only today; the join predicate must still hold when it is not.
    await __fixture.admin.db.insert(surfaceBindings).values([
      {
        tenantId: __fixture.tenantA,
        incidentId: id,
        surface: 'slack',
        channel: 'C_SLACK',
        threadId: 'r1',
      },
      {
        tenantId: __fixture.tenantA,
        incidentId: id,
        surface: 'teams',
        channel: 'C_TEAMS',
        threadId: 'r2',
      },
    ]);

    const rows = await listIncidents(__fixture.app.db, __fixture.tenantA, { limit: 200 });
    expect(rows.filter((r) => r.id === id)).toHaveLength(1);
    expect(rows.find((r) => r.id === id)!.originChannel).toBe('C_SLACK');
  });
});

describe('incident workspace projections', () => {
  test('projects queued responder input alongside the currently processing investigation', async () => {
    const row = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const inserted = await __fixture.admin.db
      .insert(jobs)
      .values([
        {
          tenantId: __fixture.tenantA,
          type: 'triage',
          status: 'processing',
          stream: 'test',
          payload: { incidentId: row.id },
        },
        {
          tenantId: __fixture.tenantA,
          type: 'resume',
          status: 'queued',
          stream: 'test',
          payload: { incidentId: row.id },
        },
      ])
      .returning({ id: jobs.id });
    try {
      expect(
        await incidentRepo.getIncidentSummary(__fixture.app.db, __fixture.tenantA, row.id),
      ).toMatchObject({
        pendingAutomation: { type: 'triage', status: 'processing' },
        queuedResponderWork: { type: 'resume', status: 'queued' },
      });
    } finally {
      for (const item of inserted)
        await __fixture.admin.db.delete(jobs).where(eq(jobs.id, item.id));
    }
  });
  test('getIncidentSummary returns only the tenant-scoped public summary', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `public-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
      title: 'Checkout latency',
    });
    await __fixture.admin.db
      .update(incidents)
      .set({
        engineProvider: 'private-provider',
        engineSessionId: 'private-session',
        deployFingerprint: 'private-deploy-fingerprint',
        rcaSummary: 'Connection pool exhaustion',
        confidence: 87,
      })
      .where(eq(incidents.id, id));

    const summary = await incidentRepo.getIncidentSummary(__fixture.app.db, __fixture.tenantA, id);

    expect(Object.keys(summary!).sort()).toEqual(
      [
        'purpose',
        'alertSource',
        'archivedAt',
        'confidence',
        'correlationMaxAgeAt',
        'createdAt',
        'id',
        'investigationStatus',
        'latestInvestigationRun',
        'lifecycleVersion',
        'pendingAutomation',
        'queuedResponderWork',
        'rcaSummary',
        'service',
        'severity',
        'status',
        'title',
        'trustedAssessmentRunId',
      ].sort(),
    );
    expect(summary).toMatchObject({
      id,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
      status: 'open',
      investigationStatus: 'queued',
      latestInvestigationRun: null,
      lifecycleVersion: 0,
      title: 'Checkout latency',
      rcaSummary: 'Connection pool exhaustion',
      confidence: 87,
    });
    expect(summary!.createdAt).toBeInstanceOf(Date);
    expect(
      await incidentRepo.getIncidentSummary(__fixture.app.db, __fixture.tenantB, id),
    ).toBeNull();
  });

  test('public summary, detail, and list readers hide archived tombstones', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `deleted-public-${randomUUID()}`,
      alertSource: 'slack',
      service: 'deleted-public',
      severity: 'sev3',
    });
    const relatedId = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `deleted-related-${randomUUID()}`,
        alertSource: 'slack',
        service: 'visible-related',
        severity: 'sev3',
      })
    ).id;
    await recordIncidentRelation(__fixture.app.db, __fixture.tenantA, {
      sourceIncidentId: id,
      targetIncidentId: relatedId,
      type: 'recurrence_of',
      rationale: 'Historical recurrence before deletion.',
      evidence: ['provider fingerprint'],
      decidedBy: 'system',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-DELETED',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Hidden firing signal',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ archivedAt: new Date() })
      .where(eq(incidents.id, id));

    expect(
      await incidentRepo.getIncidentSummary(__fixture.app.db, __fixture.tenantA, id),
    ).toBeNull();
    expect(
      await incidentRepo.getIncidentDetail(__fixture.app.db, __fixture.tenantA, id),
    ).toBeNull();
    expect(
      (await incidentRepo.listIncidents(__fixture.app.db, __fixture.tenantA)).some(
        (row) => row.id === id,
      ),
    ).toBe(false);
    expect(
      (
        await incidentRepo.listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
          scope: 'all',
          limit: 100,
        })
      ).incidents.some((row) => row.id === id),
    ).toBe(false);
    expect(
      (
        await incidentRepo.listActiveIncidents(__fixture.app.db, __fixture.tenantA, {
          since: new Date(0),
        })
      ).some((row) => row.id === id),
    ).toBe(false);
    expect(
      await incidentRepo.listActiveIncidentServices(__fixture.app.db, __fixture.tenantA),
    ).not.toContain('deleted-public');
    expect(
      (await listUnresolvedSignals(__fixture.app.db, __fixture.tenantA)).some(
        (row) => row.incidentId === id,
      ),
    ).toBe(false);
    expect(await listIncidentRelations(__fixture.app.db, __fixture.tenantA, id)).toEqual([]);
    expect(
      (await listIncidentRelations(__fixture.app.db, __fixture.tenantA, relatedId)).some(
        (relation) => relation.sourceIncidentId === id,
      ),
    ).toBe(false);
  });

  test('listIncidentsPage keeps Slack origin metadata without duplicating or reordering rows', async () => {
    const older = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `paged-origin-older-${randomUUID()}`,
        alertSource: 'slack',
        service: 'billing',
        severity: 'sev3',
      })
    ).id;
    const newer = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `paged-origin-newer-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    await __fixture.admin.db
      .update(incidents)
      .set({ status: 'closed', createdAt: new Date('2026-08-18T10:00:00.000Z') })
      .where(eq(incidents.id, older));
    await __fixture.admin.db
      .update(incidents)
      .set({ status: 'closed', createdAt: new Date('2026-08-18T10:01:00.000Z') })
      .where(eq(incidents.id, newer));
    await __fixture.admin.db.insert(surfaceBindings).values([
      {
        tenantId: __fixture.tenantA,
        incidentId: newer,
        surface: 'slack',
        channel: 'C258',
        threadId: 'slack-thread',
      },
      {
        tenantId: __fixture.tenantA,
        incidentId: newer,
        surface: 'teams',
        channel: 'C258',
        threadId: 'teams-thread',
      },
    ]);
    await __fixture.admin.db.insert(inboundChannels).values([
      {
        tenantId: __fixture.tenantA,
        surface: 'slack',
        channel: 'C258',
        channelName: '#checkout-alerts',
      },
      {
        tenantId: __fixture.tenantB,
        surface: 'slack',
        channel: 'C258',
        channelName: '#foreign-alerts',
      },
    ]);

    const page = await incidentRepo.listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
      scope: 'closed',
      limit: 100,
    });
    const scopedRows = page.incidents.filter((row) => row.id === newer || row.id === older);

    expect(scopedRows.map((row) => row.id)).toEqual([newer, older]);
    expect(scopedRows.filter((row) => row.id === newer)).toHaveLength(1);
    expect(scopedRows.find((row) => row.id === newer)).toMatchObject({
      originChannel: 'C258',
      originChannelName: '#checkout-alerts',
    });
  });
});
