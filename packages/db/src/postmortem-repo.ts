import {
  ACTION_ITEM_AGE_BUCKETS,
  ACTION_ITEM_TERMINAL_STATES,
  type ActionItemState,
  type ActionItemType,
  type PostmortemActionItem,
  type PostmortemActionItemAgeBucket,
  type PostmortemDetail,
  type PostmortemDocument,
  type PostmortemReport,
  type PostmortemSections,
  type PostmortemTrigger,
} from '@sre/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getAssessmentGradeForRunTx } from './assessment-grade-repo';
import type { Db } from './client';
import { withTenant, type Tx } from './rls';
import { incidents, postmortemActionItems, postmortems } from './schema';

export interface GeneratedActionItem {
  type: ActionItemType;
  title: string;
}

/** What the generator produces: every section plus untracked action items. */
export interface GeneratedPostmortemInput extends PostmortemSections {
  trigger: PostmortemTrigger;
  assessmentRunId: string | null;
  requestedByUserId: string | null;
  actionItems: GeneratedActionItem[];
}

export interface ActionItemInput {
  type: ActionItemType;
  title: string;
  owner?: string | null;
  trackerUrl?: string | null;
  dueAt?: Date | null;
}

export interface ActionItemPatch {
  title?: string;
  owner?: string | null;
  trackerUrl?: string | null;
  state?: ActionItemState;
  dueAt?: Date | null;
}

export type PublishPostmortemOutcome =
  | { outcome: 'published'; jobId: string | null }
  | { outcome: 'already_published' }
  | { outcome: 'not_found' };

/** Upper bound on action items per postmortem; the create path refuses beyond it. */
export const MAX_ACTION_ITEMS = 100;

/** Raised when a postmortem already holds its maximum number of action items. */
export class ActionItemLimitError extends Error {
  constructor() {
    super('too many action items');
    this.name = 'ActionItemLimitError';
  }
}

