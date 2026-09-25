import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import {
  applySignalObservation,
  createIncident,
  getIncident,
  incidentFeedback,
  incidentSignals,
  incidents,
  recordSurfaceBinding,
  surfaceDeliveries,
} from '@sre/db';

import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('POST /incidents/:id/archive', () => {
  test('soft-deletes a terminal incident with one internal audit event and no restore path', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `api-archive-${randomUUID()}`,
        alertSource: 'slack',
        service: 'archive-test',
        severity: 'sev3',
      })
    ).id;
    const feedbackSignal = await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-ARCHIVED-FEEDBACK',
      externalMessageId: randomUUID(),
      state: 'resolved',
      summary: 'The archived test signal cleared.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ status: 'resolved' })
      .where(eq(incidents.id, id));
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantC, {
      incidentId: id,
      surface: 'slack',
      channel: __fixture.ORIGIN_CHANNEL_ID,
      threadId: `archive-${randomUUID()}`,
    });
    const token = await __fixture.sign(__fixture.orgC);
    const requestId = randomUUID();
    const post = (body: unknown, bearer = token) =>
      __fixture.api.request(`/incidents/${id}/archive`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    const archived = await post({
      archived: true,
      reason: 'Test incident. key sk-abcdefghijklmnopqrstuvwx1234',
      requestId,
      expectedVersion: 0,
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({
      archive: { outcome: 'applied', lifecycleVersion: 0 },
    });

    const duplicate = await post({
      archived: true,
      reason: 'HTTP retry',
      requestId,
      expectedVersion: 0,
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ archive: { outcome: 'noop' } });

    const newDeleteAttempt = await post({
      archived: true,
      reason: 'Probe a deleted incident.',
      requestId: randomUUID(),
      expectedVersion: 0,
    });
    expect(newDeleteAttempt.status).toBe(404);
    expect(await newDeleteAttempt.json()).toEqual({ error: 'incident not found' });

    const malformedDeletedAttempt = await post({ archived: true });
    expect(malformedDeletedAttempt.status).toBe(404);
    expect(await malformedDeletedAttempt.json()).toEqual({ error: 'incident not found' });

    const detail = await __fixture.api.request(`/incidents/${id}`, __fixture.auth(token));
    expect(detail.status).toBe(404);
    expect(await detail.json()).toEqual({ error: 'incident not found' });
    const targetIncidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `deleted-command-target-${randomUUID()}`,
        alertSource: 'slack',
        service: 'archive-target',
        severity: 'sev3',
      })
    ).id;
    const relationBody = JSON.stringify({
      targetIncidentId,
      rationale: 'Deleted incidents cannot be corrected.',
      evidence: ['The source incident was deleted.'],
    });
    const subordinateId = randomUUID();
    const hiddenResponses = await Promise.all([
      __fixture.api.request(`/incidents/${id}/workspace`, __fixture.auth(token)),
      __fixture.api.request(`/incidents/${id}/slack-permalink`, __fixture.auth(token)),
      __fixture.api.request(`/incidents/${id}/code-context/confirm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          repositoryId: '1',
          dataSourceId: randomUUID(),
        }),
      }),
      ...['merge', 'split', 'unrelated'].map((command) =>
        __fixture.api.request(`/incidents/${id}/${command}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: relationBody,
        }),
      ),
      __fixture.api.request(`/incidents/${id}/messages`, __fixture.auth(token)),
      __fixture.api.request(
        `/incidents/${id}/messages/${subordinateId}/deliveries`,
        __fixture.auth(token),
      ),
      __fixture.api.request(`/incidents/${id}/evidence`, __fixture.auth(token)),
      __fixture.api.request(`/incidents/${id}/evidence/${subordinateId}`, __fixture.auth(token)),
      __fixture.api.request(`/incidents/${id}/feedback`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          targetType: 'noise',
          targetId: feedbackSignal.signal.id,
          decision: 'noise',
          rationale: 'Deleted incidents cannot accept feedback.',
          replacement: null,
        }),
      }),
      __fixture.api.request(`/incidents/${id}/generate-runbook`, {
        method: 'POST',
        ...__fixture.auth(token),
      }),
      __fixture.api.request(`/incidents/${id}/approvals/${subordinateId}/decide`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ optionId: 'approve' }),
      }),
    ]);
    expect(hiddenResponses.map((response) => response.status)).toEqual(
      hiddenResponses.map(() => 404),
    );
    expect(
      await __fixture.admin.db
        .select({ id: incidentFeedback.id })
        .from(incidentFeedback)
        .where(eq(incidentFeedback.incidentId, id)),
    ).toEqual([]);
    expect((await getIncident(__fixture.app.db, __fixture.tenantC, id))?.archivedAt).toBeInstanceOf(
      Date,
    );
    const audit = (await __fixture.hub.history(__fixture.tenantC, id)).filter(
      (message) => message.kind === 'archive',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.content).toContain('Incident deleted');
    expect(audit[0]!.content).not.toContain('sk-abcdefghijklmnopqrstuvwx1234');
    expect(
      await __fixture.admin.db
        .select({ id: surfaceDeliveries.id })
        .from(surfaceDeliveries)
        .where(eq(surfaceDeliveries.messageId, audit[0]!.id)),
    ).toHaveLength(0);

    const reopen = await __fixture.api.request(`/incidents/${id}/lifecycle`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        to: 'open',
        reason: 'Try to reopen an archived record.',
        requestId: randomUUID(),
        expectedVersion: 0,
      }),
    });
    expect(reopen.status).toBe(404);
    expect(await reopen.json()).toEqual({ error: 'incident not found' });

    expect(
      (
        (await (
          await __fixture.api.request('/incidents?state=closed', __fixture.auth(token))
        ).json()) as {
          incidents: Array<{ id: string }>;
        }
      ).incidents.some((incident) => incident.id === id),
    ).toBe(false);
    expect(
      (
        (await (
          await __fixture.api.request('/incidents?state=all', __fixture.auth(token))
        ).json()) as {
          incidents: Array<{ id: string }>;
        }
      ).incidents.some((incident) => incident.id === id),
    ).toBe(false);

    expect(
      (
        await post(
          {
            archived: false,
            reason: 'Cross-tenant restore attempt.',
            requestId: randomUUID(),
            expectedVersion: 0,
          },
          await __fixture.sign(__fixture.orgB),
        )
      ).status,
    ).toBe(404);

    const restore = await post({
      archived: false,
      reason: 'Restore for renewed review.',
      requestId: randomUUID(),
      expectedVersion: 0,
    });
    expect(restore.status).toBe(404);
    expect(await restore.json()).toEqual({ error: 'incident not found' });
    expect((await getIncident(__fixture.app.db, __fixture.tenantC, id))?.archivedAt).toBeInstanceOf(
      Date,
    );
  });

  test('refuses to archive an active incident', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `api-active-archive-${randomUUID()}`,
        alertSource: 'slack',
        service: 'active-archive-test',
        severity: 'sev3',
      })
    ).id;
    const response = await __fixture.api.request(`/incidents/${id}/archive`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await __fixture.sign(__fixture.orgC)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        archived: true,
        reason: 'Hide active work.',
        requestId: randomUUID(),
        expectedVersion: 0,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'active' });
  });

  test('archives a closed incident with an active signal but still blocks resolved incidents', async () => {
    const createTerminalWithSignal = async (status: 'resolved' | 'closed') => {
      const id = (
        await createIncident(__fixture.app.db, __fixture.tenantC, {
          fingerprint: `api-active-signal-${status}-${randomUUID()}`,
          alertSource: 'slack',
          service: 'active-signal-archive-test',
          severity: 'sev3',
        })
      ).id;
      await __fixture.admin.db.update(incidents).set({ status }).where(eq(incidents.id, id));
      await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
        incidentId: id,
        surface: 'slack',
        channel: __fixture.ORIGIN_CHANNEL_ID,
        externalMessageId: `active-signal-${id}`,
        state: 'firing',
        summary: 'Provider signal remains active',
        contentHash: randomUUID(),
        eventKey: `active-signal-${randomUUID()}`,
        eventAt: new Date(),
      });
      return id;
    };
    const token = await __fixture.sign(__fixture.orgC);
    const post = (id: string) =>
      __fixture.api.request(`/incidents/${id}/archive`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          archived: true,
          reason: 'Responder deliberately closed this incident.',
          requestId: randomUUID(),
          expectedVersion: 0,
        }),
      });

    const resolvedId = await createTerminalWithSignal('resolved');
    const resolved = await post(resolvedId);
    expect(resolved.status).toBe(409);
    expect(await resolved.json()).toMatchObject({ error: 'active_signals' });

    const closedId = await createTerminalWithSignal('closed');
    const closed = await post(closedId);
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ archive: { outcome: 'applied' } });
    expect(await getIncident(__fixture.app.db, __fixture.tenantC, closedId)).toMatchObject({
      status: 'closed',
      archivedAt: expect.any(Date),
    });
    expect(
      await __fixture.admin.db
        .select({ state: incidentSignals.state })
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, closedId)),
    ).toEqual([{ state: 'firing' }]);
  });
});

