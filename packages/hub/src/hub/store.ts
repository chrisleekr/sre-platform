import {
  approvals,
  enqueueConnectedSurfaceDeliveriesTx,
  incidentMessages,
  incidents,
  lockResponseGroupWorkTx,
  withTenant,
  type Db,
  type Tx,
} from '@sre/db';
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import {
  shouldMirrorToSurfaces,
  toHubMessage,
  type ApprovalPayload,
  type HubCursor,
  type HubMessage,
  type NewMessage,
} from './contracts';

export class HubStore {
  constructor(private readonly db: Db) {}

  /**
   * Insert-only half of {@link append}: writes the incident_messages row on the passed tx (which must
   * already carry the tenant RLS context) and returns the reconstructed HubMessage. NO Redis — the
   * caller runs post-commit fan-out via {@link publishAppended}. Split out so a caller can share this
   * insert's transaction with another write, e.g. the atomic human-reply + resume-job insert:
   * a failed resume rolls back the message with it.
   */
  async appendTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    msg: NewMessage,
  ): Promise<HubMessage> {
    return (await this.appendTxOnce(tx, tenantId, incidentId, msg)).message;
  }

  /**
   * {@link appendTx} plus the bit the caller needs to be idempotent: whether THIS call wrote the row.
   *
   * With `originMessageId`, the insert is `ON CONFLICT (tenant_id, origin_message_id) DO NOTHING` and a
   * conflict re-selects the existing row (`inserted:false`) — the redelivery of an at-least-once inbound
   * job re-appends nothing. Without it (agent/system lines) this is the plain insert, exactly as before.
   */
  async appendTxOnce(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    msg: NewMessage,
  ): Promise<{ message: HubMessage; inserted: boolean }> {
    // Share the publication fence so a concurrent correction cannot enter behind a reviewed result.
    if (msg.author === 'human') {
      // Signal writers lock group work before the incident row; taking the row first here, then the
      // work lock in a resume enqueue, would deadlock against them.
      await lockResponseGroupWorkTx(tx, tenantId, incidentId);
      await tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.id, incidentId))
        .for('update');
    }
    const values = {
      tenantId,
      incidentId,
      author: msg.author,
      kind: msg.kind ?? 'text',
      content: msg.content,
      summary: msg.summary ?? null,
      recovery: msg.recovery ?? null,
      finding: msg.finding ?? null,
      originSurface: msg.originSurface ?? null,
      authorUserId: msg.authorUserId ?? null,
      approvalId: msg.approvalId ?? null,
      originMessageId: msg.originMessageId ?? null,
      lifecycleFrom: msg.lifecycleFrom ?? null,
      lifecycleTo: msg.lifecycleTo ?? null,
      lifecycleVersion: msg.lifecycleVersion ?? null,
      transitionKey: msg.transitionKey ?? null,
      // now() is transaction-start time; a waiting transaction must not sort before consumed input.
      ...(msg.author === 'human'
        ? {
            createdAt: sql<Date>`greatest(date_trunc('milliseconds', clock_timestamp()),
        coalesce((select max(created_at) + interval '1 millisecond' from incident_messages
          where incident_id = ${incidentId} and author = 'human'), '-infinity'::timestamptz))`,
          }
        : {}),
      signalId: msg.signalId ?? null,
      signalState: msg.signalState ?? null,
      signalEventType: msg.signalEventType ?? null,
    };
    const insert = tx.insert(incidentMessages).values(values);
    const rows = await (msg.transitionKey !== undefined
      ? insert
          .onConflictDoNothing({
            target: [incidentMessages.tenantId, incidentMessages.transitionKey],
          })
          .returning()
      : msg.originMessageId !== undefined
        ? insert
            .onConflictDoNothing({
              target: [incidentMessages.tenantId, incidentMessages.originMessageId],
            })
            .returning()
        : insert.returning());
    if (rows[0]) {
      const message = { ...toHubMessage(rows[0]), approval: msg.approval };
      if (shouldMirrorToSurfaces(message)) {
        await enqueueConnectedSurfaceDeliveriesTx(
          tx,
          tenantId,
          incidentId,
          message.id,
          message.kind,
          message.kind === 'lifecycle' ? null : message.originSurface,
        );
      }
      return { message, inserted: true };
    }
    // Conflict: this surface message already has its hub line (a redelivery). Return it, tenant-scoped.
    const existing = await tx
      .select()
      .from(incidentMessages)
      .where(
        msg.transitionKey !== undefined
          ? eq(incidentMessages.transitionKey, msg.transitionKey)
          : eq(incidentMessages.originMessageId, msg.originMessageId!),
      )
      .limit(1);
    return { message: toHubMessage(existing[0]!), inserted: false };
  }

  /** Find a committed idempotent event so a redelivery can publish it without repeating its work. */
  async appendedByOrigin(
    tenantId: string,
    incidentId: string,
    originMessageId: string,
  ): Promise<HubMessage | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(incidentMessages)
        .where(
          and(
            eq(incidentMessages.incidentId, incidentId),
            eq(incidentMessages.originMessageId, originMessageId),
          ),
        )
        .limit(1);
      return rows[0] ? toHubMessage(rows[0]) : null;
    });
  }

  /** Find a committed lifecycle transition so a redelivery can recover its post-commit fan-out. */
  async appendedByTransition(
    tenantId: string,
    incidentId: string,
    transitionKey: string,
  ): Promise<HubMessage | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(incidentMessages)
        .where(
          and(
            eq(incidentMessages.incidentId, incidentId),
            eq(incidentMessages.transitionKey, transitionKey),
          ),
        )
        .limit(1);
      return rows[0] ? toHubMessage(rows[0]) : null;
    });
  }

  /**
   * Canonical conversation, ALWAYS ascending by the total order `(created_at, id)` — the id tiebreak makes
   * it deterministic when rows share a created_at (two appends in one tx get the same now()). Under RLS.
   *
   * - default: every message, oldest→newest.
   * - `before`: only rows strictly older than the cursor, via `(created_at, id) < (before.createdAt, before.id)`.
   * - `limit`: the NEWEST-N rows, fetched desc+limit at the index tip then reversed so the returned slice is
   * still ascending. Combined with `before`, it's the newest-N older than the cursor (a backward page).
   */
  async history(
    tenantId: string,
    incidentId: string,
    opts?: { limit?: number; before?: HubCursor },
  ): Promise<HubMessage[]> {
    const where = [eq(incidentMessages.incidentId, incidentId)];
    if (opts?.before) {
      const beforeAt = new Date(opts.before.createdAt);
      where.push(
        or(
          lt(incidentMessages.createdAt, beforeAt),
          and(eq(incidentMessages.createdAt, beforeAt), lt(incidentMessages.id, opts.before.id)),
        )!,
      );
    }
    const rows = await withTenant(this.db, tenantId, (tx) => {
      // LEFT JOIN approvals so a kind='approval' message durably re-attaches its {id, options} on
      // reload (the transient `approval` only rides live append). Same-tenant join; RLS scopes both.
      const sel = tx
        .select({
          msg: incidentMessages,
          approvalId: approvals.id,
          approvalOptions: approvals.options,
        })
        .from(incidentMessages)
        .leftJoin(
          approvals,
          and(
            eq(approvals.id, incidentMessages.approvalId),
            eq(approvals.tenantId, incidentMessages.tenantId),
          ),
        )
        .where(and(...where));
      // With a limit, page from the newest end so the slice is the latest N; reverse to ascending below.
      if (opts?.limit !== undefined) {
        return sel
          .orderBy(desc(incidentMessages.createdAt), desc(incidentMessages.id))
          .limit(opts.limit);
      }
      return sel.orderBy(asc(incidentMessages.createdAt), asc(incidentMessages.id));
    });
    const ordered = opts?.limit !== undefined ? rows.reverse() : rows;
    return ordered.map((r) => {
      const message = toHubMessage(r.msg);
      // Re-attach the durable approval only for an approval message with a joined row.
      if (r.msg.kind === 'approval' && r.approvalId) {
        message.approval = {
          id: r.approvalId,
          options: r.approvalOptions as ApprovalPayload['options'],
        };
      }
      return message;
    });
  }

  /** Earliest `(created_at, id)` message for an incident, or null when there are none. Under RLS. */
  async opener(tenantId: string, incidentId: string): Promise<HubMessage | null> {
    const rows = await withTenant(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, incidentId))
        .orderBy(asc(incidentMessages.createdAt), asc(incidentMessages.id))
        .limit(1),
    );
    return rows[0] ? toHubMessage(rows[0]) : null;
  }
}
