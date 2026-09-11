import { seedMembership } from '../test-support';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  ActionItemLimitError,
  MAX_ACTION_ITEMS,
  createActionItem,
  createIncident,
  getPostmortemDetail,
  incidents,
  memberships,
  postmortemActionItems,
  postmortems,
  publishPostmortem,
  readPostmortemReport,
  saveGeneratedPostmortem,
  tenants,
  updateActionItem,
  updatePostmortemSections,
  users,
  makeDb,
  withTenant,
  type DbHandle,
  type GeneratedPostmortemInput,
} from '../index';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let userA: string;
let incidentA: string;
let incidentB: string;
// Tenant A incidents with their own postmortems: one pinned to a trusted run, one for the cap.
let incidentTrusted: string;
let runTrusted: string;
let incidentCap: string;
let incidentFull: string;

const draft = (over: Partial<GeneratedPostmortemInput> = {}): GeneratedPostmortemInput => ({
  trigger: 'slow_resolution',
  assessmentRunId: null,
  requestedByUserId: null,
  summary: 'Checkout degraded for 40 minutes.',
  impact: 'Customers saw errors at payment.',
  contributingCauses: [
    { cause: 'Connection pool sized for last year’s traffic.', evidenceIds: [] },
  ],
  triggerNarrative: 'A traffic spike exhausted the pool.',
  resolution: 'Pool size raised; pgbouncer restarted.',
  detection: 'Datadog error-rate monitor.',
  lessons: { wentWell: ['Monitor fired fast'], wentWrong: ['No pool alert'], lucky: [] },
  timeline: [{ at: '2026-09-01T10:00:00Z', event: 'Monitor fired' }],
  supportingInformation: null,
  actionItems: [{ type: 'prevent', title: 'Add a pool saturation alert' }],
  ...over,
});

// The generated input minus the action items: only the columns of the postmortems row.
const columns = (): Omit<GeneratedPostmortemInput, 'actionItems'> => {
  const { actionItems, ...rest } = draft();
  void actionItems;
  return rest;
};

async function expectConstraint(operation: Promise<unknown>, name: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
    expect(String(cause)).toContain(name);
    return;
  }
  throw new Error(`operation unexpectedly succeeded without ${name}`);
}

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'Postmortem tenant A' },
    { id: tenantB, name: 'Postmortem tenant B' },
  ]);
  userA = await seedMembership(
    admin.db,
    { issuer: 'postmortem-test', subject: randomUUID() },
    tenantA,
  );
  const seed = (tenantId: string) =>
    createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'test',
      service: 'checkout',
      severity: 'sev2',
    });
  incidentA = (await seed(tenantA)).id;
  incidentB = (await seed(tenantB)).id;
  incidentTrusted = (await seed(tenantA)).id;
  incidentCap = (await seed(tenantA)).id;
  incidentFull = (await seed(tenantA)).id;
  runTrusted = randomUUID();
  await admin.db.execute(sql`
    insert into investigation_runs (id, tenant_id, incident_id, operation, outcome, result, completed_at)
    values (${runTrusted}, ${tenantA}, ${incidentTrusted}, 'investigate', 'conclusive',
            ${JSON.stringify({ summary: 'pool exhausted', confidence: 85 })}::jsonb, now())
  `);
  await admin.db
    .update(incidents)
    .set({ confidence: 85, trustedAssessmentRunId: runTrusted })
    .where(eq(incidents.id, incidentTrusted));
});

afterAll(async () => {
  await admin.db.delete(postmortems).where(inArray(postmortems.tenantId, [tenantA, tenantB]));
  // The trusted-run FK points at investigation_runs; unpin before deleting the runs.
  await admin.db
    .update(incidents)
    .set({ trustedAssessmentRunId: null })
    .where(inArray(incidents.tenantId, [tenantA, tenantB]));
  await admin.db.execute(
    sql`delete from investigation_runs where tenant_id in (${tenantA}, ${tenantB})`,
  );
  await admin.db.delete(incidents).where(inArray(incidents.tenantId, [tenantA, tenantB]));
  await admin.db.delete(memberships).where(inArray(memberships.tenantId, [tenantA, tenantB]));
  await admin.db.delete(users).where(eq(users.id, userA));
  await admin.db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  await admin.close();
  await app.close();
});