describe('incident relationship correction routes', () => {
  test('validates, joins, splits, and records an unrelated decision with durable audit messages', async () => {
    const sourceIncidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `correction-source-${randomUUID()}`,
        alertSource: 'prometheus',
        service: 'checkout',
        severity: 'sev2',
        investigationStatus: 'assessed',
      })
    ).id;
    const targetIncidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `correction-target-${randomUUID()}`,
        alertSource: 'prometheus',
        service: 'database',
        severity: 'sev2',
        investigationStatus: 'assessed',
      })
    ).id;
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantC, {
      incidentId: sourceIncidentId,
      surface: 'slack',
      channel: 'C-CORRECTION-API',
      threadId: '1788000000.000101',
    });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantC, {
      incidentId: targetIncidentId,
      surface: 'slack',
      channel: 'C-CORRECTION-API',
      threadId: '1788000000.000102',
    });
    const token = await __fixture.sign(__fixture.orgC);
    const post = (action: 'merge' | 'split' | 'unrelated', body: unknown) =>
      __fixture.api.request(`/incidents/${sourceIncidentId}/${action}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    expect(
      (
        await __fixture.api.request(`/incidents/not-a-uuid/merge`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await __fixture.api.request(`/incidents/${sourceIncidentId}/merge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
    await expect(
      (
        await post('merge', {
          targetIncidentId: 'not-a-uuid',
          rationale: 'Same cause.',
          evidence: ['trace:shared'],
        })
      ).json(),
    ).resolves.toEqual({ error: 'valid targetIncidentId required' });
    await expect(
      (
        await post('merge', {
          targetIncidentId,
          rationale: 'Same cause.',
          evidence: [],
        })
      ).json(),
    ).resolves.toEqual({ error: 'one to twenty evidence lines are required' });

    const merged = await post('merge', {
      targetIncidentId,
      rationale: 'Both investigations found the same database lock.',
      evidence: ['trace:shared', 'deployment:abc123'],
    });
    expect(merged.status).toBe(200);
    await expect(merged.json()).resolves.toMatchObject({ relation: { type: 'merged_into' } });

    const split = await post('split', {
      targetIncidentId,
      rationale: 'The source alert has an independent firing cause.',
      evidence: ['trace:source-only'],
    });
    expect(split.status).toBe(200);
    await expect(split.json()).resolves.toMatchObject({ relation: { type: 'split_from' } });

    const unrelated = await post('unrelated', {
      targetIncidentId,
      rationale: 'The alerts now have independent evidence.',
      evidence: ['trace:different'],
    });
    expect(unrelated.status).toBe(200);
    await expect(unrelated.json()).resolves.toMatchObject({ relation: { type: 'unrelated' } });

    const audit = [
      ...(await __fixture.hub.history(__fixture.tenantC, sourceIncidentId)),
      ...(await __fixture.hub.history(__fixture.tenantC, targetIncidentId)),
    ];
    expect(
      audit.filter((message) => message.kind === 'relationship').length,
    ).toBeGreaterThanOrEqual(6);
    const workspace = await __fixture.api.request(
      `/incidents/${sourceIncidentId}/workspace`,
      __fixture.auth(token),
    );
    expect(workspace.status).toBe(200);
    await expect(workspace.json()).resolves.toMatchObject({
      feedback: expect.arrayContaining([
        expect.objectContaining({ targetType: 'correlation', decision: 'group' }),
        expect.objectContaining({ targetType: 'correlation', decision: 'separate' }),
      ]),
    });
  });
});

