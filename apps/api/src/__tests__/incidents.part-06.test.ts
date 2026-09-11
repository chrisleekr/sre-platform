import { seedMembership } from '@sre/db/test-support';
import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  approvals,
  createApproval,
  createIncident,
  getIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
} from '@sre/db';

import { applyApprovalDecision, type ResumeProducer } from '../approval-decision';

import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

// a dashboard user decides a pending approval. The route applies the first-decision-
// wins CAS (decideApproval), appends a 'decided: <label>' reply with origin_surface='dashboard' (so
// the existing fan-out syncs it to Slack), and enqueues a RESUME so the engine continues off the request
// path. RED now: the route does not exist, so every POST 404s and nothing is decided/appended/enqueued.
describe('POST /incidents/:id/approvals/:approvalId/decide', () => {
  async function decide(
    incId: string,
    apprId: string,
    optionId: string,
    token: string,
  ): Promise<Response> {
    return __fixture.api.request(`/incidents/${incId}/approvals/${apprId}/decide`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ optionId }),
    });
  }
  const resumeJobs = (incId: string) =>
    __fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`type = 'resume' and payload->>'incidentId' = ${incId}`);
  const decidedMsgs = (incId: string) =>
    __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(sql`incident_id = ${incId} and content like 'decided:%'`);

  test('C3: applies the CAS, appends decided:<label> (origin dashboard), and enqueues a resume', async () => {
    const res = await decide(
      __fixture.approvalIncidentId,
      __fixture.approvalId,
      'restart',
      await __fixture.sign(__fixture.orgC),
    );
    expect(res.status).toBe(200);

    // CAS applied: the approvals row now carries the winning option id.
    const [row] = await __fixture.admin.db
      .select()
      .from(approvals)
      .where(sql`id = ${__fixture.approvalId}`);
    expect(row!.decision).toBe('restart');

    // A 'decided: Restart' reply is appended with origin_surface='dashboard' (fan-out syncs to Slack).
    const msgs = await decidedMsgs(__fixture.approvalIncidentId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('decided: Restart');
    expect(msgs[0]!.originSurface).toBe('dashboard');

    // A resume job was enqueued for this incident.
    expect(await resumeJobs(__fixture.approvalIncidentId)).toHaveLength(1);
  });

  test('C4: a second decide on an already-decided approval is idempotent — no second reply, no second resume', async () => {
    const res = await decide(
      __fixture.approvalIncidentId,
      __fixture.approvalId,
      'skip',
      await __fixture.sign(__fixture.orgC),
    );
    // Idempotent: a 409, or a 200 with decided:false — never a fresh decision.
    if (res.status === 200) {
      expect(((await res.json()) as { decided: boolean }).decided).toBe(false);
    } else {
      expect(res.status).toBe(409);
    }
    // The original decision stands; no duplicate side effects.
    const [row] = await __fixture.admin.db
      .select()
      .from(approvals)
      .where(sql`id = ${__fixture.approvalId}`);
    expect(row!.decision).toBe('restart');
    expect(await decidedMsgs(__fixture.approvalIncidentId)).toHaveLength(1);
    expect(await resumeJobs(__fixture.approvalIncidentId)).toHaveLength(1);
  });

  test('C5: a user of another tenant cannot decide this approval (RLS) — no CAS, no append, no resume', async () => {
    // orgB is a member of tenantB but does not own tenantC's approval → rejected under RLS.
    const res = await decide(
      __fixture.approvalC5IncidentId,
      __fixture.approvalC5Id,
      'restart',
      await __fixture.sign(__fixture.orgB),
    );
    expect([403, 404]).toContain(res.status);
    const [row] = await __fixture.admin.db
      .select()
      .from(approvals)
      .where(sql`id = ${__fixture.approvalC5Id}`);
    expect(row!.decision ?? null).toBeNull(); // untouched
    expect(await decidedMsgs(__fixture.approvalC5IncidentId)).toHaveLength(0);
    expect(await resumeJobs(__fixture.approvalC5IncidentId)).toHaveLength(0);
  });

  test('C6 (FIX2): a mismatched but same-tenant :id → 404, approval NOT decided', async () => {
    // A fresh undecided tenantC approval, addressed under the WRONG (but same-tenant) incident path.
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `ap6-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
    });
    const apprId = (
      await createApproval(__fixture.app.db, __fixture.tenantC, {
        incidentId: incId,
        actionId: 'act-c6',
        prompt: 'Roll back?',
        options: [{ id: 'rollback', label: 'Roll back' }],
      })
    ).row.id;
    const res = await decide(
      __fixture.approvalC5IncidentId,
      apprId,
      'rollback',
      await __fixture.sign(__fixture.orgC),
    );
    expect(res.status).toBe(404);
    const [row] = await __fixture.admin.db
      .select()
      .from(approvals)
      .where(sql`id = ${apprId}`);
    expect(row!.decision ?? null).toBeNull(); // untouched
    expect(await decidedMsgs(incId)).toHaveLength(0);
    expect(await resumeJobs(incId)).toHaveLength(0);
  });

  // the ROUTE must supply the attribution, not just forward one it was handed. The direct
  // applyApprovalDecision tests below prove the seam carries a value; only this one proves the route
  // resolves the authenticated member and passes it, so dropping `authorUserId` at the call site fails here.
  test('the route attributes the decision to the authenticated member', async () => {
    // The member the orgC token authenticates as: auth resolves (issuer, sub) → this users.id, and the
    // route may stamp ONLY that resolved id (author_user_id is a plain FK to users.id, so nothing in the
    // DB would catch a wrong one).
    const memberUserId = await seedMembership(
      __fixture.admin.db,
      { issuer: __fixture.ISSUER, subject: __fixture.orgC },
      __fixture.tenantC,
    );
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `ap-route-author-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
    });
    const apprId = (
      await createApproval(__fixture.app.db, __fixture.tenantC, {
        incidentId: incId,
        actionId: 'act-route-author',
        prompt: 'Restart?',
        options: [{ id: 'restart', label: 'Restart' }],
      })
    ).row.id;

    const res = await decide(incId, apprId, 'restart', await __fixture.sign(__fixture.orgC));
    expect(res.status).toBe(200);

    const msgs = await decidedMsgs(incId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('decided: Restart');
    expect(msgs[0]!.authorUserId).toBe(memberUserId);
  });
});

