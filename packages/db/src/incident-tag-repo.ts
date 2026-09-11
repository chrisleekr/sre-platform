import { redactInput, scrubSecrets } from '@sre/contracts';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { filterIncidentDataEvidenceIdsTx } from './tool-call-repo';
import { withTenant } from './rls';
import type { Tx } from './rls';
import {
  incidentTags,
  incidentTagSuggestions,
  incidents,
  investigationRuns,
  tenantTagLinkRules,
} from './schema';

export interface AddIncidentTagInput {
  incidentId: string;
  tag: string;
  actorUserId: string;
  source: 'dashboard' | 'slack';
}

/**
 * Trims and validates only the storage bounds promised for free-form tags.
 * @param value - Candidate free-form tag.
 */
export function validateIncidentTag(value: string): string {
  const tag = value.trim();
  if (!tag) throw new Error('tag is required');
  if (tag.length > 128) throw new Error('tag length exceeds 128 characters');
  if (/\s/.test(tag)) throw new Error('tag cannot contain whitespace');
  if (scrubSecrets(tag) !== tag) throw new Error('tag must not contain credential material');
  return tag;
}

/**
 * Applies one attributed free-form tag under the tenant and incident ownership fence.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param input - Incident, tag, actor, and surface attribution.
 */
export async function addIncidentTag(db: Db, tenantId: string, input: AddIncidentTagInput) {
  const tag = validateIncidentTag(input.tag);
  return withTenant(db, tenantId, (tx) => addIncidentTagTx(tx, tenantId, { ...input, tag }));
}

/**
 * Applies an attributed tag inside an existing tenant transaction.
 * @param tx - Existing tenant transaction.
 * @param tenantId - Owning tenant.
 * @param input - Incident, tag, actor, and surface attribution.
 */
export async function addIncidentTagTx(tx: Tx, tenantId: string, input: AddIncidentTagInput) {
  const tag = validateIncidentTag(input.tag);
  const rows = await tx
    .insert(incidentTags)
    .values({ tenantId, ...input, tag })
    .onConflictDoNothing()
    .returning();
  if (rows[0]) return rows[0];
  const existing = await tx
    .select()
    .from(incidentTags)
    .where(and(eq(incidentTags.incidentId, input.incidentId), eq(incidentTags.tag, tag)))
    .limit(1);
  if (!existing[0]) throw new Error('incident tag could not be applied');
  return existing[0];
}

/**
 * Lists applied tags for one tenant-owned Incident.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param incidentId - Tenant-owned Incident.
 */
export function listIncidentTags(db: Db, tenantId: string, incidentId: string) {
  return withTenant(db, tenantId, (tx) => listIncidentTagsTx(tx, tenantId, incidentId));
}

/**
 * Lists applied tags inside an existing tenant transaction.
 * @param tx - Existing tenant transaction.
 * @param tenantId - Owning tenant.
 * @param incidentId - Tenant-owned Incident.
 */
export function listIncidentTagsTx(tx: Tx, tenantId: string, incidentId: string) {
  return tx
    .select()
    .from(incidentTags)
    .where(and(eq(incidentTags.tenantId, tenantId), eq(incidentTags.incidentId, incidentId)))
    .orderBy(incidentTags.createdAt, incidentTags.id);
}

/**
 * Removes one tenant-owned applied tag.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param incidentId - Tenant-owned Incident.
 * @param tagId - Applied tag identifier.
 */
export function removeIncidentTag(db: Db, tenantId: string, incidentId: string, tagId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const selected = await tx
      .select({ id: incidentTags.id })
      .from(incidentTags)
      .where(
        and(
          eq(incidentTags.tenantId, tenantId),
          eq(incidentTags.id, tagId),
          eq(incidentTags.incidentId, incidentId),
        ),
      )
      .limit(1)
      .for('update');
    if (!selected[0]) return false;
    await tx
      .update(incidentTagSuggestions)
      .set({ appliedTagId: null })
      .where(
        and(
          eq(incidentTagSuggestions.tenantId, tenantId),
          eq(incidentTagSuggestions.appliedTagId, selected[0].id),
        ),
      );
    const rows = await tx
      .delete(incidentTags)
      .where(
        and(
          eq(incidentTags.tenantId, tenantId),
          eq(incidentTags.id, tagId),
          eq(incidentTags.incidentId, incidentId),
        ),
      )
      .returning({ id: incidentTags.id });
    return rows.length === 1;
  });
}

