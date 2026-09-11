import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, inArray, sql } from 'drizzle-orm';

import {
  agentToolCalls,
  createIncident,
  incidents,
  recordToolCall,
  serviceRepositories,
} from '@sre/db';

import { connectorToolKey } from '@sre/agent-tools';

import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('GET /incidents/:id/slack-permalink', () => {
  test('resolves the tenant-owned Slack binding through the server-side token boundary', async () => {
    __fixture.resolveSlackPermalink.mockClear();

    const res = await __fixture.api.request(
      `/incidents/${__fixture.originIncidentId}/slack-permalink`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      permalink: 'https://company.slack.com/archives/C07EWAS8132/p1783760625776459',
    });
    expect(__fixture.resolveSlackPermalink).toHaveBeenCalledWith(
      __fixture.tenantC,
      __fixture.ORIGIN_CHANNEL_ID,
      '1783760625.776459',
    );
  });

  test('does not return a non-Slack or non-archive URL from the external resolver', async () => {
    __fixture.resolveSlackPermalink.mockResolvedValueOnce('javascript:alert(1)');

    const res = await __fixture.api.request(
      `/incidents/${__fixture.originIncidentId}/slack-permalink`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ permalink: null });
  });

  test('returns no link without a Slack binding and does not call the resolver', async () => {
    __fixture.resolveSlackPermalink.mockClear();

    const res = await __fixture.api.request(
      `/incidents/${__fixture.runbookIncidentId}/slack-permalink`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ permalink: null });
    expect(__fixture.resolveSlackPermalink).not.toHaveBeenCalled();
  });

  test('keeps foreign incidents and unauthenticated requests non-disclosing', async () => {
    expect(
      (
        await __fixture.api.request(
          `/incidents/${__fixture.originIncidentId}/slack-permalink`,
          __fixture.auth(await __fixture.sign(__fixture.orgB)),
        )
      ).status,
    ).toBe(404);
    expect(
      (await __fixture.api.request(`/incidents/${__fixture.originIncidentId}/slack-permalink`))
        .status,
    ).toBe(401);
  });
});