describe('GET /incidents/:id public detail', () => {
  test('returns the structured assessment and Slack context for an incident in the caller tenant', async () => {
    const res = await __fixture.api.request(
      `/incidents/${__fixture.runbookIncidentId}`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      [
        'purpose',
        'alertSource',
        'archivedAt',
        'attentionReason',
        'operatorDecision',
        'assessmentUpdatedAt',
        'assessmentEvidenceIds',
        'confidence',
        'correlationMaxAgeAt',
        'createdAt',
        'currentState',
        'deployCorrelated',
        'displayTitle',
        'titleSource',
        'engineModel',
        'engineProvider',
        'id',
        'impact',
        'investigationStatus',
        'latestInvestigationRun',
        'lifecycleVersion',
        'nextStep',
        'occurrenceCount',
        'originChannel',
        'originChannelName',
        'originSurface',
        'originThreadId',
        'pendingApprovalCount',
        'pendingAutomation',
        'queuedResponderWork',
        'rankedHypotheses',
        'rcaSummary',
        'recoveryState',
        'recoveryAttempt',
        'recoveryEvidenceIds',
        'recoveryMaxChecks',
        'recoveryNextCheckAt',
        'recoveryNextStep',
        'recoveryScheduleReason',
        'recoverySummary',
        'recoveryUnknowns',
        'recoveryQuestions',
        'recoveryUpdatedAt',
        'relations',
        'requiresHumanAttention',
        'resolvedAt',
        'resolutionPolicy',
        'resolutionBasis',
        'mitigatedAt',
        'closedAt',
        'service',
        'severity',
        'status',
        'title',
        'trustedAssessmentRunId',
        'unknowns',
        'updatedAt',
      ].sort(),
    );
    expect(body).toMatchObject({
      id: __fixture.runbookIncidentId,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
      status: 'open',
      investigationStatus: 'queued',
      latestInvestigationRun: null,
      lifecycleVersion: 0,
      originSurface: null,
      originChannel: null,
      originChannelName: null,
      originThreadId: null,
    });
    expect(typeof body.createdAt).toBe('string');
  });

  test('returns the incident Slack conversation context without exposing another tenant', async () => {
    const res = await __fixture.api.request(
      `/incidents/${__fixture.originIncidentId}`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: __fixture.originIncidentId,
      originSurface: 'slack',
      originChannel: __fixture.ORIGIN_CHANNEL_ID,
      originChannelName: __fixture.ORIGIN_CHANNEL_NAME,
      originThreadId: '1783760625.776459',
    });

    expect(
      (
        await __fixture.api.request(
          `/incidents/${__fixture.originIncidentId}`,
          __fixture.auth(await __fixture.sign(__fixture.orgB)),
        )
      ).status,
    ).toBe(404);
  });

  test.each([
    ['malformed', 'not-a-uuid', () => __fixture.sign(__fixture.orgC)],
    ['missing', randomUUID(), () => __fixture.sign(__fixture.orgC)],
    ['foreign', __fixture.runbookIncidentId, () => __fixture.sign(__fixture.orgA)],
  ])('returns the same non-disclosing 404 for a %s id', async (_case, id, token) => {
    const res = await __fixture.api.request(`/incidents/${id}`, __fixture.auth(await token()));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify({ error: 'incident not found' }));
  });

  test('requires authentication', async () => {
    expect((await __fixture.api.request(`/incidents/${__fixture.runbookIncidentId}`)).status).toBe(
      401,
    );
  });
});
