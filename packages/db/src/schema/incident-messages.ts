// The canonical per-incident conversation log. The triage engine reads/writes
// only this hub; surfaces project it. Under RLS.
import type { IncidentFindingPayload, RecoveryQuestion } from '@sre/contracts';
export type { IncidentFindingPayload } from '@sre/contracts';
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  foreignKey,
  unique,
  jsonb,
} from 'drizzle-orm/pg-core';
import { tenants, users } from './control-plane';
import { incidents } from './incidents';
import { approvals } from './surfaces';
import { tenantIsolation } from './rls';

export interface RecoveryCheck {
  name: string;
  before: string | null;
  now: string;
}

export interface RecoveryMessagePayload {
  recovered: boolean;
  outcome?: 'recovered' | 'recheck' | 'needs_human';
  checks: RecoveryCheck[];
  unknowns: string[];
  questions?: RecoveryQuestion[];
  nextStep: string | null;
  attempt?: number;
  maxChecks?: number;
  nextCheckAt?: string | null;
  scheduleReason?: string | null;
}

export const incidentMessages = pgTable(
  'incident_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    // agent | human | system
    author: text('author').notNull(),
    // text | tool_step | finding | approval
    kind: text('kind').notNull().default('text'),
    content: text('content').notNull(),
    // Concise takeaway a surface may render in place of the full content. Nullable.
    summary: text('summary'),
    // Structured recovery facts let chat surfaces render comparison tables without parsing prose.
    recovery: jsonb('recovery').$type<RecoveryMessagePayload>(),
    // Structured provenance keeps a conclusion, its evidence, and its promotion decision together.
    finding: jsonb('finding').$type<IncidentFindingPayload>(),
    // The surface a human message was typed on (e.g. slack), for cross-surface echo-suppression;
    // The surface a human reply originated on ('slack' or 'dashboard'); null for agent/system
    // messages.
    originSurface: text('origin_surface'),
    // The platform user a human message is attributed to, resolved from the surface author (e.g. a Slack
    // reply's author → tenant member). Nullable: agent/system messages, and human replies whose author
    // could not be resolved to exactly one member (never-wrong-person). Plain FK to users — users has no
    // tenant_id, so tenant scoping is via RLS, not a composite FK.
    authorUserId: uuid('author_user_id').references(() => users.id),
    // The durable approvals row this line links to. For a kind='approval' message: the row it renders —
    // the transient `approval` payload rides the fan-out on live append, and this column makes it survive a
    // reload (history() joins approvals to re-attach {id, options}). For a kind='reply' 'decided: <label>'
    // marker: the exact approval it settled, so the dashboard correlates the decision on the id
    // instead of scanning option labels. Nullable: ordinary lines set none.
    approvalId: uuid('approval_id'),
    // The source event this line was created from, e.g. `slack:<channel>:<ts>` or `recovery:<job-id>`.
    // Nullable for lines without an external or durable job cause. It makes append idempotent BY
    // CONSTRUCTION: a crash between the write and the ACK is not a throw, so only Postgres can cover it.
    originMessageId: text('origin_message_id'),
    // Structured lifecycle audit fields. Only kind='lifecycle' carries them; the human-readable content
    // remains the canonical transcript line while these fields let surfaces order projections safely.
    lifecycleFrom: text('lifecycle_from'),
    lifecycleTo: text('lifecycle_to'),
    lifecycleVersion: integer('lifecycle_version'),
    // Exactly-once key for a transition cause: a dashboard request, human message, signal version, or
    // recovery job. Distinct from origin_message_id, which identifies the source message itself.
    transitionKey: text('transition_key'),
    signalId: uuid('signal_id'),
    signalState: text('signal_state'),
    signalEventType: text('signal_event_type'),
    // precision:3 (ms) so the keyset `before` cursor, which round-trips created_at through a JS Date
    // (ms) via toISOString(), can never skip a row that shares a millisecond but differs in µs.
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    // Composite index for the total-ordered keyset read: history() orders/paginates by
    // (incident_id, created_at, id) and opener() takes the earliest of the same tuple.
    index('incident_messages_incident_created_id_idx').on(t.incidentId, t.createdAt, t.id),
    // Tenant-scoped incident FK: RI checks bypass RLS, so a plain incident_id FK would let one
    // tenant reference/probe another tenant's incident. [pattern]
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'incident_messages_incident_fk',
    }),
    // Composite unique so tenant-scoped children (incident_attachments) can FK (tenant_id,
    // message_id) -> here: RI checks bypass RLS, so a plain message_id FK would leak a cross-tenant
    // existence oracle. Mirrors incidents_tenant_id_uq. [pattern]
    unique('incident_messages_tenant_id_uq').on(t.tenantId, t.id),
    // One hub line per source event, per tenant. Postgres permits many NULLs in a unique index,
    // so uncoupled agent/system lines are unaffected. A redelivered source job conflicts and no-ops.
    unique('incident_messages_origin_uq').on(t.tenantId, t.originMessageId),
    unique('incident_messages_transition_uq').on(t.tenantId, t.transitionKey),
    // Tenant-scoped approval FK: a plain approval_id FK would let one tenant probe another's approval.
    // References approvals_tenant_id_uq. [pattern,]
    foreignKey({
      columns: [t.tenantId, t.approvalId],
      foreignColumns: [approvals.tenantId, approvals.id],
      name: 'incident_messages_approval_fk',
    }),
    tenantIsolation(),
  ],
);