/**
 * Removes one applied tag by value inside an existing tenant transaction.
 * @param tx - Existing tenant transaction.
 * @param tenantId - Owning tenant.
 * @param incidentId - Tenant-owned Incident.
 * @param tag - Exact free-form tag to remove.
 */
export async function removeIncidentTagByValueTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  tag: string,
) {
  const normalized = validateIncidentTag(tag);
  const selected = await tx
    .select({ id: incidentTags.id })
    .from(incidentTags)
    .where(
      and(
        eq(incidentTags.tenantId, tenantId),
        eq(incidentTags.incidentId, incidentId),
        eq(incidentTags.tag, normalized),
      ),
    )
    .limit(1)
    .for('update');
  if (!selected[0]) return false;
  await tx
    .update(incidentTagSuggestions)
    .set({ appliedTagId: null })
    .where(
      and(
        eq(incidentTagSuggestions.tenantId, tenantId),
        eq(incidentTagSuggestions.appliedTagId, selected[0].id),
      ),
    );
  const rows = await tx
    .delete(incidentTags)
    .where(
      and(
        eq(incidentTags.tenantId, tenantId),
        eq(incidentTags.incidentId, incidentId),
        eq(incidentTags.tag, normalized),
      ),
    )
    .returning({ id: incidentTags.id });
  return rows.length === 1;
}

/**
 * Ranks tenant-local applied history without imposing a global vocabulary.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param options - Prefix and bounded result count.
 */
export function listIncidentTagSuggestions(
  db: Db,
  tenantId: string,
  options: { prefix?: string; limit: number },
) {
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit)));
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ tag: incidentTags.tag, appliedCount: count() })
      .from(incidentTags)
      .where(options.prefix ? sql`${incidentTags.tag} like ${`${options.prefix}%`}` : undefined)
      .groupBy(incidentTags.tag)
      .orderBy(desc(count()), incidentTags.tag)
      .limit(limit);
    return rows.map((row) => ({ tag: row.tag, appliedCount: Number(row.appliedCount) }));
  });
}

export interface CauseTagSuggestionInput {
  incidentId: string;
  runId: string;
  suggestions: Array<{ tag: string; evidenceIds: string[] }>;
}

/**
 * Persists only cause suggestions backed by accepted conclusive data evidence.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param input - Accepted run and proposed evidence-linked causes.
 */
export function recordAcceptedCauseTagSuggestions(
  db: Db,
  tenantId: string,
  input: CauseTagSuggestionInput,
) {
  return withTenant(db, tenantId, (tx) => recordAcceptedCauseTagSuggestionsTx(tx, tenantId, input));
}

/**
 * Persists accepted cause suggestions inside the assessment-promotion transaction.
 * @param tx - Existing tenant transaction.
 * @param tenantId - Owning tenant.
 * @param input - Accepted run and evidence-linked cause proposals.
 */
export async function recordAcceptedCauseTagSuggestionsTx(
  tx: Tx,
  tenantId: string,
  input: CauseTagSuggestionInput,
) {
  const accepted = await tx
    .select({
      trustedRunId: incidents.trustedAssessmentRunId,
      outcome: investigationRuns.outcome,
      runEvidenceIds: investigationRuns.evidenceIds,
    })
    .from(incidents)
    .innerJoin(
      investigationRuns,
      and(eq(investigationRuns.id, input.runId), eq(investigationRuns.incidentId, incidents.id)),
    )
    .where(eq(incidents.id, input.incidentId))
    .limit(1);
  const run = accepted[0];
  if (!run || run.trustedRunId !== input.runId || run.outcome !== 'conclusive') return [];
  const runEvidence = new Set(run.runEvidenceIds);
  const inserted = [];
  for (const proposal of input.suggestions) {
    let tag: string;
    try {
      tag = validateIncidentTag(proposal.tag);
    } catch {
      continue;
    }
    if (scrubSecrets(tag) !== tag) continue;
    if (!tag.startsWith('cause:')) continue;
    const valid = await filterIncidentDataEvidenceIdsTx(tx, input.incidentId, proposal.evidenceIds);
    const evidenceIds = valid.filter((id) => runEvidence.has(id));
    if (evidenceIds.length === 0) continue;
    const rows = await tx
      .insert(incidentTagSuggestions)
      .values({
        tenantId,
        incidentId: input.incidentId,
        runId: input.runId,
        tag,
        evidenceIds,
      })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) inserted.push(rows[0]);
  }
  return inserted;
}

/**
 * Lists visible, unapplied evidence-backed suggestions for one Incident.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param incidentId - Tenant-owned Incident.
 */
