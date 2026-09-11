import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { tenantSignalPolicies } from './schema';

export interface TenantSignalPolicy {
  retentionDays: number;
  measurementStartedAt: Date | null;
  secondTeamEnabled: boolean;
  customerVisibleEnabled: boolean;
  unsolvedAfterMinutes: number | null;
  classificationMode?: 'shadow' | 'enforce';
  enforcementApprovedAt?: Date | null;
  enforcementApprovedByUserId?: string | null;
  approvedEvaluationId?: string | null;
  approvedCorpusVersion?: string | null;
  approvedContractVersion?: string | null;
  approvedRuntimeFingerprint?: string | null;
}

export type EditableTenantSignalPolicy = Pick<
  TenantSignalPolicy,
  'retentionDays' | 'secondTeamEnabled' | 'customerVisibleEnabled' | 'unsolvedAfterMinutes'
>;

/**
 * Reads the tenant policy or product defaults.
 * @param db - Tenant-scoped database.
 * @param tenantId - Tenant whose policy is requested.
 */
export async function getTenantSignalPolicy(db: Db, tenantId: string): Promise<TenantSignalPolicy> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.select().from(tenantSignalPolicies).limit(1),
  );
  return rows[0]
    ? {
        retentionDays: rows[0].retentionDays,
        measurementStartedAt: rows[0].measurementStartedAt,
        secondTeamEnabled: rows[0].secondTeamEnabled,
        customerVisibleEnabled: rows[0].customerVisibleEnabled,
        unsolvedAfterMinutes: rows[0].unsolvedAfterMinutes,
        classificationMode: rows[0].classificationMode as 'shadow' | 'enforce',
        enforcementApprovedAt: rows[0].enforcementApprovedAt,
        enforcementApprovedByUserId: rows[0].enforcementApprovedByUserId,
        approvedEvaluationId: rows[0].approvedEvaluationId,
        approvedCorpusVersion: rows[0].approvedCorpusVersion,
        approvedContractVersion: rows[0].approvedContractVersion,
        approvedRuntimeFingerprint: rows[0].approvedRuntimeFingerprint,
      }
    : {
        retentionDays: 30,
        measurementStartedAt: null,
        secondTeamEnabled: true,
        customerVisibleEnabled: true,
        unsolvedAfterMinutes: 60,
        classificationMode: 'shadow',
        enforcementApprovedAt: null,
        enforcementApprovedByUserId: null,
        approvedEvaluationId: null,
        approvedCorpusVersion: null,
        approvedContractVersion: null,
        approvedRuntimeFingerprint: null,
      };
}

/**
 * Validates and saves only responder-editable signal settings.
 * @param db - Tenant-scoped database.
 * @param tenantId - Tenant that owns the policy.
 * @param policy - Validated responder-editable settings.
 */
export function setTenantSignalPolicy(
  db: Db,
  tenantId: string,
  policy: EditableTenantSignalPolicy,
) {
  if (
    !Number.isInteger(policy.retentionDays) ||
    policy.retentionDays < 1 ||
    policy.retentionDays > 3650
  )
    throw new Error('retention days must be between 1 and 3650');
  if (
    policy.unsolvedAfterMinutes !== null &&
    (!Number.isInteger(policy.unsolvedAfterMinutes) ||
      policy.unsolvedAfterMinutes < 1 ||
      policy.unsolvedAfterMinutes > 10_080)
  )
    throw new Error('unsolved age must be null or between 1 and 10080 minutes');
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(tenantSignalPolicies)
      .values({ tenantId, ...policy })
      .onConflictDoUpdate({
        target: tenantSignalPolicies.tenantId,
        set: { ...policy, updatedAt: sql`now()` },
      })
      .returning();
    return rows[0]!;
  });
}
