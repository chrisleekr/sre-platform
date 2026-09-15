import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { applySignalObservation, createIncident, recordIncidentRelation } from '@sre/db';

type Body = { incidents: Array<{ service: string; status: string }> };

import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('GET /incidents', () => {
  test('lists the tenant’s incidents, newest first', async () => {
    const res = await __fixture.api.request(
      '/incidents',
      __fixture.auth(await __fixture.sign(__fixture.orgA)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.incidents).toHaveLength(2);
    const services = body.incidents.map((i) => i.service);
    expect(services).toContain('checkout');
    expect(services).toContain('api');
    expect(services).not.toContain('db');
  });

  test('another tenant sees only its own (RLS)', async () => {
    const res = await __fixture.api.request(
      '/incidents',
      __fixture.auth(await __fixture.sign(__fixture.orgB)),
    );
    const body = (await res.json()) as Body;
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0]!.service).toBe('db');
  });

  test('filters by status', async () => {
    const res = await __fixture.api.request(
      '/incidents?status=mitigated',
      __fixture.auth(await __fixture.sign(__fixture.orgA)),
    );
    const body = (await res.json()) as Body;
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0]!.service).toBe('checkout');
  });

  test('rejects the removed acknowledged lifecycle status', async () => {
    const res = await __fixture.api.request(
      '/incidents?status=acknowledged',
      __fixture.auth(await __fixture.sign(__fixture.orgA)),
    );
    expect(res.status).toBe(400);
  });

  test('requires authentication', async () => {
    expect((await __fixture.api.request('/incidents')).status).toBe(401);
  });

  // the dashboard groups incidents by the channel they arrived in, showing the NAME. Both come
  // from the incident's surface binding joined to the tenant's inbound-channel subscription.
  test('returns each incident’s origin channel id and name', async () => {
    const res = await __fixture.api.request(
      '/incidents',
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      incidents: Array<{ id: string; originChannel?: string; originChannelName?: string }>;
    };
    const incident = body.incidents.find((i) => i.id === __fixture.originIncidentId);
    expect(incident).toBeDefined();
    expect(incident!.originChannel).toBe(__fixture.ORIGIN_CHANNEL_ID);
    expect(incident!.originChannelName).toBe(__fixture.ORIGIN_CHANNEL_NAME);
  });

  test('the origin channel is not visible to another tenant (RLS)', async () => {
    const res = await __fixture.api.request(
      '/incidents',
      __fixture.auth(await __fixture.sign(__fixture.orgB)),
    );
    const body = (await res.json()) as {
      incidents: Array<{ id: string; originChannel?: string; originChannelName?: string }>;
    };
    // B sees only its own incident, and none of C's channel metadata leaks into it.
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents.some((i) => i.id === __fixture.originIncidentId)).toBe(false);
    expect(body.incidents.some((i) => i.originChannel === __fixture.ORIGIN_CHANNEL_ID)).toBe(false);
    expect(body.incidents.some((i) => i.originChannelName === __fixture.ORIGIN_CHANNEL_NAME)).toBe(
      false,
    );
  });

  test('the scoped queue path preserves origin metadata and one row per incident', async () => {
    const res = await __fixture.api.request(
      '/incidents?state=open',
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      incidents: Array<{ id: string; originChannel?: string; originChannelName?: string }>;
    };
    const rows = body.incidents.filter((incident) => incident.id === __fixture.originIncidentId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      originChannel: __fixture.ORIGIN_CHANNEL_ID,
      originChannelName: __fixture.ORIGIN_CHANNEL_NAME,
    });
  });

  test('scrubs legacy provider titles at every incident API boundary', async () => {
    const gitlabToken = 'glpat-ABCDEF1234567890abcd';
    const highEntropyToken = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2';
    const rawTitle = `Pod ${gitlabToken} exposed ${highEntropyToken}`;
    const publicTitle = 'Pod [REDACTED] exposed [REDACTED]';
    const relatedPublicTitle = 'Related [REDACTED]';
    const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `legacy-title-${randomUUID()}`,
      alertSource: 'slack',
      service: 'slack:C-legacy',
      severity: 'sev3',
      title: rawTitle,
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-legacy',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Legacy provider signal',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
      alertName: rawTitle,
    });
    const related = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `legacy-title-related-${randomUUID()}`,
      alertSource: 'manual',
      service: 'checkout',
      severity: 'sev3',
      title: `Related ${gitlabToken}`,
    });
    await recordIncidentRelation(__fixture.app.db, __fixture.tenantC, {
      sourceIncidentId: incident.id,
      targetIncidentId: related.id,
      type: 'possible_related',
      rationale: 'The provider observations overlap.',
      evidence: ['provider:test'],
      decidedBy: 'system',
    });
    const auth = __fixture.auth(await __fixture.sign(__fixture.orgC));

    const list = await __fixture.api.request('/incidents?state=open', auth);
    const listed = (
      (await list.json()) as {
        incidents: Array<{ id: string; title: string; displayTitle: string }>;
      }
    ).incidents.find((item) => item.id === incident.id);
    expect(listed?.title).toBe(publicTitle);
    expect(listed?.displayTitle).toBe(publicTitle);

    const detail = await __fixture.api.request(`/incidents/${incident.id}`, auth);
    const detailBody = (await detail.json()) as {
      title: string;
      relations: Array<{
        sourceIncident: { title: string };
        targetIncident: { title: string };
      }>;
    };
    expect(detailBody).toMatchObject({
      title: publicTitle,
      relations: [
        {
          sourceIncident: { title: publicTitle },
          targetIncident: { title: relatedPublicTitle },
        },
      ],
    });
    expect(JSON.stringify(detailBody)).not.toContain(gitlabToken);
    expect(JSON.stringify(detailBody)).not.toContain(highEntropyToken);

    const workspace = await __fixture.api.request(`/incidents/${incident.id}/workspace`, auth);
    const body = (await workspace.json()) as {
      incident: { title: string };
      signals: Array<{ alertName: string }>;
      relations: Array<{
        sourceIncident: { title: string };
        targetIncident: { title: string };
      }>;
    };
    expect(body.incident.title).toBe(publicTitle);
    expect(body.signals[0]?.alertName).toBe(publicTitle);
    expect(body.relations[0]?.sourceIncident.title).toBe(publicTitle);
    expect(body.relations[0]?.targetIncident.title).toBe(relatedPublicTitle);
    expect(JSON.stringify(body)).not.toContain(gitlabToken);
    expect(JSON.stringify(body)).not.toContain(highEntropyToken);
  });
});