export function listPendingIncidentTagSuggestions(db: Db, tenantId: string, incidentId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(incidentTagSuggestions)
      .where(
        and(
          eq(incidentTagSuggestions.incidentId, incidentId),
          sql`${incidentTagSuggestions.appliedAt} is null`,
        ),
      )
      .orderBy(incidentTagSuggestions.createdAt, incidentTagSuggestions.id),
  );
}

/**
 * Accepts or edits a suggestion through the attributed applied-tag path.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param input - Suggestion, final tag, actor, and surface attribution.
 */
export function acceptIncidentTagSuggestion(
  db: Db,
  tenantId: string,
  input: {
    incidentId: string;
    suggestionId: string;
    tag: string;
    actorUserId: string;
    source: 'dashboard' | 'slack';
  },
) {
  const tag = validateIncidentTag(input.tag);
  return withTenant(db, tenantId, async (tx) => {
    const suggestions = await tx
      .select()
      .from(incidentTagSuggestions)
      .where(
        and(
          eq(incidentTagSuggestions.id, input.suggestionId),
          eq(incidentTagSuggestions.incidentId, input.incidentId),
          sql`${incidentTagSuggestions.appliedAt} is null`,
        ),
      )
      .limit(1)
      .for('update');
    if (!suggestions[0]) return null;
    const applied = await tx
      .insert(incidentTags)
      .values({
        tenantId,
        incidentId: input.incidentId,
        tag,
        actorUserId: input.actorUserId,
        source: input.source,
      })
      .onConflictDoNothing()
      .returning();
    const tagRow =
      applied[0] ??
      (
        await tx
          .select()
          .from(incidentTags)
          .where(and(eq(incidentTags.incidentId, input.incidentId), eq(incidentTags.tag, tag)))
          .limit(1)
      )[0];
    if (!tagRow) throw new Error('accepted tag could not be read');
    await tx
      .update(incidentTagSuggestions)
      .set({ appliedAt: sql`now()`, appliedTagId: tagRow.id })
      .where(eq(incidentTagSuggestions.id, input.suggestionId));
    return tagRow;
  });
}

/**
 * Saves one tenant tag-link rule; invalid rules remain harmless at render time.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param input - Prefix and URL template.
 */
export async function setTenantTagLinkRule(
  db: Db,
  tenantId: string,
  input: { prefix: string; urlTemplate: string },
) {
  const prefix = validateIncidentTag(input.prefix);
  if (prefix.includes(':')) throw new Error('tag link prefix cannot contain a colon');
  const template = input.urlTemplate.trim();
  if (!template.includes('{value}')) throw new Error('tag link URL must contain {value}');
  if (scrubSecrets(template) !== template)
    throw new Error('tag link URL must not contain credentials');
  const preview = new URL(template.replaceAll('{value}', 'preview'));
  if (preview.protocol !== 'https:' || preview.username || preview.password)
    throw new Error('tag link URL must be HTTPS without credentials');
  const query = Object.fromEntries(preview.searchParams.entries());
  const fragment = Object.fromEntries(new URLSearchParams(preview.hash.slice(1)).entries());
  if (
    JSON.stringify(redactInput(query)) !== JSON.stringify(query) ||
    JSON.stringify(redactInput(fragment)) !== JSON.stringify(fragment)
  )
    throw new Error('tag link URL must not contain credential parameters');
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(tenantTagLinkRules)
      .values({ tenantId, prefix, urlTemplate: template })
      .onConflictDoUpdate({
        target: [tenantTagLinkRules.tenantId, tenantTagLinkRules.prefix],
        set: { urlTemplate: template, updatedAt: sql`now()` },
      })
      .returning();
    return rows[0]!;
  });
}

/**
 * Removes one tenant-owned tag-link rule.
 * @param db - Tenant-scoped database.
 * @param tenantId - Tenant that owns the rule.
 * @param prefix - Tag prefix whose rule should be removed.
 */
export function removeTenantTagLinkRule(db: Db, tenantId: string, prefix: string) {
  const normalized = validateIncidentTag(prefix);
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .delete(tenantTagLinkRules)
      .where(eq(tenantTagLinkRules.prefix, normalized))
      .returning({ prefix: tenantTagLinkRules.prefix });
    return rows.length === 1;
  });
}

/**
 * Lists tenant tag-link rules for safe surface rendering.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 */
export function listTenantTagLinkRules(db: Db, tenantId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({ prefix: tenantTagLinkRules.prefix, urlTemplate: tenantTagLinkRules.urlTemplate })
      .from(tenantTagLinkRules)
      .orderBy(tenantTagLinkRules.prefix),
  );
}
