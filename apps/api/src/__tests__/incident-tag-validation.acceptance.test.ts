import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  createIncident,
  incidents,
  investigationRuns,
  recordAcceptedCauseTagSuggestions,
  recordToolCall,
} from '@sre/db';
import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('incident tag suggestion validation', () => {
  test('rejects credential material without repeating it', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `tag-secret-${randomUUID()}`,
      alertSource: 'manual',
      service: 'checkout',
      severity: 'sev3',
    });
    const secretTag = `token:${['glpat', 'abcdefghijklmnopqrst'].join('-')}`;
    const response = await __fixture.api.request(`/incidents/${incident.id}/tags`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tag: secretTag }),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('credential material');
    expect(text).not.toContain(secretTag);
  });

  test('returns a bounded validation response for an invalid edited suggestion', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `tag-api-${randomUUID()}`,
      alertSource: 'manual',
      service: 'checkout',
      severity: 'sev3',
    });
    const evidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantC, {
      incidentId: incident.id,
      tool: 'prometheus_query',
      input: { query: 'rate(errors[5m])' },
      latencyMs: 10,
      outcome: 'data',
      output: { value: 1 },
    });
    const runId = randomUUID();
    await __fixture.admin.db.insert(investigationRuns).values({
      id: runId,
      tenantId: __fixture.tenantC,
      incidentId: incident.id,
      operation: 'investigate',
      outcome: 'conclusive',
      result: { summary: 'A deployment introduced the error.' },
      evidenceIds: [evidenceId],
      completedAt: new Date(),
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ trustedAssessmentRunId: runId })
      .where(eq(incidents.id, incident.id));
    const suggestions = await recordAcceptedCauseTagSuggestions(
      __fixture.app.db,
      __fixture.tenantC,
      {
        incidentId: incident.id,
        runId,
        suggestions: [{ tag: 'cause:deployment', evidenceIds: [evidenceId] }],
      },
    );

    const response = await __fixture.api.request(
      `/incidents/${incident.id}/tag-suggestions/${suggestions[0]!.id}/accept`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'cause:deployment regression' }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/space/i),
    });
  });
});
