import { seedMembership } from '@sre/db/test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { jobs, recordSignalDisposition, signalDispositions } from '@sre/db';
import { createFixture } from './incidents.fixture';

const __fixture = createFixture();
let ticketId: string;
let memberUserId: string;
const createdTicketIds: string[] = [];

async function seedTicket(threadId: string): Promise<string> {
  const id = (
    await recordSignalDisposition(__fixture.app.db, __fixture.tenantC, {
      source: 'slack',
      sourceEventKey: `slack:C-PROMOTE:${randomUUID()}`,
      sourceEventAt: new Date(),
      signalKey: `slack:C-PROMOTE:${randomUUID()}`,
      surface: 'slack',
      channel: 'C-PROMOTE',
      threadId,
      summary: 'Checkout error rate is elevated without confirmed customer impact.',
      reason: 'The signal is actionable but safe to review before declaring an incident.',
      service: 'checkout',
      severity: 'sev3',
      disposition: 'ticket',
      classificationMode: 'enforce',
      effectiveDisposition: 'ticket',
      ticket: {
        action: 'Review checkout errors.',
        safeDeferralReason: 'Impact is not confirmed.',
        riskIfIgnored: 'Errors may become customer-visible.',
        reviewHorizonMinutes: 60,
      },
    })
  ).id;
  createdTicketIds.push(id);
  return id;
}

beforeAll(async () => {
  memberUserId = await seedMembership(
    __fixture.admin.db,
    { issuer: __fixture.ISSUER, subject: __fixture.orgC },
    __fixture.tenantC,
  );
});

afterAll(async () => {
  if (createdTicketIds.length > 0 && signalDispositions) {
    await __fixture.admin.db
      .delete(signalDispositions)
      .where(inArray(signalDispositions.id, createdTicketIds));
  }
});

async function promote(token: string, id: string, reason?: string): Promise<Response> {
  return __fixture.api.request(`/signals/${id}/promote`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      criterion: 'other',
      reason: reason ?? 'A responder confirmed the checkout failures require active investigation.',
    }),
  });
}

describe('POST /signals/:id/promote', () => {
  test('pages the ticket inbox so an older unresolved ticket remains reachable', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const older = await seedTicket('1790000000.000010');
    await seedTicket('1790000000.000020');
    const first = await __fixture.api.request('/signals?disposition=ticket&limit=1', {
      headers: { authorization: `Bearer ${token}` },
    });
    const firstBody = (await first.json()) as {
      signals: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    const second = await __fixture.api.request(
      `/signals?disposition=ticket&limit=50&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const secondBody = (await second.json()) as { signals: Array<{ id: string }> };
    expect(secondBody.signals.some((row) => row.id === older)).toBe(true);
  });

  test('routes concurrent promotion through one Incident and records one attributed decision', async () => {
    ticketId = await seedTicket('1790000000.000100');
    const token = await __fixture.sign(__fixture.orgC);
    const responses = await Promise.all([promote(token, ticketId), promote(token, ticketId)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const bodies = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      incidentId: string;
    }>;
    expect(new Set(bodies.map((body) => body.incidentId)).size).toBe(1);

    const rows = await __fixture.admin.db
      .select()
      .from(signalDispositions)
      .where(eq(signalDispositions.id, ticketId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      incidentId: bodies[0]!.incidentId,
      promotedByUserId: memberUserId,
      promotedBySurface: 'dashboard',
      promotionCriterion: 'other',
      promotionReason: 'A responder confirmed the checkout failures require active investigation.',
    });
    expect(rows[0]!.promotedAt).toBeInstanceOf(Date);

    const triageJobs = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`type = 'triage' and payload->>'incidentId' = ${bodies[0]!.incidentId}`);
    expect(triageJobs).toHaveLength(1);
  });

  test('rejects cross-tenant promotion without mutating the ticket', async () => {
    const foreignTicketId = await seedTicket('1790000000.000200');
    const response = await promote(await __fixture.sign(__fixture.orgB), foreignTicketId);
    expect([403, 404]).toContain(response.status);
    const rows = await __fixture.admin.db
      .select({ incidentId: signalDispositions.incidentId })
      .from(signalDispositions)
      .where(eq(signalDispositions.id, foreignTicketId));
    expect(rows[0]!.incidentId).toBeNull();
  });

  test('scrubs credentials from promotion evidence before storage and reads', async () => {
    const id = await seedTicket('1790000000.000250');
    const token = await __fixture.sign(__fixture.orgC);
    const secret = ['glpat', 'abcdefghijklmnopqrst'].join('-');
    const response = await promote(token, id, `Investigate with ${secret}`);
    expect(response.status).toBe(200);
    const rows = await __fixture.admin.db
      .select()
      .from(signalDispositions)
      .where(eq(signalDispositions.id, id));
    expect(rows[0]!.promotionReason).toBe('Investigate with [REDACTED]');
    const listed = await __fixture.api.request('/signals?disposition=ticket', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await listed.text()).not.toContain(secret);
  });

  test('rejects a declaration criterion disabled by the tenant policy', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const policy = {
      retentionDays: 30,
      unsolvedAfterMinutes: 60,
      secondTeamEnabled: false,
      customerVisibleEnabled: true,
    };
    const saved = await __fixture.api.request('/signals/policy', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(policy),
    });
    expect(saved.status).toBe(200);
    const id = await seedTicket('1790000000.000300');
    const response = await __fixture.api.request(`/signals/${id}/promote`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        criterion: 'second_team',
        reason: 'A second team is requested.',
      }),
    });
    expect(response.status).toBe(409);
    await __fixture.api.request('/signals/policy', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...policy, secondTeamEnabled: true }),
    });
  });

  test('enforces the unsolved review threshold with the database clock', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const id = await seedTicket('1790000000.000350');
    const promoteUnsolved = () =>
      __fixture.api.request(`/signals/${id}/promote`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          criterion: 'unsolved',
          reason: 'The review remains unsolved.',
        }),
      });

    expect((await promoteUnsolved()).status).toBe(409);
    const review = await __fixture.api.request(`/signals/${id}/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(review.status).toBe(200);
    expect((await promoteUnsolved()).status).toBe(409);
    await __fixture.admin.db
      .update(signalDispositions)
      .set({ reviewStartedAt: new Date(Date.now() - 61 * 60_000) })
      .where(eq(signalDispositions.id, id));
    expect((await promoteUnsolved()).status).toBe(200);
  });
});
