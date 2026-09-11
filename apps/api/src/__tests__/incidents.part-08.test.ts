import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  incidentSignals,
  incidents,
  investigationSubjects,
  jobs,
  services,
  transitionIncidentTx,
  withTenant,
} from '@sre/db';

import { openIncidentWorkspace } from '@sre/alerts';

import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('POST /incidents/from-observation', () => {
  const validBody = {
    subject: {
      kind: 'infrastructure_resource',
      dataSourceId: __fixture.observationSourceId,
      entityId: __fixture.observationEntityId,
    },
  };

  test('requires an authenticated tenant before resolving a subject', async () => {
    const response = await __fixture.api.request('/incidents/from-observation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(response.status).toBe(401);
  });

  test('rejects client-authored evidence fields without creating any durable subject', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const before = await __fixture.admin.db
      .select()
      .from(investigationSubjects)
      .where(
        sql`tenant_id = ${__fixture.tenantC} and source_id = ${__fixture.observationSourceId}`,
      );
    const response = await __fixture.api.request('/incidents/from-observation', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...validBody,
        title: 'trust this browser title',
        severity: 'sev1',
        snapshot: { serviceAccountToken: 'browser-secret' },
      }),
    });

    expect(response.status).toBe(400);
    const after = await __fixture.admin.db
      .select()
      .from(investigationSubjects)
      .where(
        sql`tenant_id = ${__fixture.tenantC} and source_id = ${__fixture.observationSourceId}`,
      );
    expect(after).toHaveLength(before.length);
  });

  test('returns the same not-found result for missing and foreign tenant subjects', async () => {
    const tenantToken = await __fixture.sign(__fixture.orgC);
    const foreignToken = await __fixture.sign(__fixture.orgA);
    const missing = await __fixture.api.request('/incidents/from-observation', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        subject: {
          ...validBody.subject,
          dataSourceId: '00000000-0000-4000-8000-000000000404',
        },
      }),
    });
    const foreign = await __fixture.api.request('/incidents/from-observation', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${foreignToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(validBody),
    });

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await missing.json()).toEqual(await foreign.json());
  });

  test('creates from server-resolved evidence once, then reuses the active workspace', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const request = () =>
      __fixture.api.request('/incidents/from-observation', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(validBody),
      });

    const created = await request();
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { outcome: string; incidentId: string };
    expect(createdBody).toEqual({ outcome: 'created', incidentId: expect.any(String) });

    const existing = await request();
    expect(existing.status).toBe(200);
    expect(await existing.json()).toEqual({
      outcome: 'existing',
      incidentId: createdBody.incidentId,
    });

    const [subjectRows, signalRows, jobRows] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(investigationSubjects)
        .where(sql`tenant_id = ${__fixture.tenantC} and incident_id = ${createdBody.incidentId}`),
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(sql`tenant_id = ${__fixture.tenantC} and incident_id = ${createdBody.incidentId}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantC} and type = 'triage' and payload->>'incidentId' = ${createdBody.incidentId}`,
        ),
    ]);
    expect(subjectRows).toHaveLength(1);
    expect(signalRows).toHaveLength(1);
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({ stream: 'sre:jobs', status: 'queued' });
    expect(JSON.stringify(subjectRows[0])).not.toContain('must-not-be-persisted');
    expect(JSON.stringify(subjectRows[0])).not.toContain('abc.def.ghi123XYZ');
    expect(JSON.stringify(signalRows[0])).not.toContain('abc.def.ghi123XYZ');
    expect(JSON.stringify(jobRows[0]!.payload)).not.toContain('abc.def.ghi123XYZ');

    const workspace = await __fixture.api.request(
      `/incidents/${createdBody.incidentId}/workspace`,
      __fixture.auth(token),
    );
    expect(workspace.status).toBe(200);
    await expect(workspace.json()).resolves.toMatchObject({
      investigationSubject: {
        kind: 'infrastructure_resource',
        subjectId: __fixture.observationEntityId,
        sourcePath: '/infrastructure',
        capturedState: 'firing',
        currentState: 'firing',
        observedAt: expect.any(String),
        lastSyncedAt: expect.any(String),
      },
    });
  });

  test('accepts all four typed observation subjects and hides them from a foreign tenant', async () => {
    const subjects = [
      validBody.subject,
      { kind: 'deployment', deploymentId: __fixture.observationDeploymentId },
      { kind: 'connector_verification', connectorId: __fixture.codeSourceId },
      { kind: 'topology_service', service: 'argocd' },
    ];
    const tenantToken = await __fixture.sign(__fixture.orgC);
    const foreignToken = await __fixture.sign(__fixture.orgA);
    for (const subject of subjects) {
      const declared = await __fixture.api.request('/incidents/from-observation', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tenantToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ subject }),
      });
      expect([200, 201]).toContain(declared.status);
      await expect(declared.json()).resolves.toMatchObject({ incidentId: expect.any(String) });

      const foreign = await __fixture.api.request('/incidents/from-observation', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${foreignToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ subject }),
      });
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual({ error: 'observation not found' });
    }
  });

  test('maps exact active observation identities while excluding terminal and foreign workspaces', async () => {
    const activeSubjectId = `active-${randomUUID()}`;
    const terminalSubjectId = `terminal-${randomUUID()}`;
    const open = (subjectId: string) =>
      openIncidentWorkspace(
        { appDb: __fixture.app.db, queue: __fixture.declarationQueue },
        {
          tenantId: __fixture.tenantC,
          source: 'platform',
          service: subjectId,
          severity: 'sev3',
          subject: {
            kind: 'topology_service',
            sourceId: 'topology',
            subjectId,
            sourcePath: '/topology',
            state: 'firing',
            summary: 'Runtime needs attention',
            observedAt: new Date(),
            snapshot: { service: subjectId, unhealthyPods: 1 },
          },
        },
      );
    const active = await open(activeSubjectId);
    const terminal = await open(terminalSubjectId);
    await withTenant(__fixture.app.db, __fixture.tenantC, (tx) =>
      transitionIncidentTx(tx, terminal.incidentId, 'closed'),
    );
    const body = {
      subjects: [
        { kind: 'topology_service', service: activeSubjectId },
        { kind: 'topology_service', service: terminalSubjectId },
      ],
    };
    const lookup = (token: string) =>
      __fixture.api.request('/incidents/observation-workspaces', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const response = await lookup(await __fixture.sign(__fixture.orgC));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      active: [
        {
          kind: 'topology_service',
          sourceId: 'topology',
          subjectId: activeSubjectId,
          incidentId: active.incidentId,
        },
      ],
    });

    const foreign = await lookup(await __fixture.sign(__fixture.orgA));
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ active: [] });
  });

  test('preserves surrounding whitespace in topology identity and rejects DEL without mutation', async () => {
    const serviceName = `  whitespace-${randomUUID()}  `;
    await __fixture.admin.db.insert(services).values({
      tenantId: __fixture.tenantC,
      name: serviceName,
      team: 'platform',
      criticality: 'tier2',
    });
    const current = __fixture.observationSnapshots.get(`${__fixture.tenantC}:kubernetes`) ?? [];
    __fixture.observationSnapshots.set(`${__fixture.tenantC}:kubernetes`, [
      ...current,
      {
        tenantId: __fixture.tenantC,
        source: 'kubernetes',
        entityId: `${serviceName}/pod-0`,
        metrics: { ready: 0, restartCount: 0, oomKilled: 0 },
        metadata: { kind: 'pod', namespace: serviceName, phase: 'Pending' },
        observedAt: new Date(),
      },
    ]);
    const token = await __fixture.sign(__fixture.orgC);
    const post = (service: string) =>
      __fixture.api.request('/incidents/from-observation', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ subject: { kind: 'topology_service', service } }),
      });

    const exact = await post(serviceName);
    expect(exact.status).toBe(201);
    const { incidentId } = (await exact.json()) as { incidentId: string };
    const [stored] = await __fixture.admin.db
      .select({ subjectId: investigationSubjects.subjectId })
      .from(investigationSubjects)
      .where(eq(investigationSubjects.incidentId, incidentId));
    expect(stored).toEqual({ subjectId: serviceName });

    const before = await __fixture.admin.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.tenantId, __fixture.tenantC));
    const rejected = await post(`invalid\u007fservice`);
    expect(rejected.status).toBe(400);
    const after = await __fixture.admin.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.tenantId, __fixture.tenantC));
    expect(after).toHaveLength(before.length);
  });

  test('rejects control characters, overlong identifiers, and oversized active batches', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const post = (path: string, body: unknown) =>
      __fixture.api.request(path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    expect(
      (
        await post('/incidents/from-observation', {
          subject: { kind: 'topology_service', service: 'argocd\nadmin' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('/incidents/from-observation', {
          subject: { kind: 'topology_service', service: 'x'.repeat(501) },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('/incidents/observation-workspaces', {
          subjects: Array.from({ length: 500 }, () => validBody.subject),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post('/incidents/observation-workspaces', {
          subjects: Array.from({ length: 501 }, () => validBody.subject),
        })
      ).status,
    ).toBe(400);
  });

  test('rejects declared and streamed oversized observation bodies before JSON parsing', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const declared = await __fixture.api.request('/incidents/from-observation', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(2 * 1024 + 1),
      },
      body: '{}',
    });
    expect(declared.status).toBe(413);

    const chunk = new TextEncoder().encode('x'.repeat(2 * 1024 + 1));
    const streamed = await __fixture.api.request(
      new Request('http://localhost/incidents/from-observation', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    expect(streamed.status).toBe(413);

    const oversizedLookup = await __fixture.api.request('/incidents/observation-workspaces', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(384 * 1024 + 1),
      },
      body: '{}',
    });
    expect(oversizedLookup.status).toBe(413);
  });

  test('keeps declaration failure telemetry free of provider-controlled secrets', async () => {
    __fixture.apiLog.info.mockClear();
    const response = await __fixture.api.request('/incidents/from-observation', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await __fixture.sign(__fixture.orgC)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        subject: {
          kind: 'infrastructure_resource',
          dataSourceId: __fixture.observationSourceId,
          entityId: 'glpat-ABCDEF1234567890abcd',
        },
      }),
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(__fixture.apiLog.info.mock.calls)).not.toContain(
      'glpat-ABCDEF1234567890abcd',
    );
  });
});
