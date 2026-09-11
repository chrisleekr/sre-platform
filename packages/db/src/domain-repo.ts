import { randomBytes } from 'node:crypto';
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import type { Tx } from './rls';
import {
  identityProviderDomains,
  identityProviders,
  jobs,
  tenantIdentityBindings,
  tenants,
  workspaceFoundings,
} from './schema';

export const DOMAIN_VERIFY_JOB_TYPE = 'domain.verify';
export const DOMAIN_VERIFY_JOB_STREAM = 'sre:founding';
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

type DomainRow = typeof identityProviderDomains.$inferSelect;
type IssuedDomain = Omit<DomainRow, 'challenge' | 'expiresAt'> & {
  challenge: string;
  expiresAt: Date;
};
export type TxtResolver = (name: string) => Promise<string[][]>;

async function insertSuccessor(
  tx: Tx,
  input: { domainId: string; providerId: string; tenantId: string },
  currentJobId?: string,
): Promise<void> {
  const liveJobConditions: SQL[] = [
    eq(jobs.type, DOMAIN_VERIFY_JOB_TYPE),
    sql`${jobs.payload}->>'domainId' = ${input.domainId}`,
    inArray(jobs.status, ['queued', 'processing']),
  ];
  if (currentJobId) liveJobConditions.push(ne(jobs.id, currentJobId));
  const [existing] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(...liveJobConditions))
    .limit(1);
  if (existing) return;
  await tx.insert(jobs).values({
    tenantId: input.tenantId,
    type: DOMAIN_VERIFY_JOB_TYPE,
    payload: { domainId: input.domainId, providerId: input.providerId },
    idempotencyKey: input.providerId,
    status: 'queued',
    stream: DOMAIN_VERIFY_JOB_STREAM,
    availableAt: sql`clock_timestamp() + interval '5 minutes'`,
  });
}

/**
 * Issues one DNS TXT challenge and its first durable verification command.
 *
 * @param tx - Transaction that is provisioning the directory.
 * @param input - Provider, tenant, and declared domain receiving the proof.
 */
export async function issueDomainChallengeTx(
  tx: Tx,
  input: { providerId: string; tenantId: string; domain: string },
): Promise<IssuedDomain> {
  const challenge = `sre-platform-verify=${randomBytes(24).toString('hex')}`;
  const [domain] = await tx
    .insert(identityProviderDomains)
    .values({
      providerId: input.providerId,
      domain: input.domain.toLowerCase(),
      status: 'pending',
      challenge,
      expiresAt: sql`clock_timestamp() + interval '7 days'`,
    })
    .returning();
  if (!domain?.challenge || !domain.expiresAt) {
    throw new Error('domain challenge insert returned incomplete row');
  }
  await insertSuccessor(tx, {
    domainId: domain.id,
    providerId: input.providerId,
    tenantId: input.tenantId,
  });
  return domain as IssuedDomain;
}

function uniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: string; cause?: unknown };
    if (value.code === '23505') return true;
    current = value.cause;
  }
  return false;
}

/**
 * Checks a DNS TXT proof, then applies one locked and coalesced lifecycle transition.
 *
 * @param db - Control-plane database connection.
 * @param domainId - Domain proof record to check.
 * @param resolveTxt - Injectable DNS TXT resolver.
 * @param currentJobId - Processing command excluded when coalescing its successor.
 */
export async function verifyDomainProof(
  db: Db,
  domainId: string,
  resolveTxt: TxtResolver,
  currentJobId?: string,
): Promise<{ status: 'pending' | 'verified' | 'expired' | 'conflict' }> {
  const [candidate] = await db
    .select()
    .from(identityProviderDomains)
    .where(eq(identityProviderDomains.id, domainId))
    .limit(1);
  if (!candidate) return { status: 'expired' };
  if (candidate.status === 'verified') return { status: 'verified' };
  if (candidate.status === 'failed') return { status: 'conflict' };
  let records: string[][];
  try {
    records = await resolveTxt(`_sre-platform.${candidate.domain}`);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (
      typeof code !== 'string' ||
      ![
        'ENODATA',
        'ENOTFOUND',
        'ESERVFAIL',
        'ETIMEOUT',
        'EREFUSED',
        'ECONNREFUSED',
        'EAI_AGAIN',
      ].includes(code)
    ) {
      throw error;
    }
    records = [];
  }
  const matched = records.some((chunks) => chunks.join('').trim() === candidate.challenge);
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(identityProviderDomains)
        .where(eq(identityProviderDomains.id, domainId))
        .limit(1)
        .for('update');
      if (!current) return { status: 'expired' as const };
      if (current.status === 'verified') return { status: 'verified' as const };
      if (!current.expiresAt || current.expiresAt.getTime() <= Date.now()) {
        await tx
          .update(identityProviderDomains)
          .set({ status: 'failed', lastCheckedAt: sql`clock_timestamp()` })
          .where(eq(identityProviderDomains.id, domainId));
        return { status: 'expired' as const };
      }
      if (matched && current.challenge === candidate.challenge) {
        await tx
          .update(identityProviderDomains)
          .set({
            status: 'verified',
            verifiedAt: sql`clock_timestamp()`,
            lastCheckedAt: sql`clock_timestamp()`,
          })
          .where(eq(identityProviderDomains.id, domainId));
        await tx
          .update(identityProviders)
          .set({ status: 'active', updatedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(identityProviders.id, current.providerId),
              eq(identityProviders.status, 'pending_verification'),
            ),
          );
        await tx
          .update(jobs)
          .set({ status: 'done', updatedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(jobs.type, DOMAIN_VERIFY_JOB_TYPE),
              sql`${jobs.payload}->>'domainId' = ${domainId}`,
              inArray(jobs.status, ['queued', 'processing']),
            ),
          );
        return { status: 'verified' as const };
      }
      await tx
        .update(identityProviderDomains)
        .set({ lastCheckedAt: sql`clock_timestamp()` })
        .where(eq(identityProviderDomains.id, domainId));
      const [binding] = await tx
        .select({ tenantId: tenantIdentityBindings.tenantId })
        .from(tenantIdentityBindings)
        .where(eq(tenantIdentityBindings.providerId, current.providerId))
        .limit(1);
      const [previousJob] = binding
        ? []
        : await tx
            .select({ tenantId: jobs.tenantId })
            .from(jobs)
            .where(
              and(
                eq(jobs.type, DOMAIN_VERIFY_JOB_TYPE),
                sql`${jobs.payload}->>'domainId' = ${domainId}`,
              ),
            )
            .limit(1);
      const tenantId = binding?.tenantId ?? previousJob?.tenantId;
      if (tenantId) {
        await insertSuccessor(
          tx,
          {
            domainId,
            providerId: current.providerId,
            tenantId,
          },
          currentJobId,
        );
      }
      return { status: 'pending' as const };
    });
  } catch (error) {
    if (matched && uniqueViolation(error)) {
      await db
        .update(identityProviderDomains)
        .set({ status: 'failed', lastCheckedAt: sql`clock_timestamp()` })
        .where(eq(identityProviderDomains.id, domainId));
      await db
        .update(jobs)
        .set({ status: 'done', updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(jobs.type, DOMAIN_VERIFY_JOB_TYPE),
            sql`${jobs.payload}->>'domainId' = ${domainId}`,
            inArray(jobs.status, ['queued', 'processing']),
          ),
        );
      return { status: 'conflict' };
    }
    throw error;
  }
}

