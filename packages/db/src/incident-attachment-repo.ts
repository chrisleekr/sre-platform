import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Tx } from './rls';
import { incidentAttachments } from './schema';

export interface NewAttachment {
  incidentId: string;
  /** The hub message that carried the file; omitted when not tied to a specific message. */
  messageId?: string;
  fileId: string;
  name: string;
  mimetype: string;
  urlPrivate: string;
  permalink?: string;
  interpretation?: string;
}

/** One attachment as the dashboard list endpoint projects it — metadata only, never the bytes. */
export interface AttachmentListItem {
  id: string;
  fileId: string;
  name: string;
  mimetype: string;
  permalink: string | null;
  interpretation: string | null;
  messageId: string | null;
}

/** The image an interpret-at-turn pass still needs to describe (interpretation IS NULL). */
export interface UninterpretedImage {
  fileId: string;
  name: string;
  mimetype: string;
  urlPrivate: string;
}

/**
 * Records attachment tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant whose records are read or changed.
 * @param att - Value supplied for att.
 */
export async function recordAttachmentTx(
  tx: Tx,
  tenantId: string,
  att: NewAttachment,
): Promise<void> {
  await tx
    .insert(incidentAttachments)
    .values({ ...att, tenantId })
    .onConflictDoNothing({
      target: [
        incidentAttachments.tenantId,
        incidentAttachments.incidentId,
        incidentAttachments.fileId,
      ],
    });
}

/**
 * Records attachment.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param att - Value supplied for att.
 */
export async function recordAttachment(
  db: Db,
  tenantId: string,
  att: NewAttachment,
): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(incidentAttachments)
      // Trusted tenantId last so a field on `att` can never override the session tenant (invariant);
      // backstopped by the RLS WITH CHECK policy.
      .values({ ...att, tenantId })
      .onConflictDoNothing({
        target: [
          incidentAttachments.tenantId,
          incidentAttachments.incidentId,
          incidentAttachments.fileId,
        ],
      })
      .returning({ id: incidentAttachments.id });
    if (inserted[0]) return inserted[0].id;
    // Conflict: the row already exists for this (tenant, incident, file). Return its id.
    const existing = await tx
      .select({ id: incidentAttachments.id })
      .from(incidentAttachments)
      .where(
        and(
          eq(incidentAttachments.tenantId, tenantId),
          eq(incidentAttachments.incidentId, att.incidentId),
          eq(incidentAttachments.fileId, att.fileId),
        ),
      )
      .limit(1);
    return existing[0]!.id;
  });
}

/**
 * Look an attachment up by its source file id, tenant-scoped (RLS). Null when absent for the tenant.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param fileId - Surface file identifier targeted by the operation.
 */
export async function attachmentByFileId(
  db: Db,
  tenantId: string,
  fileId: string,
): Promise<typeof incidentAttachments.$inferSelect | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(incidentAttachments)
      .where(
        and(eq(incidentAttachments.tenantId, tenantId), eq(incidentAttachments.fileId, fileId)),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * List an incident's attachments (metadata only), oldest-first, for the dashboard. RLS-scoped.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 */
export async function attachmentsForIncident(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<AttachmentListItem[]> {
  return withTenant(db, tenantId, async (tx) => {
    return tx
      .select({
        id: incidentAttachments.id,
        fileId: incidentAttachments.fileId,
        name: incidentAttachments.name,
        mimetype: incidentAttachments.mimetype,
        permalink: incidentAttachments.permalink,
        interpretation: incidentAttachments.interpretation,
        messageId: incidentAttachments.messageId,
      })
      .from(incidentAttachments)
      .where(
        and(
          eq(incidentAttachments.tenantId, tenantId),
          eq(incidentAttachments.incidentId, incidentId),
        ),
      )
      .orderBy(asc(incidentAttachments.createdAt));
  });
}

/**
 * Provides uninterpreted images.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 */
export async function uninterpretedImages(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<UninterpretedImage[]> {
  return withTenant(db, tenantId, async (tx) => {
    return tx
      .select({
        fileId: incidentAttachments.fileId,
        name: incidentAttachments.name,
        mimetype: incidentAttachments.mimetype,
        urlPrivate: incidentAttachments.urlPrivate,
      })
      .from(incidentAttachments)
      .where(
        and(
          eq(incidentAttachments.tenantId, tenantId),
          eq(incidentAttachments.incidentId, incidentId),
          isNull(incidentAttachments.interpretation),
          sql`${incidentAttachments.mimetype} like 'image/%'`,
        ),
      )
      .orderBy(asc(incidentAttachments.createdAt));
  });
}

/**
 * Store the vision interpretation for one attachment, keyed on (tenant, incident, file). RLS-scoped.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param fileId - Surface file identifier targeted by the operation.
 * @param text - Value supplied for text.
 */
export async function setInterpretation(
  db: Db,
  tenantId: string,
  incidentId: string,
  fileId: string,
  text: string,
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .update(incidentAttachments)
      .set({ interpretation: text })
      .where(
        and(
          eq(incidentAttachments.tenantId, tenantId),
          eq(incidentAttachments.incidentId, incidentId),
          eq(incidentAttachments.fileId, fileId),
        ),
      );
  });
}