describe('incident diagnostic workspace readers', () => {
  test('returns structured assessment, viewer identity, and factual evidence progress', async () => {
    const res = await __fixture.api.request(
      `/incidents/${__fixture.originIncidentId}/workspace`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      viewerUserId: string;
      incident: Record<string, unknown>;
      progress: Record<string, unknown>;
      codeContext: {
        resolvedServices: string[];
        repositories: Array<Record<string, unknown>>;
        events: Array<Record<string, unknown>>;
      };
    };
    expect(body.viewerUserId).toBe(__fixture.tenantCUserId);
    expect(body.incident).toMatchObject({
      rcaSummary: 'The database connection pool is saturated.',
      confidence: 81,
      unknowns: [
        {
          question: 'Whether the last deploy changed pool limits',
          category: 'observable',
          evidenceKind: 'deployment_as_of',
          attemptedEvidenceIds: [],
        },
      ],
      nextStep: 'Compare pool settings across the deploy.',
    });
    expect(body.progress).toMatchObject({ total: 1, successful: 1, failed: 0 });
    expect(body.codeContext).toMatchObject({
      resolvedServices: ['homelab'],
      repositories: [
        {
          serviceName: 'homelab',
          fullName: 'acme/homelab-service',
          path: 'services/homelab',
          source: 'mapping',
          confirmed: false,
        },
      ],
      events: [
        {
          eventType: 'push',
          repositoryFullName: 'acme/homelab-service',
          actor: 'octocat',
          sha: 'abc123def456',
        },
      ],
    });
  });

  test('confirms only a repository relationship currently resolved for the incident service', async () => {
    const response = await __fixture.api.request(
      `/incidents/${__fixture.originIncidentId}/code-context/confirm`,
      {
        method: 'POST',
        ...__fixture.auth(await __fixture.sign(__fixture.orgC)),
        body: JSON.stringify({
          repositoryId: '202',
          dataSourceId: __fixture.codeSourceId,
          serviceName: 'homelab',
        }),
      },
    );
    expect(response.status).toBe(200);
    try {
      const workspace = await __fixture.api.request(
        `/incidents/${__fixture.originIncidentId}/workspace`,
        __fixture.auth(await __fixture.sign(__fixture.orgC)),
      );
      await expect(workspace.json()).resolves.toMatchObject({
        codeContext: {
          repositories: [{ fullName: 'acme/homelab-service', confirmed: true }],
        },
      });
      expect(
        (
          await __fixture.api.request(
            `/incidents/${__fixture.originIncidentId}/code-context/confirm`,
            {
              method: 'POST',
              ...__fixture.auth(await __fixture.sign(__fixture.orgB)),
              body: JSON.stringify({
                repositoryId: '202',
                dataSourceId: __fixture.codeSourceId,
                serviceName: 'homelab',
              }),
            },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await __fixture.api.request(
            `/incidents/${__fixture.originIncidentId}/code-context/confirm`,
            {
              method: 'POST',
              ...__fixture.auth(await __fixture.sign(__fixture.orgC)),
              body: JSON.stringify({
                repositoryId: '999999',
                dataSourceId: __fixture.codeSourceId,
                serviceName: 'homelab',
              }),
            },
          )
        ).status,
      ).toBe(404);
    } finally {
      await __fixture.admin.db
        .update(serviceRepositories)
        .set({ confirmed: false, source: 'argocd' })
        .where(
          sql`tenant_id = ${__fixture.tenantC} and service = 'homelab' and repository_full_name = 'acme/homelab-service'`,
        );
    }
  });

  test('a repository confirmation waiting on deletion performs no mapping write', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `repository-delete-race-${randomUUID()}`,
        alertSource: 'slack',
        service: 'homelab',
        severity: 'sev3',
      })
    ).id;
    await __fixture.admin.db
      .update(serviceRepositories)
      .set({ confirmed: false, source: 'argocd' })
      .where(
        sql`tenant_id = ${__fixture.tenantC} and service = 'homelab' and repository_full_name = 'acme/homelab-service'`,
      );
    let releaseDelete!: () => void;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let deleteLocked!: () => void;
    const deleteReached = new Promise<void>((resolve) => {
      deleteLocked = resolve;
    });
    const deletion = __fixture.admin.db.transaction(async (tx) => {
      await tx.update(incidents).set({ archivedAt: new Date() }).where(eq(incidents.id, id));
      deleteLocked();
      await deleteReleased;
    });
    await deleteReached;

    let requestSettled = false;
    const request = Promise.resolve(
      __fixture.api.request(`/incidents/${id}/code-context/confirm`, {
        method: 'POST',
        ...__fixture.auth(await __fixture.sign(__fixture.orgC)),
        body: JSON.stringify({
          repositoryId: '202',
          dataSourceId: __fixture.codeSourceId,
          serviceName: 'homelab',
        }),
      }),
    ).then((response) => {
      requestSettled = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestSettled).toBe(false);
    releaseDelete();
    await deletion;

    expect((await request).status).toBe(404);
    expect(
      await __fixture.admin.db
        .select({ confirmed: serviceRepositories.confirmed })
        .from(serviceRepositories)
        .where(
          sql`tenant_id = ${__fixture.tenantC} and service = 'homelab' and repository_full_name = 'acme/homelab-service'`,
        ),
    ).toEqual([{ confirmed: false }]);
  });

  test('keeps the workspace available when legacy structured assessment JSON is malformed', async () => {
    await __fixture.admin.db
      .update(incidents)
      .set({ rankedHypotheses: { malformed: true } as never, unknowns: 'malformed' as never })
      .where(eq(incidents.id, __fixture.runbookIncidentId));
    try {
      const res = await __fixture.api.request(
        `/incidents/${__fixture.runbookIncidentId}/workspace`,
        __fixture.auth(await __fixture.sign(__fixture.orgC)),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        assessmentState: 'invalid',
        incident: { rankedHypotheses: [], unknowns: [] },
      });
      expect(
        (
          await __fixture.api.request(
            `/incidents/${__fixture.runbookIncidentId}/messages?limit=1`,
            __fixture.auth(await __fixture.sign(__fixture.orgC)),
          )
        ).status,
      ).toBe(200);
    } finally {
      await __fixture.admin.db
        .update(incidents)
        .set({ rankedHypotheses: null, unknowns: null })
        .where(eq(incidents.id, __fixture.runbookIncidentId));
    }
  });

  test('normalizes legacy string unknowns without invalidating the workspace', async () => {
    await __fixture.admin.db
      .update(incidents)
      .set({ unknowns: ['Whether the prior deployment changed the runtime'] as never })
      .where(eq(incidents.id, __fixture.runbookIncidentId));
    try {
      const res = await __fixture.api.request(
        `/incidents/${__fixture.runbookIncidentId}/workspace`,
        __fixture.auth(await __fixture.sign(__fixture.orgC)),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        assessmentState: 'pending',
        incident: {
          unknowns: [
            {
              question: 'Whether the prior deployment changed the runtime',
              category: 'partial_evidence',
              evidenceKind: null,
              attemptedEvidenceIds: [],
            },
          ],
        },
      });
    } finally {
      await __fixture.admin.db
        .update(incidents)
        .set({ unknowns: null })
        .where(eq(incidents.id, __fixture.runbookIncidentId));
    }
  });

  test('paginates complete history and attaches the durable Slack receipt', async () => {
    const secondId = (
      await __fixture.hub.append(__fixture.tenantC, __fixture.originIncidentId, {
        author: 'agent',
        content: 'Connection saturation confirmed.',
      })
    ).id;
    const thirdId = (
      await __fixture.hub.append(__fixture.tenantC, __fixture.originIncidentId, {
        author: 'human',
        content: 'Check whether the last deploy changed the pool.',
      })
    ).id;
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = cursor ? `?limit=1&before=${encodeURIComponent(cursor)}` : '?limit=1';
      const res = await __fixture.api.request(
        `/incidents/${__fixture.originIncidentId}/messages${query}`,
        __fixture.auth(await __fixture.sign(__fixture.orgC)),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{
          id: string;
          slackDelivery: { state: string } | null;
          slackDeliveries: Array<{ state: string }>;
        }>;
        nextCursor: string | null;
      };
      expect(body.messages).toHaveLength(1);
      expect(seen.has(body.messages[0]!.id)).toBe(false);
      seen.add(body.messages[0]!.id);
      if (body.messages[0]!.id === __fixture.deliveryMessageId)
        expect(body.messages[0]).toMatchObject({
          slackDelivery: { state: 'queued' },
          slackDeliveries: [{ state: 'queued' }],
        });
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(4);
    } while (cursor);
    expect([...seen].sort()).toEqual([__fixture.deliveryMessageId, secondId, thirdId].sort());

    const receipt = await __fixture.api.request(
      `/incidents/${__fixture.originIncidentId}/messages/${__fixture.deliveryMessageId}/deliveries`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(receipt.status).toBe(200);
    await expect(receipt.json()).resolves.toMatchObject({
      deliveries: [{ messageId: __fixture.deliveryMessageId, state: 'queued', surface: 'slack' }],
    });
  });

  test('lists evidence metadata, lazy-loads detail, and rejects malformed or foreign access', async () => {
    const list = await __fixture.api.request(
      `/incidents/${__fixture.originIncidentId}/evidence?limit=20`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      evidence: [{ id: __fixture.originEvidenceId, tool: 'query_metrics', outcome: 'data' }],
      nextCursor: null,
    });

    const detailRes = await __fixture.api.request(
      `/incidents/${__fixture.originIncidentId}/evidence/${__fixture.originEvidenceId}`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(detailRes.status).toBe(200);
    await expect(detailRes.json()).resolves.toMatchObject({
      id: __fixture.originEvidenceId,
      input: { service: 'homelab' },
      output: { activeConnections: 100 },
      projection: {
        kind: 'facts',
        columns: ['activeConnections'],
        rows: [{ activeConnections: 100 }],
      },
      referenceUrl: null,
    });

    const safeReferenceId = await recordToolCall(__fixture.app.db, __fixture.tenantC, {
      incidentId: __fixture.originIncidentId,
      tool: `github_${connectorToolKey(__fixture.codeSourceId)}_recent_commits`,
      input: { dashboard: 'checkout' },
      output: { commits: [{ url: 'https://github.com/acme/homelab-service/commit/abc' }] },
      latencyMs: 4,
      outcome: 'data',
    });
    const unsafeReferenceId = await recordToolCall(__fixture.app.db, __fixture.tenantC, {
      incidentId: __fixture.originIncidentId,
      tool: `github_${connectorToolKey(__fixture.codeSourceId)}_recent_commits`,
      input: {},
      output: { url: 'https://attacker.example/phish' },
      latencyMs: 1,
      outcome: 'data',
    });
    const safeReference = await __fixture.api.request(
      `/incidents/${__fixture.originIncidentId}/evidence/${safeReferenceId}`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    await expect(safeReference.json()).resolves.toMatchObject({
      referenceUrl: 'https://github.com/acme/homelab-service/commit/abc',
    });
    const unsafeReference = await __fixture.api.request(
      `/incidents/${__fixture.originIncidentId}/evidence/${unsafeReferenceId}`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    await expect(unsafeReference.json()).resolves.toMatchObject({ referenceUrl: null });
    await __fixture.admin.db
      .delete(agentToolCalls)
      .where(inArray(agentToolCalls.id, [safeReferenceId, unsafeReferenceId]));
    expect(
      (
        await __fixture.api.request(
          `/incidents/${__fixture.originIncidentId}/evidence/${__fixture.originEvidenceId}`,
          __fixture.auth(await __fixture.sign(__fixture.orgA)),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await __fixture.api.request(
          `/incidents/${__fixture.originIncidentId}/evidence?before=not-a-cursor`,
          __fixture.auth(await __fixture.sign(__fixture.orgC)),
        )
      ).status,
    ).toBe(400);
  });

  test('paginates evidence cursors newest to oldest without overlap', async () => {
    const middleId = await recordToolCall(__fixture.app.db, __fixture.tenantC, {
      incidentId: __fixture.originIncidentId,
      tool: 'query_logs',
      input: { service: 'homelab' },
      output: { matches: 2 },
      latencyMs: 20,
      outcome: 'data',
    });
    const newestId = await recordToolCall(__fixture.app.db, __fixture.tenantC, {
      incidentId: __fixture.originIncidentId,
      tool: 'query_deploys',
      input: { service: 'homelab' },
      output: null,
      latencyMs: 30,
      outcome: 'no_data',
    });
    for (const [id, createdAt] of [
      [__fixture.originEvidenceId, new Date('2026-08-21T00:01:00Z')],
      [middleId, new Date('2026-08-21T00:02:00Z')],
      [newestId, new Date('2026-08-21T00:03:00Z')],
    ] as const) {
      await __fixture.admin.db
        .update(agentToolCalls)
        .set({ createdAt })
        .where(eq(agentToolCalls.id, id));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = cursor ? `&before=${encodeURIComponent(cursor)}` : '';
      const res = await __fixture.api.request(
        `/incidents/${__fixture.originIncidentId}/evidence?limit=1${query}`,
        __fixture.auth(await __fixture.sign(__fixture.orgC)),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        evidence: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(body.evidence).toHaveLength(1);
      expect(seen).not.toContain(body.evidence[0]!.id);
      seen.push(body.evidence[0]!.id);
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(4);
    } while (cursor);

    expect(seen).toEqual([newestId, middleId, __fixture.originEvidenceId]);
  });
});