describe('POST /incidents/:id/lifecycle', () => {
  test('applies an audited transition once and rejects stale or cross-tenant commands', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `api-lifecycle-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    const requestId = randomUUID();
    const token = await __fixture.sign(__fixture.orgC);
    const post = (body: unknown, bearer = token) =>
      __fixture.api.request(`/incidents/${id}/lifecycle`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    const removedAcknowledgement = await post({
      to: 'acknowledged',
      reason: 'On-call accepted ownership. key sk-abcdefghijklmnopqrstuvwx1234',
      requestId,
      expectedVersion: 0,
    });
    expect(removedAcknowledgement.status).toBe(400);

    const mitigated = await post({
      to: 'mitigated',
      reason: 'Traffic shifted. key sk-abcdefghijklmnopqrstuvwx1234',
      requestId,
      expectedVersion: 0,
    });
    expect(mitigated.status).toBe(200);
    expect(await mitigated.json()).toMatchObject({
      transition: { outcome: 'applied', from: 'open', to: 'mitigated', version: 1 },
    });

    const duplicate = await post({
      to: 'mitigated',
      reason: 'HTTP retry',
      requestId,
      expectedVersion: 0,
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ transition: { outcome: 'noop', version: 1 } });

    const unfenced = await post({
      to: 'resolved',
      reason: 'Missing the state version.',
      requestId: randomUUID(),
    });
    expect(unfenced.status).toBe(400);

    const stale = await post({
      to: 'resolved',
      reason: 'The screen was stale.',
      requestId: randomUUID(),
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'stale' });

    const resolved = await post({
      to: 'resolved',
      reason: 'Recovery was verified.',
      requestId: randomUUID(),
      expectedVersion: 1,
    });
    expect(resolved.status).toBe(200);

    const foreign = await post(
      {
        to: 'closed',
        reason: 'Cross-tenant attempt.',
        requestId: randomUUID(),
        expectedVersion: 2,
      },
      await __fixture.sign(__fixture.orgB),
    );
    expect(foreign.status).toBe(404);

    const audit = (await __fixture.hub.history(__fixture.tenantC, id)).filter(
      (message) => message.kind === 'lifecycle',
    );
    expect(audit).toHaveLength(2);
    expect(audit.map((message) => message.lifecycleTo)).toEqual(['mitigated', 'resolved']);
    expect(audit[0]!.content).not.toContain('sk-abcdefghijklmnopqrstuvwx1234');
  });
});