// the CAS + append + resume run in ONE tenant tx — a failed resume rolls the CAS back, so a
// decision is never recorded without its resume (an incident would otherwise stall forever). Inject a
// throwing insertResumeTx and assert the approval stays undecided with no surviving reply/resume.
describe('applyApprovalDecision atomicity', () => {
  test('a throwing insertResumeTx rolls back the CAS + append — approval stays undecided', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `ap-atomic-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
    });
    const apprId = (
      await createApproval(__fixture.app.db, __fixture.tenantC, {
        incidentId: incId,
        actionId: 'act-atomic',
        prompt: 'Restart?',
        options: [{ id: 'restart', label: 'Restart' }],
      })
    ).row.id;

    const throwingQueue: ResumeProducer = {
      insertResumeTx: async () => {
        throw new Error('resume insert failed');
      },
      publishResume: async () => {},
    };

    await expect(
      applyApprovalDecision(
        {
          adminDb: __fixture.admin.db,
          appDb: __fixture.app.db,
          hub: __fixture.hub,
          queue: throwingQueue,
        },
        {
          tenantId: __fixture.tenantC,
          approvalId: apprId,
          optionId: 'restart',
          decidedBy: 'u-atomic',
          originSurface: 'dashboard',
        },
      ),
    ).rejects.toThrow('resume insert failed');

    // Atomicity: the CAS rolled back with the failed resume — the approval is STILL undecided...
    const [row] = await __fixture.admin.db
      .select()
      .from(approvals)
      .where(sql`id = ${apprId}`);
    expect(row!.decision ?? null).toBeNull();
    // ...and neither the 'decided' reply nor the resume job survives.
    const msgs = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(sql`incident_id = ${incId} and content like 'decided:%'`);
    expect(msgs).toHaveLength(0);
    const rjobs = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`type = 'resume' and payload->>'incidentId' = ${incId}`);
    expect(rjobs).toHaveLength(0);
  });
});

// the decided reply must carry the decided approval's id (incident_messages.approval_id), so the
// dashboard can correlate a 'decided:' reply to the EXACT approval instead of scanning option labels for
// the nearest match. RED today: applyApprovalDecision appends the reply without approvalId, so the row's
// approval_id is null.
describe('applyApprovalDecision links the decided reply to its approval', () => {
  test('the appended decided reply carries approval_id = the decided approval id', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `ap-link-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
    });
    const apprId = (
      await createApproval(__fixture.app.db, __fixture.tenantC, {
        incidentId: incId,
        actionId: 'act-link',
        prompt: 'Restart?',
        options: [{ id: 'restart', label: 'Restart' }],
      })
    ).row.id;

    const outcome = await applyApprovalDecision(
      {
        adminDb: __fixture.admin.db,
        appDb: __fixture.app.db,
        hub: __fixture.hub,
        queue: __fixture.declarationQueue,
      },
      {
        tenantId: __fixture.tenantC,
        approvalId: apprId,
        optionId: 'restart',
        decidedBy: 'u-link',
        originSurface: 'dashboard',
      },
    );
    expect(outcome.status).toBe('decided');

    const [row] = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(sql`incident_id = ${incId} and content like 'decided:%'`);
    expect(row!.content).toBe('decided: Restart');
    // RED: the append must stamp approval_id so the dashboard can correlate on it (not by option label).
    expect(row!.approvalId).toBe(apprId);
  });
});

