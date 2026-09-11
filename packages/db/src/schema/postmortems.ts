// Postmortems are not runbooks: contributing causes plus action items tracked to done (Ch 15).
// Under RLS. One per incident; regenerate overwrites a draft, never a published document.
import {
  ACTION_ITEM_STATES,
  ACTION_ITEM_TYPES,
  POSTMORTEM_STATUSES,
  POSTMORTEM_TRIGGERS,
  type ActionItemState,
  type ActionItemType,
  type ContributingCause,
  type PostmortemLessons,
  type PostmortemStatus,
  type PostmortemTimelineEntry,
  type PostmortemTrigger,
} from '@sre/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, tenants } from './control-plane';
import { incidents } from './incidents';
import { tenantIsolation } from './rls';

const vocabulary = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`);

export const postmortems = pgTable(
  'postmortems',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    status: text('status').$type<PostmortemStatus>().notNull().default('draft'),
    // Which Ch 15 trigger the responder declared when commanding generation. Stored, never inferred.
    trigger: text('trigger').$type<PostmortemTrigger>().notNull(),
    summary: text('summary').notNull(),
    impact: text('impact').notNull(),
    contributingCauses: jsonb('contributing_causes').$type<ContributingCause[]>().notNull(),
    triggerNarrative: text('trigger_narrative').notNull(),
    resolution: text('resolution').notNull(),
    detection: text('detection').notNull(),
    lessons: jsonb('lessons').$type<PostmortemLessons>().notNull(),
    timeline: jsonb('timeline').$type<PostmortemTimelineEntry[]>().notNull(),
    supportingInformation: text('supporting_information'),
    // Optimistic concurrency for edits; every PATCH presents the revision it read.
    revision: integer('revision').notNull().default(1),
    // The assessment run in force when the postmortem was generated. The grade targets it, so a later
    // resume cannot silently move the graded claim.
    assessmentRunId: uuid('assessment_run_id'),
    requestedByUserId: uuid('requested_by_user_id'),
    publishedByUserId: uuid('published_by_user_id'),
    publishedAt: timestamp('published_at', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    // Parent of the action items' composite same-tenant FK.
    unique('postmortems_tenant_id_uq').on(t.tenantId, t.id),
    unique('postmortems_incident_uq').on(t.tenantId, t.incidentId),
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'postmortems_incident_fk',
    }),
    foreignKey({
      columns: [t.publishedByUserId, t.tenantId],
      foreignColumns: [memberships.userId, memberships.tenantId],
      name: 'postmortems_publisher_fk',
    }),
    check('postmortems_status_vocabulary', vocabulary('status', POSTMORTEM_STATUSES)),
    check('postmortems_trigger_vocabulary', vocabulary('trigger', POSTMORTEM_TRIGGERS)),
    check(
      'postmortems_publish_shape',
      sql`(${t.status} = 'published') = (${t.publishedAt} is not null and ${t.publishedByUserId} is not null)`,
    ),
    tenantIsolation(),
  ],
);

export const postmortemActionItems = pgTable(
  'postmortem_action_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    postmortemId: uuid('postmortem_id').notNull(),
    type: text('type').$type<ActionItemType>().notNull(),
    title: text('title').notNull(),
    // Owner is attribution (who to ask), free text so a team name is as valid as a person.
    owner: text('owner'),
    trackerUrl: text('tracker_url'),
    state: text('state').$type<ActionItemState>().notNull().default('open'),
    dueAt: timestamp('due_at', { withTimezone: true, precision: 3 }),
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
    // Generator-written items are replaced on regenerate; human-added ones survive it.
    generated: boolean('generated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.postmortemId],
      foreignColumns: [postmortems.tenantId, postmortems.id],
      name: 'postmortem_action_items_postmortem_fk',
    }).onDelete('cascade'),
    index('postmortem_action_items_state_idx').on(t.tenantId, t.state, t.dueAt),
    check('postmortem_action_items_type_vocabulary', vocabulary('type', ACTION_ITEM_TYPES)),
    check('postmortem_action_items_state_vocabulary', vocabulary('state', ACTION_ITEM_STATES)),
    check('postmortem_action_items_title_not_blank', sql`btrim(${t.title}) <> ''`),
    check(
      'postmortem_action_items_tracker_https',
      sql`${t.trackerUrl} is null or ${t.trackerUrl} like 'https://%'`,
    ),
    // Terminal states carry a completion instant; open ones do not.
    check(
      'postmortem_action_items_completion_shape',
      sql`(${t.state} in ('done', 'wont_do')) = (${t.completedAt} is not null)`,
    ),
    tenantIsolation(),
  ],
);
