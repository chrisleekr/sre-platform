import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  assessmentGrades,
  createIncident,
  getPostmortemDetail,
  incidents,
  investigationRuns,
  jobs,
  MAX_ACTION_ITEMS,
  postmortemActionItems,
  saveGeneratedPostmortem,
  type GeneratedPostmortemInput,
} from '@sre/db';
import type { PostmortemActionItem, PostmortemDetail } from '@sre/contracts';
import { eq, sql } from 'drizzle-orm';
import { createFixture } from './incidents.fixture';

// the postmortem document lifecycle over HTTP. A generated draft is read, edited under
// revision CAS, given typed action items, published one way (which pins the assessment grade job in
// the same transaction), then graded by a human. Tests run in order on one seeded draft.
const __fixture = createFixture();

const draft: GeneratedPostmortemInput = {
  trigger: 'slow_resolution',
  assessmentRunId: null,
  requestedByUserId: null,
  summary: 'Checkout degraded for 40 minutes.',
  impact: 'Customers saw errors at payment.',
  contributingCauses: [{ cause: 'The pool was sized for last year’s traffic.', evidenceIds: [] }],
  triggerNarrative: 'A traffic spike exhausted the pool.',
  resolution: 'Pool size raised.',
  detection: 'Error-rate monitor.',
  lessons: { wentWell: ['Monitor fired fast'], wentWrong: ['No pool alert'], lucky: [] },
  timeline: [{ at: '2026-09-01T10:00:00Z', event: 'Monitor fired' }],
  supportingInformation: null,
  actionItems: [{ type: 'prevent', title: 'Add a pool saturation alert' }],
};

