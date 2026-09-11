// Objective definitions plus the burn-event time series. The SLI ratio query is pushed down to the
// tenant's metrics backend, which already holds the time series, so only definitions and computed
// burn events are stored here. There is deliberately no SLI sample table.
import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  unique,
  foreignKey,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';

export const slos = pgTable(
  'slos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Human name, unique per tenant (for example "checkout-availability").
    name: text('name').notNull(),
    // The canonical service identifier: the same value carried in `incidents.service`.
    service: text('service').notNull(),
    // availability | latency. Both resolve to a bad-event ratio, so the budget math is one path.
    sliType: text('sli_type').notNull(),
    // Target reliability as a fraction, 0 < target < 1 (for example 0.999).
    target: doublePrecision('target').notNull(),
    // Rolling compliance window in days. The budget is measured over the trailing window.
    windowDays: integer('window_days').notNull(),
    // Required for latency objectives (the slower-than boundary); null for availability.
    thresholdMs: integer('threshold_ms'),
    // Backend-native query returning the bad-event ratio over a window. A `$window` placeholder is
    // substituted with the evaluation window before the query is pushed down.
    metricQuery: text('metric_query').notNull(),
    // Which metrics connector type to run `metric_query` against.
    connectorType: text('connector_type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // Current evaluation health, and the only thing the evaluator writes back onto a definition.
    // Evaluation is best-effort by contract, so a rejected query writes no burn event and a broken
    // objective would otherwise be indistinguishable from one that has simply never run. The pair
    // below is that difference. Both are written only when the outcome CHANGES: an unconditional
    // write would have a healthy tenant update every objective every window, rewriting a small
    // definition table hundreds of times a day to store what it already said.
    //
    // Null while evaluation is healthy; the scrubbed, truncated failure message otherwise.
    lastEvalError: text('last_eval_error'),
    // When the current failure was first seen. Null whenever last_eval_error is null, so the two
    // always agree, and it tracks the current failure rather than the last attempt.
    evalFailingSince: timestamp('eval_failing_since', { withTimezone: true, precision: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    unique('slos_tenant_name_uq').on(t.tenantId, t.name),
    // Needed so slo_burn_events can carry a composite (tenant_id, slo_id) FK for same-tenant integrity.
    unique('slos_tenant_id_uq').on(t.tenantId, t.id),
    // Closed enum the read model branches on; guards every writer, not just the API.
    check('slos_sli_type_ck', sql`sli_type in ('availability', 'latency')`),
    // A valid target leaves a positive error budget (1 - target), so the math never divides by zero.
    check('slos_target_range_ck', sql`target > 0 and target < 1`),
    check('slos_window_days_ck', sql`window_days > 0`),
    // Latency objectives need a threshold; availability objectives must not carry one.
    check('slos_latency_threshold_ck', sql`(sli_type = 'latency') = (threshold_ms is not null)`),
    tenantIsolation(),
  ],
);

export const sloBurnEvents = pgTable(
  'slo_burn_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sloId: uuid('slo_id').notNull(),
    // Remaining budget as a signed fraction of the allowance; negative means over budget.
    budgetPct: doublePrecision('budget_pct').notNull(),
    // Burn rate over the short window named below.
    burnRate: doublePrecision('burn_rate').notNull(),
    // The short window the burn rate was measured over, for example "1h".
    window: text('window').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Same-tenant integrity: a burn event and its objective always share a tenant. Referential checks
    // bypass RLS, so a plain slo_id key would leak another tenant's objective as an existence oracle.
    // Cascade so deleting an objective clears its history.
    foreignKey({
      columns: [t.tenantId, t.sloId],
      foreignColumns: [slos.tenantId, slos.id],
      name: 'slo_burn_events_slo_fk',
    }).onDelete('cascade'),
    // Latest-N-per-objective reads for the triage brief and the dashboard.
    index('slo_burn_events_lookup_idx').on(t.tenantId, t.sloId, t.computedAt),
    tenantIsolation(),
  ],
);
