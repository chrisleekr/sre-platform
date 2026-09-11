// Author attribution label for a human reply synced to a surface. Kept separate from the deps
// wiring so the two security-relevant rules — local-part ONLY (no PII address leaves the control plane)
// and never-throws (a lookup failure degrades to unattributed) — are unit-tested without a DB.

/** Reduce a stored email to a stable, non-PII Slack label: the local-part only, or null. */
export function emailToLabel(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null; // no '@' → not a usable address, treat as unresolved
  const local = email.split('@')[0];
  return local || null; // empty local-part ('@x') → null
}

/** Best-effort author label: never throws — a lookup failure degrades to null (unattributed). */
export async function resolveAuthorLabel(
  lookupEmail: (tenantId: string, userId: string) => Promise<string | null>,
  tenantId: string,
  authorUserId: string,
): Promise<string | null> {
  try {
    return emailToLabel(await lookupEmail(tenantId, authorUserId));
  } catch {
    return null;
  }
}