async function callOn(
  incidentId: string,
  path: string,
  method: string,
  body?: unknown,
  org?: string,
): Promise<Response> {
  const auth = __fixture.auth(await __fixture.sign(org ?? __fixture.orgC));
  return __fixture.api.request(`/incidents/${incidentId}${path}`, {
    ...auth,
    method,
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const call = (path: string, method: string, body?: unknown, org?: string) =>
  callOn(__fixture.postmortemIncidentId, path, method, body, org);

describe('postmortem document routes', () => {
  test('GET returns the draft with its generated action item and no grade yet', async () => {
    expect(
      await saveGeneratedPostmortem(
        __fixture.app.db,
        __fixture.tenantC,
        __fixture.postmortemIncidentId,
        draft,
      ),
    ).toBe('saved');
    const res = await call('/postmortem', 'GET');
    expect(res.status).toBe(200);
    const detail = (await res.json()) as PostmortemDetail;
    expect(detail.postmortem).toMatchObject({
      incidentId: __fixture.postmortemIncidentId,
      status: 'draft',
      revision: 1,
      // Generation recorded no run; the API surfaces null until publish pins the trusted run.
      assessmentRunId: null,
    });
    expect(detail.actionItems).toEqual([
      expect.objectContaining({ title: 'Add a pool saturation alert', generated: true }),
    ]);
    expect(detail.grade).toBeNull();
    // Another tenant's member sees nothing, even by id.
    expect((await call('/postmortem', 'GET', undefined, __fixture.orgA)).status).toBe(404);
  });

  test('PATCH is revision-checked: stale is 409, current bumps the revision, junk is 400', async () => {
    expect(
      (await call('/postmortem', 'PATCH', { revision: 7, summary: 'stale edit' })).status,
    ).toBe(409);
    expect((await call('/postmortem', 'PATCH', { revision: 1 })).status).toBe(400);
    expect((await call('/postmortem', 'PATCH', { revision: 1, status: 'published' })).status).toBe(
      400,
    );
    const res = await call('/postmortem', 'PATCH', {
      revision: 1,
      summary: 'Checkout degraded for 42 minutes; token sk-abcdefghijklmnopqrstuvwxyz123456.',
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as PostmortemDetail;
    expect(detail.postmortem.revision).toBe(2);
    // Human-authored text is scrubbed on the way in.
    expect(detail.postmortem.summary).toBe('Checkout degraded for 42 minutes; token [REDACTED].');
  });

  test('action items: https tracker only, owner attributed, done stamps completedAt', async () => {
    const valid = { type: 'process', title: 'Review pool sizing quarterly' };
    const rejected: Record<string, unknown>[] = [
      { ...valid, trackerUrl: 'http://tracker.example.com/1' },
      // Userinfo would be stored and rendered to the whole tenant.
      { ...valid, trackerUrl: 'https://u:p@jira.example/x' },
      // A pasted token in the query would be stored verbatim and rendered as a link.
      { ...valid, trackerUrl: 'https://gitlab.example/x?private_token=glpat-abcdefghijklmnopqrst' },
      // A sensitive parameter name is refused whatever the value looks like.
      { ...valid, trackerUrl: 'https://tracker.example/x?token=abc123' },
      { ...valid, trackerUrl: 'https://git.example/p/-/issues/1?private_token=hunter2' },
      { ...valid, trackerUrl: 'https://git.example/x?Private_Token=hunter2' },
      // URLSearchParams decodes %5F, so encoding the underscore does not hide the key.
      { ...valid, trackerUrl: 'https://git.example/x?private%5Ftoken=hunter2' },
      // Fragment parameters are checked too (OAuth implicit flow puts the token there).
      { ...valid, trackerUrl: 'https://git.example/x#access_token=abc' },
      { ...valid, trackerUrl: 'javascript:alert(1)' },
      { ...valid, title: '   ' },
      { ...valid, type: 'wish' },
    ];
    for (const body of rejected)
      expect(
        (await call('/postmortem/action-items', 'POST', body)).status,
        JSON.stringify(body),
      ).toBe(400);
    // A long opaque id and a benign query key are ordinary tracker links, not credentials.
    const accepted = [
      'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit',
      'https://jira.example/browse/OPS-1?selectedIssue=OPS-1',
    ];
    for (const trackerUrl of accepted) {
      const res = await call('/postmortem/action-items', 'POST', { ...valid, trackerUrl });
      expect(res.status, trackerUrl).toBe(201);
      expect(
        ((await res.json()) as { actionItem: PostmortemActionItem }).actionItem.trackerUrl,
      ).toBe(trackerUrl);
    }
    const created = await call('/postmortem/action-items', 'POST', {
      type: 'process',
      title: 'Review pool sizing quarterly',
      owner: 'payments-team',
      trackerUrl: 'https://tracker.example.com/1',
      dueAt: '2026-12-01T00:00:00Z',
    });
    expect(created.status).toBe(201);
    const { actionItem } = (await created.json()) as { actionItem: PostmortemActionItem };
    expect(actionItem).toMatchObject({
      type: 'process',
      owner: 'payments-team',
      trackerUrl: 'https://tracker.example.com/1',
      state: 'open',
      generated: false,
      completedAt: null,
    });
    const done = await call(`/postmortem/action-items/${actionItem.id}`, 'PATCH', {
      state: 'done',
    });
    expect(done.status).toBe(200);
    expect(
      ((await done.json()) as { actionItem: PostmortemActionItem }).actionItem.completedAt,
    ).not.toBeNull();
    expect(
      (await call(`/postmortem/action-items/${actionItem.id}`, 'PATCH', { state: 'lost' })).status,
    ).toBe(400);
    expect((await call(`/postmortem/action-items/${actionItem.id}`, 'PATCH', {})).status).toBe(400);
  });

  test('grading a draft is 409: no run is pinned until publish', async () => {
    const res = await call('/postmortem/grade', 'POST', { verdict: 'correct', rationale: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no assessment run is pinned to this postmortem' });
  });

  test('publish is one way and pins an assessment.grade job for the trusted run in the same commit', async () => {
    const res = await call('/postmortem/publish', 'POST');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { published: boolean; gradeJobId: string | null };
    expect(body.published).toBe(true);
    expect(body.gradeJobId).toBeTruthy();
    const rows = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`id = ${body.gradeJobId}`);
    expect(rows[0]).toMatchObject({
      tenantId: __fixture.tenantC,
      type: 'assessment.grade',
      stream: 'sre:runbook',
      payload: { incidentId: __fixture.postmortemIncidentId, runId: __fixture.postmortemRunId },
    });
    const detail = (await (await call('/postmortem', 'GET')).json()) as PostmortemDetail;
    expect(detail.postmortem).toMatchObject({
      status: 'published',
      assessmentRunId: __fixture.postmortemRunId,
      publishedByUserId: __fixture.tenantCUserId,
    });
    expect(detail.postmortem.publishedAt).not.toBeNull();

    // After publish: no second publish, no edits, no regeneration.
    expect((await call('/postmortem/publish', 'POST')).status).toBe(409);
    expect(
      (await call('/postmortem', 'PATCH', { revision: detail.postmortem.revision, summary: 'x' }))
        .status,
    ).toBe(409);
    expect((await call('/postmortem/generate', 'POST', { trigger: 'data_loss' })).status).toBe(409);
  });

  test('a responder grades the pinned assessment; the verdict rides the postmortem detail', async () => {
    expect(
      (await call('/postmortem/grade', 'POST', { verdict: 'maybe', rationale: 'x' })).status,
    ).toBe(400);
    const res = await call('/postmortem/grade', 'POST', {
      verdict: 'partial',
      rationale: 'Pool exhaustion was the symptom; the sizing process was the cause.',
    });
    expect(res.status).toBe(201);
    const { grade } = (await res.json()) as PostmortemDetail;
    expect(grade).toMatchObject({
      runId: __fixture.postmortemRunId,
      claimedConfidence: 85,
      humanVerdict: 'partial',
      modelVerdict: null,
      effectiveVerdict: 'partial',
      gradedByUserId: __fixture.tenantCUserId,
    });
    const detail = (await (await call('/postmortem', 'GET')).json()) as PostmortemDetail;
    expect(detail.grade?.humanVerdict).toBe('partial');
  });

  test('a postmortem at the action item cap refuses another over HTTP with 409', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `pm-cap-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
    });
    expect(
      await saveGeneratedPostmortem(__fixture.app.db, __fixture.tenantC, incident.id, {
        ...draft,
        actionItems: [],
      }),
    ).toBe('saved');
    const { postmortem } = (await getPostmortemDetail(
      __fixture.app.db,
      __fixture.tenantC,
      incident.id,
    ))!;
    // Seed straight to the cap; the route's own create path is what must refuse the next one.
    await __fixture.admin.db.insert(postmortemActionItems).values(
      Array.from({ length: MAX_ACTION_ITEMS }, (_, i) => ({
        tenantId: __fixture.tenantC,
        postmortemId: postmortem.id,
        type: 'prevent' as const,
        title: `Seeded ${i}`,
      })),
    );
    const res = await callOn(incident.id, '/postmortem/action-items', 'POST', {
      type: 'prevent',
      title: 'One too many',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'too many action items' });
  });

  test('a pinned run that claimed no confidence cannot be graded: 409 and no grade row', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
      fingerprint: `pm-noconf-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'payments',
      severity: 'sev2',
    });
    const runId = randomUUID();
    await __fixture.admin.db.insert(investigationRuns).values({
      id: runId,
      tenantId: __fixture.tenantC,
      incidentId: incident.id,
      operation: 'investigate',
      outcome: 'conclusive',
      result: { summary: 'Reply only.' },
      completedAt: new Date(),
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ trustedAssessmentRunId: runId })
      .where(eq(incidents.id, incident.id));
    expect(
      await saveGeneratedPostmortem(__fixture.app.db, __fixture.tenantC, incident.id, draft),
    ).toBe('saved');
    expect((await callOn(incident.id, '/postmortem/publish', 'POST')).status).toBe(200);
    const res = await callOn(incident.id, '/postmortem/grade', 'POST', {
      verdict: 'correct',
      rationale: 'Nothing to falsify here.',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'the pinned assessment claimed no confidence' });
    expect(
      await __fixture.admin.db
        .select({ id: assessmentGrades.id })
        .from(assessmentGrades)
        .where(eq(assessmentGrades.runId, runId)),
    ).toEqual([]);
  });
});