function toDocument(row: typeof postmortems.$inferSelect): PostmortemDocument {
  return {
    id: row.id,
    incidentId: row.incidentId,
    status: row.status,
    trigger: row.trigger,
    revision: row.revision,
    assessmentRunId: row.assessmentRunId ?? null,
    requestedByUserId: row.requestedByUserId ?? null,
    publishedByUserId: row.publishedByUserId ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    summary: row.summary,
    impact: row.impact,
    contributingCauses: row.contributingCauses,
    triggerNarrative: row.triggerNarrative,
    resolution: row.resolution,
    detection: row.detection,
    lessons: row.lessons,
    timeline: row.timeline,
    supportingInformation: row.supportingInformation ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toActionItem(row: typeof postmortemActionItems.$inferSelect): PostmortemActionItem {
  return {
    id: row.id,
    postmortemId: row.postmortemId,
    type: row.type,
    title: row.title,
    owner: row.owner ?? null,
    trackerUrl: row.trackerUrl ?? null,
    state: row.state,
    dueAt: row.dueAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    generated: row.generated,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findByIncidentTx(tx: Tx, incidentId: string, lock = false) {
  const query = tx
    .select()
    .from(postmortems)
    .where(eq(postmortems.incidentId, incidentId))
    .limit(1);
  const rows = await (lock ? query.for('update') : query);
  return rows[0] ?? null;
}

async function listActionItemsTx(tx: Tx, postmortemId: string): Promise<PostmortemActionItem[]> {
  const rows = await tx
    .select()
    .from(postmortemActionItems)
    .where(eq(postmortemActionItems.postmortemId, postmortemId))
    .orderBy(asc(postmortemActionItems.createdAt), asc(postmortemActionItems.id));
  return rows.map(toActionItem);
}

/**
 * Reads an incident's postmortem with its action items and the grade of the pinned assessment run.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the incident.
 * @param incidentId - Incident whose postmortem is read.
 */
export async function getPostmortemDetail(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<PostmortemDetail | null> {
  return withTenant(db, tenantId, async (tx) => {
    const row = await findByIncidentTx(tx, incidentId);
    if (!row) return null;
    return {
      postmortem: toDocument(row),
      actionItems: await listActionItemsTx(tx, row.id),
      grade: row.assessmentRunId ? await getAssessmentGradeForRunTx(tx, row.assessmentRunId) : null,
    };
  });
}

/**
 * Reads the status of an incident's postmortem without its body; null when none exists.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the incident.
 * @param incidentId - Incident whose postmortem is checked.
 */
export async function getPostmortemStatus(db: Db, tenantId: string, incidentId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: postmortems.id,
        status: postmortems.status,
        assessmentRunId: postmortems.assessmentRunId,
      })
      .from(postmortems)
      .where(eq(postmortems.incidentId, incidentId))
      .limit(1);
    return rows[0] ?? null;
  });
}

// Replaces only generator-written action items so human-added ones survive a regenerate. A published
// postmortem is never touched; the caller learns that and stops.
/**
 * Writes a generated draft, inserting the postmortem or overwriting an existing draft's sections.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the incident.
 * @param incidentId - Incident the draft belongs to.
 * @param input - Generated sections, declared trigger, pinned run and action items.
 */
export async function saveGeneratedPostmortem(
  db: Db,
  tenantId: string,
  incidentId: string,
  input: GeneratedPostmortemInput,
): Promise<'saved' | 'published'> {
  return withTenant(db, tenantId, async (tx) => {
    const existing = await findByIncidentTx(tx, incidentId, true);
    if (existing?.status === 'published') return 'published';
    const { actionItems, ...sections } = input;
    const [row] = await tx
      .insert(postmortems)
      .values({ tenantId, incidentId, ...sections })
      .onConflictDoUpdate({
        target: [postmortems.tenantId, postmortems.incidentId],
        set: {
          ...sections,
          revision: sql`${postmortems.revision} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: postmortems.id });
    if (!row) throw new Error('postmortem upsert failed');
    await tx
      .delete(postmortemActionItems)
      .where(
        and(
          eq(postmortemActionItems.postmortemId, row.id),
          eq(postmortemActionItems.generated, true),
        ),
      );
    // Human-edited items flip to generated=false and survive the delete, so regenerate + edit cycles
    // could grow past MAX_ACTION_ITEMS and 409 every later human POST. Fill only the free slots.
    const [count] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(postmortemActionItems)
      .where(eq(postmortemActionItems.postmortemId, row.id));
    const admitted = actionItems.slice(0, Math.max(0, MAX_ACTION_ITEMS - (count?.count ?? 0)));
    if (admitted.length > 0)
      await tx.insert(postmortemActionItems).values(
        admitted.map((item) => ({
          tenantId,
          postmortemId: row.id,
          type: item.type,
          title: item.title,
          generated: true,
        })),
      );
    return 'saved';
  });
}

/**
 * Applies a responder's edits under optimistic concurrency: the update lands only when the presented
 * revision is current, and only while the document is a draft.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the incident.
 * @param incidentId - Incident whose postmortem is edited.
 * @param revision - Revision the responder read before editing.
 * @param patch - Sections to replace; already scrubbed by the caller.
 */
export async function updatePostmortemSections(
  db: Db,
  tenantId: string,
  incidentId: string,
  revision: number,
  patch: Partial<PostmortemSections>,
): Promise<'updated' | 'stale' | 'published' | 'not_found'> {
  return withTenant(db, tenantId, async (tx) => {
    const existing = await findByIncidentTx(tx, incidentId, true);
    if (!existing) return 'not_found';
    if (existing.status === 'published') return 'published';
    if (existing.revision !== revision) return 'stale';
    await tx
      .update(postmortems)
      .set({ ...patch, revision: existing.revision + 1, updatedAt: sql`now()` })
      .where(eq(postmortems.id, existing.id));
    return 'updated';
  });
}

// Same transaction so a grade can never exist without the published ground truth that justifies it.
/**
 * Publishes a draft, one way, and enqueues the grade of its pinned run in the same transaction.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the incident.
 * @param incidentId - Incident whose postmortem is published.
 * @param input - Attributed publisher and the durable job writer for the grade.
 */
export async function publishPostmortem(
  db: Db,
  tenantId: string,
  incidentId: string,
  input: {
    publishedByUserId: string;
    enqueueGradeTx: (tx: Tx, payload: { incidentId: string; runId: string }) => Promise<string>;
  },
): Promise<PublishPostmortemOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const existing = await findByIncidentTx(tx, incidentId, true);
    if (!existing) return { outcome: 'not_found' };
    if (existing.status === 'published') return { outcome: 'already_published' };
    // Pin the run in force at publish when generation recorded none, so the grade has a target.
    const runId =
      existing.assessmentRunId ??
      (
        await tx
          .select({ runId: incidents.trustedAssessmentRunId })
          .from(incidents)
          .where(eq(incidents.id, incidentId))
          .limit(1)
      )[0]?.runId ??
      null;
    await tx
      .update(postmortems)
      .set({
        status: 'published',
        assessmentRunId: runId,
        publishedByUserId: input.publishedByUserId,
        publishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(postmortems.id, existing.id));
    const jobId = runId ? await input.enqueueGradeTx(tx, { incidentId, runId }) : null;
    return { outcome: 'published', jobId };
  });
}

/**
 * Adds a human-authored action item to an incident's postmortem.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the incident.
 * @param incidentId - Incident whose postmortem receives the item.
 * @param input - Type, title and optional owner, tracker link and due date.
 */
export async function createActionItem(
  db: Db,
  tenantId: string,
  incidentId: string,
  input: ActionItemInput,
): Promise<PostmortemActionItem | null> {
  return withTenant(db, tenantId, async (tx) => {
    // Row lock so the count and the insert are one step; two concurrent creates cannot both pass.
    const existing = await findByIncidentTx(tx, incidentId, true);
    if (!existing) return null;
    const [count] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(postmortemActionItems)
      .where(eq(postmortemActionItems.postmortemId, existing.id));
    if ((count?.count ?? 0) >= MAX_ACTION_ITEMS) throw new ActionItemLimitError();
    const [row] = await tx
      .insert(postmortemActionItems)
      .values({
        tenantId,
        postmortemId: existing.id,
        type: input.type,
        title: input.title,
        owner: input.owner ?? null,
        trackerUrl: input.trackerUrl ?? null,
        dueAt: input.dueAt ?? null,
      })
      .returning();
    if (!row) throw new Error('action item insert failed');
    return toActionItem(row);
  });
}

/**
 * Updates an action item; a terminal state stamps completed_at and leaving one clears it.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the incident.
 * @param incidentId - Incident whose postmortem owns the item.
 * @param itemId - Action item identifier.
 * @param patch - Fields to change.
 */
export async function updateActionItem(
  db: Db,
  tenantId: string,
  incidentId: string,
  itemId: string,
  patch: ActionItemPatch,
): Promise<PostmortemActionItem | null> {
  return withTenant(db, tenantId, async (tx) => {
    const existing = await findByIncidentTx(tx, incidentId);
    if (!existing) return null;
    const [current] = await tx
      .select()
      .from(postmortemActionItems)
      .where(
        and(
          eq(postmortemActionItems.id, itemId),
          eq(postmortemActionItems.postmortemId, existing.id),
        ),
      )
      .limit(1)
      .for('update');
    if (!current) return null;
    const state = patch.state ?? current.state;
    const terminal = ACTION_ITEM_TERMINAL_STATES.includes(state);
    const [row] = await tx
      .update(postmortemActionItems)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
        ...(patch.trackerUrl !== undefined ? { trackerUrl: patch.trackerUrl } : {}),
        ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
        state,
        // A human edit makes the item theirs; regenerate must not delete it.
        generated: false,
        completedAt: terminal ? (current.completedAt ?? sql`now()`) : null,
        updatedAt: sql`now()`,
      })
      .where(eq(postmortemActionItems.id, current.id))
      .returning();
    return row ? toActionItem(row) : null;
  });
}

// Untracked means no owner or no tracker link; such items are counted as defects, never hidden.
/**
 * Reports a tenant's action items: open by age, untracked, and the postmortems with past-due items.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose postmortems are reported.
 * @param now - Clock used for age and past-due computation.
 */
export async function readPostmortemReport(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<PostmortemReport> {
  // postgres-js binds a Date through drizzle's sql template as an object; pass the ISO text.
  const asOf = now.toISOString();
  return withTenant(db, tenantId, async (tx) => {
    const counts = (
      await tx.execute<{
        draft: number;
        published: number;
        open: number;
        untracked: number;
        pastDue: number;
      }>(sql`
        select
          (select count(*) from postmortems where status = 'draft')::int as "draft",
          (select count(*) from postmortems where status = 'published')::int as "published",
          (select count(*) from postmortem_action_items
            where state in ('open', 'in_progress'))::int as "open",
          (select count(*) from postmortem_action_items
            where state in ('open', 'in_progress')
              and (owner is null or btrim(owner) = '' or tracker_url is null))::int as "untracked",
          (select count(*) from postmortem_action_items
            where state in ('open', 'in_progress')
              and due_at is not null and due_at < ${asOf}::timestamptz)::int as "pastDue"
      `)
    )[0] ?? { draft: 0, published: 0, open: 0, untracked: 0, pastDue: 0 };
    const openByAge: PostmortemActionItemAgeBucket[] = [];
    for (const bucket of ACTION_ITEM_AGE_BUCKETS) {
      const upper =
        bucket.upper === null
          ? sql`true`
          : sql`created_at > ${asOf}::timestamptz - make_interval(days => ${bucket.upper})`;
      const rows = await tx.execute<{ open: number }>(sql`
        select count(*)::int as "open" from postmortem_action_items
        where state in ('open', 'in_progress')
          and created_at <= ${asOf}::timestamptz - make_interval(days => ${bucket.lower})
          and ${upper}
      `);
      openByAge.push({
        label: bucket.label,
        lowerDays: bucket.lower,
        upperDays: bucket.upper,
        open: rows[0]?.open ?? 0,
      });
    }
    const pastDueRows = await tx.execute<{
      incidentId: string;
      postmortemId: string;
      pastDue: number;
    }>(sql`
      select p.incident_id as "incidentId", p.id as "postmortemId", count(*)::int as "pastDue"
      from postmortem_action_items items
      join postmortems p on p.id = items.postmortem_id
      where items.state in ('open', 'in_progress')
        and items.due_at is not null and items.due_at < ${asOf}::timestamptz
      group by p.incident_id, p.id
      order by count(*) desc, p.id
      limit 50
    `);
    return {
      asOf,
      postmortems: { draft: counts.draft, published: counts.published },
      actionItems: {
        open: counts.open,
        openByAge,
        untracked: counts.untracked,
        pastDue: counts.pastDue,
      },
      postmortemsWithPastDueItems: [...pastDueRows],
      definitions: [
        'An action item is open while its state is open or in progress; done and will-not-do are terminal.',
        'Age is measured from when the item was created, not from the incident.',
        'An untracked item has no owner or no tracker link. Generated items start untracked by construction; a human fills them in.',
        'Past due means an open item whose due date has passed.',
      ],
    };
  });
}