describe('applyApprovalDecision completes a recovery held by approvals', () => {
  test('the last pending decision rechecks verified recovery and resolves the incident', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `ap-recovery-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'payments',
      severity: 'sev2',
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ recoveryState: 'verified' })
      .where(eq(incidents.id, incId));
    await __fixture.admin.db.insert(incidentSignals).values({
      tenantId: __fixture.tenantC,
      incidentId: incId,
      surface: 'alertmanager',
      channel: 'payments',
      externalMessageId: `resolved-${randomUUID()}`,
      state: 'resolved',
      lastEventType: 'resolved',
      summary: 'Payments recovered',
      contentHash: randomUUID(),
      lastEventKey: `resolved:${randomUUID()}`,
      lastEventAt: new Date(),
      resolvedAt: new Date(),
    });
    const firstApproval = (
      await createApproval(__fixture.app.db, __fixture.tenantC, {
        incidentId: incId,
        actionId: 'recovery-first',
        prompt: 'Approve first follow-up?',
        options: [{ id: 'approve', label: 'Approve' }],
      })
    ).row.id;
    const lastApproval = (
      await createApproval(__fixture.app.db, __fixture.tenantC, {
        incidentId: incId,
        actionId: 'recovery-last',
        prompt: 'Approve last follow-up?',
        options: [{ id: 'approve', label: 'Approve' }],
      })
    ).row.id;

    await applyApprovalDecision(
      {
        adminDb: __fixture.admin.db,
        appDb: __fixture.app.db,
        hub: __fixture.hub,
        queue: __fixture.declarationQueue,
      },
      {
        tenantId: __fixture.tenantC,
        approvalId: firstApproval,
        optionId: 'approve',
        decidedBy: 'u-recovery',
        originSurface: 'dashboard',
      },
    );
    expect(await getIncident(__fixture.app.db, __fixture.tenantC, incId)).toMatchObject({
      status: 'open',
    });

    await applyApprovalDecision(
      {
        adminDb: __fixture.admin.db,
        appDb: __fixture.app.db,
        hub: __fixture.hub,
        queue: __fixture.declarationQueue,
      },
      {
        tenantId: __fixture.tenantC,
        approvalId: lastApproval,
        optionId: 'approve',
        decidedBy: 'u-recovery',
        originSurface: 'dashboard',
      },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantC, incId)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 1,
      recoveryState: 'verified',
    });
    expect(
      await __fixture.admin.db
        .select({ content: incidentMessages.content })
        .from(incidentMessages)
        .where(
          sql`incident_id = ${incId} and kind = 'lifecycle' and origin_surface = 'automation'`,
        ),
    ).toEqual([
      {
        content:
          'Incident resolved: provider signals are clear and verified recovery was waiting on this approval.',
      },
    ]);
  });
});

// the decided reply is attributed to whoever decided it. The shared decide path takes an ALREADY
// resolved platform user id (the dashboard route passes its authenticated `userId`; Slack passes the id it
// resolved from the tap's author) and stamps it as incident_messages.author_user_id. These cover the seam
// itself: that it forwards a supplied id, and that it stamps null when given none. The route-level guard
// that a caller actually supplies one lives in the decide-route describe above.
describe('applyApprovalDecision stamps the decider as author_user_id', () => {
  test('C5: a decision made by an authenticated dashboard user stamps that user id on the decided reply', async () => {
    // Idempotent re-seed of tenantC's existing member (beforeAll), just to read its user id back.
    const memberUserId = await seedMembership(
      __fixture.admin.db,
      { issuer: __fixture.ISSUER, subject: __fixture.orgC },
      __fixture.tenantC,
    );
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `ap-author-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
    });
    const apprId = (
      await createApproval(__fixture.app.db, __fixture.tenantC, {
        incidentId: incId,
        actionId: 'act-author',
        prompt: 'Restart?',
        options: [{ id: 'restart', label: 'Restart' }],
      })
    ).row.id;

    const outcome = await applyApprovalDecision(
      {
        adminDb: __fixture.admin.db,
        appDb: __fixture.app.db,
        hub: __fixture.hub,
        queue: __fixture.declarationQueue,
      },
      {
        tenantId: __fixture.tenantC,
        approvalId: apprId,
        optionId: 'restart',
        decidedBy: memberUserId,
        originSurface: 'dashboard',
        authorUserId: memberUserId,
      },
    );
    expect(outcome.status).toBe('decided');

    const [row] = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(sql`incident_id = ${incId} and content like 'decided:%'`);
    expect(row!.content).toBe('decided: Restart');
    // The stamp is what lets the dashboard and Slack show who approved.
    expect(row!.authorUserId).toBe(memberUserId);
  });

  test('C5: a decision with no resolved decider leaves author_user_id null (never-wrong-person)', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `ap-author-none-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
    });
    const apprId = (
      await createApproval(__fixture.app.db, __fixture.tenantC, {
        incidentId: incId,
        actionId: 'act-author-none',
        prompt: 'Restart?',
        options: [{ id: 'restart', label: 'Restart' }],
      })
    ).row.id;

    const outcome = await applyApprovalDecision(
      {
        adminDb: __fixture.admin.db,
        appDb: __fixture.app.db,
        hub: __fixture.hub,
        queue: __fixture.declarationQueue,
      },
      // An unresolved decider (the route's `userId` is undefined) must not fabricate an attribution.
      {
        tenantId: __fixture.tenantC,
        approvalId: apprId,
        optionId: 'restart',
        decidedBy: 'auth0|no-member',
        originSurface: 'dashboard',
        authorUserId: undefined,
      },
    );
    expect(outcome.status).toBe('decided'); // the decision is still recorded, just unattributed

    const [row] = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(sql`incident_id = ${incId} and content like 'decided:%'`);
    expect(row!.content).toBe('decided: Restart');
    expect(row!.authorUserId ?? null).toBeNull();
  });
});