describe('postmortem repo', () => {
  test('a generated draft is tenant-isolated and a regenerate keeps human-added action items', async () => {
    expect(await saveGeneratedPostmortem(app.db, tenantA, incidentA, draft())).toBe('saved');
    const detail = await getPostmortemDetail(app.db, tenantA, incidentA);
    expect(detail?.postmortem).toMatchObject({
      status: 'draft',
      revision: 1,
      trigger: 'slow_resolution',
    });
    expect(detail?.actionItems).toEqual([
      expect.objectContaining({
        title: 'Add a pool saturation alert',
        generated: true,
        owner: null,
      }),
    ]);
    expect(detail?.postmortem).not.toHaveProperty('tenantId');
    // Tenant B sees nothing of tenant A's postmortem, through the same incident id.
    expect(await getPostmortemDetail(app.db, tenantB, incidentA)).toBeNull();

    const human = await createActionItem(app.db, tenantA, incidentA, {
      type: 'process',
      title: 'Add pool sizing to the capacity review',
      owner: 'payments-team',
    });
    expect(human?.generated).toBe(false);
    expect(
      await saveGeneratedPostmortem(
        app.db,
        tenantA,
        incidentA,
        draft({ actionItems: [{ type: 'mitigate', title: 'Shed load at the edge' }] }),
      ),
    ).toBe('saved');
    const regenerated = await getPostmortemDetail(app.db, tenantA, incidentA);
    expect(regenerated?.postmortem.revision).toBe(2);
    expect(regenerated?.actionItems.map((item) => item.title).sort()).toEqual([
      'Add pool sizing to the capacity review',
      'Shed load at the edge',
    ]);
  });

  test('a generated item a human edited survives a regenerate; an untouched one is replaced', async () => {
    await saveGeneratedPostmortem(
      app.db,
      tenantA,
      incidentA,
      draft({
        actionItems: [
          { type: 'mitigate', title: 'Shed load at the edge' },
          { type: 'process', title: 'Rotate the pager' },
        ],
      }),
    );
    const before = (await getPostmortemDetail(app.db, tenantA, incidentA))!;
    const edited = before.actionItems.find((i) => i.title === 'Shed load at the edge')!;
    expect(edited.generated).toBe(true);
    const owned = await updateActionItem(app.db, tenantA, incidentA, edited.id, {
      owner: 'edge-team',
    });
    expect(owned).toMatchObject({ owner: 'edge-team', generated: false });
    expect(await saveGeneratedPostmortem(app.db, tenantA, incidentA, draft())).toBe('saved');
    const after = (await getPostmortemDetail(app.db, tenantA, incidentA))!;
    expect(after.actionItems.find((i) => i.id === edited.id)).toMatchObject({
      title: 'Shed load at the edge',
      owner: 'edge-team',
      generated: false,
    });
    expect(after.actionItems.map((i) => i.title).sort()).toEqual([
      'Add a pool saturation alert',
      'Add pool sizing to the capacity review',
      'Shed load at the edge',
    ]);
  });

  test('edits are revision-checked and a terminal action item state stamps completed_at', async () => {
    const before = (await getPostmortemDetail(app.db, tenantA, incidentA))!;
    expect(
      await updatePostmortemSections(app.db, tenantA, incidentA, before.postmortem.revision - 1, {
        summary: 'stale',
      }),
    ).toBe('stale');
    expect(
      await updatePostmortemSections(app.db, tenantA, incidentA, before.postmortem.revision, {
        summary: 'Checkout degraded for 42 minutes.',
      }),
    ).toBe('updated');
    const after = (await getPostmortemDetail(app.db, tenantA, incidentA))!;
    expect(after.postmortem.revision).toBe(before.postmortem.revision + 1);
    expect(after.postmortem.summary).toBe('Checkout degraded for 42 minutes.');

    const item = before.actionItems.find((i) => i.generated)!;
    const done = await updateActionItem(app.db, tenantA, incidentA, item.id, { state: 'done' });
    expect(done?.completedAt).not.toBeNull();
    const reopened = await updateActionItem(app.db, tenantA, incidentA, item.id, { state: 'open' });
    expect(reopened?.completedAt).toBeNull();
    // The completion-shape CHECK makes a done item without an instant unrepresentable.
    await expectConstraint(
      admin.db
        .update(postmortemActionItems)
        .set({ state: 'done', completedAt: null })
        .where(eq(postmortemActionItems.id, item.id)),
      'postmortem_action_items_completion_shape',
    );
    await expectConstraint(
      admin.db
        .update(postmortemActionItems)
        .set({ trackerUrl: 'http://tracker.example.com/1' })
        .where(eq(postmortemActionItems.id, item.id)),
      'postmortem_action_items_tracker_https',
    );
  });

  test('the report counts untracked and past-due items per tenant only', async () => {
    const overdue = await createActionItem(app.db, tenantA, incidentA, {
      type: 'prevent',
      title: 'Overdue and tracked',
      owner: 'sre',
      trackerUrl: 'https://tracker.example.com/1',
      dueAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(overdue).not.toBeNull();
    const report = await readPostmortemReport(app.db, tenantA);
    expect(report.postmortems).toEqual({ draft: 1, published: 0 });
    expect(report.actionItems.open).toBe(4);
    // Generated item (no owner, no tracker) + the two owned human items with no tracker.
    expect(report.actionItems.untracked).toBe(3);
    expect(report.actionItems.pastDue).toBe(1);
    expect(report.postmortemsWithPastDueItems).toEqual([
      expect.objectContaining({ incidentId: incidentA, pastDue: 1 }),
    ]);
    expect(report.actionItems.openByAge.reduce((sum, b) => sum + b.open, 0)).toBe(4);
    const other = await readPostmortemReport(app.db, tenantB);
    expect(other.actionItems.open).toBe(0);
  });

  test('the create path refuses an action item beyond the per-postmortem cap', async () => {
    expect(
      await saveGeneratedPostmortem(app.db, tenantA, incidentCap, draft({ actionItems: [] })),
    ).toBe('saved');
    const { postmortem } = (await getPostmortemDetail(app.db, tenantA, incidentCap))!;
    // Seed directly to the boundary minus one; the last admitted and the first refused go through the repo.
    await admin.db.insert(postmortemActionItems).values(
      Array.from({ length: MAX_ACTION_ITEMS - 1 }, (_, i) => ({
        tenantId: tenantA,
        postmortemId: postmortem.id,
        type: 'prevent' as const,
        title: `Seeded ${i}`,
      })),
    );
    const item = { type: 'prevent' as const, title: 'Last admitted' };
    expect(await createActionItem(app.db, tenantA, incidentCap, item)).not.toBeNull();
    await expect(createActionItem(app.db, tenantA, incidentCap, item)).rejects.toBeInstanceOf(
      ActionItemLimitError,
    );
    expect((await getPostmortemDetail(app.db, tenantA, incidentCap))!.actionItems).toHaveLength(
      MAX_ACTION_ITEMS,
    );
  });

  test('a regenerate fills only the slots left under the cap by surviving human items', async () => {
    expect(
      await saveGeneratedPostmortem(app.db, tenantA, incidentFull, draft({ actionItems: [] })),
    ).toBe('saved');
    const { postmortem } = (await getPostmortemDetail(app.db, tenantA, incidentFull))!;
    // Non-generated rows survive the regenerate delete; two slots remain under the cap.
    await admin.db.insert(postmortemActionItems).values(
      Array.from({ length: MAX_ACTION_ITEMS - 2 }, (_, i) => ({
        tenantId: tenantA,
        postmortemId: postmortem.id,
        type: 'prevent' as const,
        title: `Human ${i}`,
      })),
    );
    const generated = Array.from({ length: 5 }, (_, i) => ({
      type: 'mitigate' as const,
      title: `Generated ${i}`,
    }));
    expect(
      await saveGeneratedPostmortem(
        app.db,
        tenantA,
        incidentFull,
        draft({ actionItems: generated }),
      ),
    ).toBe('saved');
    const { actionItems } = (await getPostmortemDetail(app.db, tenantA, incidentFull))!;
    expect(actionItems).toHaveLength(MAX_ACTION_ITEMS);
    // One multi-row insert shares a created_at, so the tie-break is the random id; sort for the check.
    expect(
      actionItems
        .filter((i) => i.generated)
        .map((i) => i.title)
        .sort(),
    ).toEqual(['Generated 0', 'Generated 1']);
  });

  test('publish is one way and blocks regeneration; no trusted run means no grade target', async () => {
    const enqueued: { incidentId: string; runId: string }[] = [];
    const published = await publishPostmortem(app.db, tenantA, incidentA, {
      publishedByUserId: userA,
      enqueueGradeTx: async (_tx, payload) => {
        enqueued.push(payload);
        return 'job-1';
      },
    });
    // No trusted run on this incident: published without a grade target.
    expect(published).toEqual({ outcome: 'published', jobId: null });
    expect(enqueued).toEqual([]);
    expect(
      await publishPostmortem(app.db, tenantA, incidentA, {
        publishedByUserId: userA,
        enqueueGradeTx: async () => 'never',
      }),
    ).toEqual({ outcome: 'already_published' });
    expect(await saveGeneratedPostmortem(app.db, tenantA, incidentA, draft())).toBe('published');
    expect(await updatePostmortemSections(app.db, tenantA, incidentA, 3, { summary: 'x' })).toBe(
      'published',
    );
    // The publish-shape CHECK: a published row needs both a publisher and an instant.
    await expectConstraint(
      admin.db
        .update(postmortems)
        .set({ publishedAt: null })
        .where(eq(postmortems.incidentId, incidentA)),
      'postmortems_publish_shape',
    );
  });

  test('a failed grade enqueue rolls the publish back', async () => {
    expect(await saveGeneratedPostmortem(app.db, tenantA, incidentTrusted, draft())).toBe('saved');
    await expect(
      publishPostmortem(app.db, tenantA, incidentTrusted, {
        publishedByUserId: userA,
        enqueueGradeTx: async () => {
          throw new Error('queue insert failed');
        },
      }),
    ).rejects.toThrow('queue insert failed');
    const detail = (await getPostmortemDetail(app.db, tenantA, incidentTrusted))!;
    expect(detail.postmortem).toMatchObject({
      status: 'draft',
      // The pinned run is written in the same transaction, so it must roll back with the publish.
      assessmentRunId: null,
      publishedAt: null,
      publishedByUserId: null,
    });
  });

  test('publish pins the trusted run and enqueues its grade in the same transaction', async () => {
    const enqueued: { incidentId: string; runId: string }[] = [];
    const seenInsideTx: string[] = [];
    const published = await publishPostmortem(app.db, tenantA, incidentTrusted, {
      publishedByUserId: userA,
      enqueueGradeTx: async (tx, payload) => {
        enqueued.push(payload);
        // The same transaction already carries the published row the grade depends on.
        const rows = await tx
          .select({ status: postmortems.status })
          .from(postmortems)
          .where(eq(postmortems.incidentId, incidentTrusted));
        seenInsideTx.push(...rows.map((r) => r.status));
        return 'job-trusted';
      },
    });
    expect(published).toEqual({ outcome: 'published', jobId: 'job-trusted' });
    expect(enqueued).toEqual([{ incidentId: incidentTrusted, runId: runTrusted }]);
    expect(seenInsideTx).toEqual(['published']);
    const detail = (await getPostmortemDetail(app.db, tenantA, incidentTrusted))!;
    expect(detail.postmortem).toMatchObject({
      status: 'published',
      assessmentRunId: runTrusted,
      publishedByUserId: userA,
    });
  });

  test('composite FKs reject a foreign incident and a second postmortem per incident', async () => {
    await expectConstraint(
      withTenant(app.db, tenantA, (tx) =>
        tx.insert(postmortems).values({ tenantId: tenantA, incidentId: incidentB, ...columns() }),
      ),
      'postmortems_incident_fk',
    );
    await expectConstraint(
      withTenant(app.db, tenantA, (tx) =>
        tx.insert(postmortems).values({ tenantId: tenantA, incidentId: incidentA, ...columns() }),
      ),
      'postmortems_incident_uq',
    );
    // RLS: tenant B cannot read or write tenant A's rows even by primary key.
    const rows = await withTenant(app.db, tenantB, (tx) =>
      tx.execute(sql`select id from postmortems where incident_id = ${incidentA}`),
    );
    expect(rows).toHaveLength(0);
  });
});