/**
 * Checks the one directory proof belonging to a founder-owned workflow.
 *
 * @param db - Control-plane database connection.
 * @param foundingId - Founding whose domain proof is requested.
 * @param founderUserId - Verified founder who must own the workflow.
 * @param resolveTxt - Injectable DNS TXT resolver.
 */
export async function verifyFoundingDomainProof(
  db: Db,
  foundingId: string,
  founderUserId: string,
  resolveTxt: TxtResolver,
): Promise<{ status: 'pending' | 'verified' | 'expired' | 'conflict' } | null> {
  const [domain] = await db
    .select({ id: identityProviderDomains.id })
    .from(workspaceFoundings)
    .innerJoin(
      identityProviderDomains,
      eq(identityProviderDomains.providerId, workspaceFoundings.providerId),
    )
    .where(
      and(
        eq(workspaceFoundings.id, foundingId),
        eq(workspaceFoundings.founderUserId, founderUserId),
      ),
    )
    .limit(1);
  return domain ? verifyDomainProof(db, domain.id, resolveTxt) : null;
}

/**
 * Resolves the workspace display context for a verified domain notification.
 *
 * @param db - Control-plane database connection.
 * @param domainId - Domain proof whose owning workspace is requested.
 */
export async function getDomainNotificationContext(db: Db, domainId: string) {
  const [row] = await db
    .select({
      tenantId: tenants.id,
      workspaceName: tenants.name,
      domain: identityProviderDomains.domain,
      expiresAt: identityProviderDomains.expiresAt,
    })
    .from(identityProviderDomains)
    .innerJoin(
      tenantIdentityBindings,
      eq(tenantIdentityBindings.providerId, identityProviderDomains.providerId),
    )
    .innerJoin(tenants, eq(tenants.id, tenantIdentityBindings.tenantId))
    .where(eq(identityProviderDomains.id, domainId))
    .limit(1);
  return row ?? null;
}

/**
 * Returns the DNS proof instructions for a founder-owned workflow.
 *
 * @param db - Control-plane database connection.
 * @param foundingId - Founding whose domain state is requested.
 * @param founderUserId - Verified founder who must own the workflow.
 */
export async function getFoundingDomainChallenge(
  db: Db,
  foundingId: string,
  founderUserId: string,
): Promise<{
  id: string;
  domain: string;
  recordName: string;
  challenge: string;
  status: string;
  expiresAt: Date;
  lastCheckedAt: Date | null;
} | null> {
  const [row] = await db
    .select({
      id: identityProviderDomains.id,
      domain: identityProviderDomains.domain,
      challenge: identityProviderDomains.challenge,
      status: identityProviderDomains.status,
      expiresAt: identityProviderDomains.expiresAt,
      lastCheckedAt: identityProviderDomains.lastCheckedAt,
    })
    .from(workspaceFoundings)
    .innerJoin(
      identityProviderDomains,
      eq(identityProviderDomains.providerId, workspaceFoundings.providerId),
    )
    .where(
      and(
        eq(workspaceFoundings.id, foundingId),
        eq(workspaceFoundings.founderUserId, founderUserId),
      ),
    )
    .limit(1);
  if (!row?.challenge || !row.expiresAt) return null;
  return {
    ...row,
    recordName: `_sre-platform.${row.domain}`,
    challenge: row.challenge,
    expiresAt: row.expiresAt,
  };
}
