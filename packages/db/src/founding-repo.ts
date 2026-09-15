import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Tx } from './rls';
import { issueDomainChallengeTx } from './domain-repo';
import { workspaceSessionProviderEligible } from './workspace-session-repo';
import {
  identityProviders,
  memberships,
  tenantIdentityBindings,
  tenants,
  workspaceFoundings,
  users,
  browserSessions,
  type FoundingStatus,
  type TenantStatus,
} from './schema';

export type RegistrationMode = 'open' | 'approval_required' | 'closed';
export interface FoundingJobInsert {
  jobId: string;
  created: boolean;
}
export type InsertFoundingJobTx = (tx: Tx, foundingId: string) => Promise<FoundingJobInsert>;
export type WorkspaceFounding = typeof workspaceFoundings.$inferSelect;

const OPEN_FOUNDING_STATUSES: FoundingStatus[] = [
  'awaiting_founder',
  'founder_authenticated',
  'pending',
  'approved',
  'provisioning',
  'failed',
  'rejected',
];

/** Signals that a requested founding transition no longer matches durable state. */
export class FoundingStateError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_founding_state'
      | 'founding_job_busy'
      | 'directory_already_connected'
      | 'registration_closed'
      | 'terms_required' = 'invalid_founding_state',
  ) {
    super(message);
  }
}

/**
 * Creates an own-directory founding without trusting caller-supplied identity metadata.
 *
 * @param db - Control-plane database connection.
 * @param input - Validated public founding details.
 */
export async function createWorkspaceFounding(
  db: Db,
  input: {
    path: 'own_directory';
    slug: string;
    requestedName: string;
    declaredDomain?: string;
  },
): Promise<WorkspaceFounding> {
  const rows = await db
    .insert(workspaceFoundings)
    .values({
      ...input,
      declaredDomain: input.declaredDomain ?? null,
      status: 'awaiting_founder',
      expiresAt: sql`clock_timestamp() + interval '1 hour'`,
    })
    .returning();
  if (!rows[0]) throw new Error('workspace founding insert returned no row');
  return rows[0];
}

/**
 * Attaches the identity verified by the OIDC completion flow to an unexpired founding.
 *
 * @param db - Control-plane database connection.
 * @param input - Verified provider, founder, and optional binding claim.
 */
export async function attachFounderToFounding(
  db: Db,
  input: {
    foundingId: string;
    providerId: string;
    founderUserId: string;
    claimValue?: string | null;
  },
): Promise<WorkspaceFounding> {
  const rows = await db
    .update(workspaceFoundings)
    .set({
      providerId: input.providerId,
      founderUserId: input.founderUserId,
      claimValue: input.claimValue ?? null,
      status: 'founder_authenticated',
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workspaceFoundings.id, input.foundingId),
        eq(workspaceFoundings.status, 'awaiting_founder'),
        gt(workspaceFoundings.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .returning();
  if (!rows[0]) throw new FoundingStateError('founding is missing, expired, or already claimed');
  return rows[0];
}

/**
 * Returns the latest founder-visible workflow, including a rejected request that needs explanation.
 *
 * @param db - Control-plane database connection.
 * @param userId - Founder whose active workflow is requested.
 */
export async function findOpenFoundingForUser(
  db: Db,
  userId: string,
): Promise<WorkspaceFounding | null> {
  const rows = await db
    .select()
    .from(workspaceFoundings)
    .where(
      and(
        eq(workspaceFoundings.founderUserId, userId),
        inArray(workspaceFoundings.status, OPEN_FOUNDING_STATUSES),
      ),
    )
    .orderBy(desc(workspaceFoundings.updatedAt), desc(workspaceFoundings.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Returns a founding only when the supplied user owns it.
 *
 * @param db - Control-plane database connection.
 * @param foundingId - Founding workflow identifier.
 * @param userId - User who must own the workflow.
 */
export async function getFoundingForUser(
  db: Db,
  foundingId: string,
  userId: string,
): Promise<WorkspaceFounding | null> {
  const rows = await db
    .select()
    .from(workspaceFoundings)
    .where(and(eq(workspaceFoundings.id, foundingId), eq(workspaceFoundings.founderUserId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Saves founder details and atomically creates the provisioning command when registration is open.
 *
 * @param db - Control-plane database connection.
 * @param input - Founder-owned address, policy, and transactional queue writer.
 */
export function submitWorkspaceFounding(
  db: Db,
  input: {
    foundingId: string;
    founderUserId: string;
    requestedName: string;
    slug: string;
    registrationMode: RegistrationMode;
    requiredTermsVersion?: string;
    termsAcceptedVersion?: string;
    insertJobTx: InsertFoundingJobTx;
  },
): Promise<WorkspaceFounding & { jobId: string | null }> {
  return db.transaction(async (tx) => {
    if (input.registrationMode === 'closed') {
      throw new FoundingStateError('workspace registration is closed', 'registration_closed');
    }
    if (input.requiredTermsVersion && input.termsAcceptedVersion !== input.requiredTermsVersion) {
      throw new FoundingStateError('terms acceptance is required', 'terms_required');
    }
    const foundings = await tx
      .select()
      .from(workspaceFoundings)
      .where(
        and(
          eq(workspaceFoundings.id, input.foundingId),
          eq(workspaceFoundings.founderUserId, input.founderUserId),
          gt(workspaceFoundings.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .limit(1)
      .for('update');
    const founding = foundings[0];
    if (!founding || founding.status !== 'founder_authenticated') {
      throw new FoundingStateError('founding is not ready to submit');
    }
    const status = input.registrationMode === 'open' ? 'approved' : 'pending';
    const rows = await tx
      .update(workspaceFoundings)
      .set({
        requestedName: input.requestedName,
        slug: input.slug,
        status,
        termsAcceptedVersion: input.termsAcceptedVersion ?? null,
        failureReason: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(workspaceFoundings.id, input.foundingId),
          eq(workspaceFoundings.status, 'founder_authenticated'),
        ),
      )
      .returning();
    if (!rows[0]) throw new FoundingStateError('founding submission lost its state transition');
    const job = status === 'approved' ? await input.insertJobTx(tx, input.foundingId) : null;
    return { ...rows[0], jobId: job?.jobId ?? null };
  });
}

/**
 * Moves an approved founding into the worker-owned provisioning state.
 *
 * @param db - Control-plane database connection.
 * @param foundingId - Approved workflow claimed by the worker.
 */
export function markFoundingProvisioning(
  db: Db,
  foundingId: string,
): Promise<'provisioning' | 'already_active'> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(workspaceFoundings)
      .where(eq(workspaceFoundings.id, foundingId))
      .limit(1)
      .for('update');
    const status = rows[0]?.status;
    if (status === 'active') return 'already_active';
    if (status === 'provisioning') return 'provisioning';
    if (status !== 'approved') throw new FoundingStateError(`founding is ${status ?? 'missing'}`);
    if (!rows[0]?.expiresAt || rows[0].expiresAt.getTime() <= Date.now()) {
      throw new FoundingStateError('founding is expired');
    }
    if (rows[0].providerId) {
      const [provider] = await tx
        .select({ status: identityProviders.status, expiresAt: identityProviders.expiresAt })
        .from(identityProviders)
        .where(eq(identityProviders.id, rows[0].providerId))
        .limit(1)
        .for('update');
      if (
        provider?.status === 'provisional' &&
        provider.expiresAt &&
        provider.expiresAt.getTime() <= Date.now()
      ) {
        throw new FoundingStateError('founding provider is expired');
      }
    }
    await tx
      .update(workspaceFoundings)
      .set({ status: 'provisioning', updatedAt: sql`clock_timestamp()` })
      .where(and(eq(workspaceFoundings.id, foundingId), eq(workspaceFoundings.status, 'approved')));
    return 'provisioning';
  });
}

/**
 * Creates the workspace, provider binding, and first owner in one transaction.
 *
 * @param db - Control-plane database connection.
 * @param foundingId - Provisioning workflow to materialize.
 */
export function provisionFounding(
  db: Db,
  foundingId: string,
): Promise<{ status: 'active' | 'already_active'; tenantId: string }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(workspaceFoundings)
      .where(eq(workspaceFoundings.id, foundingId))
      .limit(1)
      .for('update');
    const founding = rows[0];
    if (!founding) throw new FoundingStateError('founding is missing');
    if (founding.status === 'active' && founding.tenantId) {
      return { status: 'already_active', tenantId: founding.tenantId };
    }
    if (founding.status !== 'provisioning' || !founding.providerId || !founding.founderUserId) {
      throw new FoundingStateError('founding is not ready to provision');
    }
    // The workspace does not exist yet, so no other transaction can lock it before this account.
    const [founder] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, founding.founderUserId))
      .for('no key update');
    if (founder?.status !== 'active') throw new FoundingStateError('founder account is not active');

    const tenantRows = await tx
      .insert(tenants)
      .values({ name: founding.requestedName, slug: founding.slug, status: 'active' })
      .returning({ id: tenants.id });
    const tenantId = tenantRows[0]?.id;
    if (!tenantId) throw new Error('tenant insert returned no row');
    await tx.insert(tenantIdentityBindings).values({
      tenantId,
      providerId: founding.providerId,
      claimValue: founding.claimValue,
    });
    await tx.insert(memberships).values({
      tenantId,
      userId: founding.founderUserId,
      role: 'owner',
      status: 'active',
    });
    const [provider] = await tx
      .select({ status: identityProviders.status, expiresAt: identityProviders.expiresAt })
      .from(identityProviders)
      .where(eq(identityProviders.id, founding.providerId))
      .limit(1);
    if (provider?.status === 'provisional' && provider.expiresAt && founding.declaredDomain) {
      await issueDomainChallengeTx(tx, {
        providerId: founding.providerId,
        tenantId,
        domain: founding.declaredDomain,
      });
    }
    await tx
      .update(identityProviders)
      .set({
        status: sql`case when ${identityProviders.status} = 'provisional' then 'pending_verification' else ${identityProviders.status} end`,
        expiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(identityProviders.id, founding.providerId));
    await tx
      .update(workspaceFoundings)
      .set({
        status: 'active',
        tenantId,
        failureReason: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workspaceFoundings.id, foundingId));
    return { status: 'active', tenantId };
  });
}

/**
 * Records a recoverable provisioning failure without discarding the founder's inputs.
 *
 * @param db - Control-plane database connection.
 * @param foundingId - Provisioning workflow that failed.
 * @param reason - Stable, user-actionable failure description.
 */
export async function failFounding(db: Db, foundingId: string, reason: string): Promise<void> {
  const rows = await db
    .update(workspaceFoundings)
    .set({ status: 'failed', failureReason: reason, updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(workspaceFoundings.id, foundingId),
        inArray(workspaceFoundings.status, ['approved', 'provisioning']),
      ),
    )
    .returning({ id: workspaceFoundings.id });
  if (!rows[0]) throw new FoundingStateError('founding is not provisionable');
}

/**
 * Re-approves one failed founding with a changed address and a new durable command.
 *
 * @param db - Control-plane database connection.
 * @param input - Founder-owned retry details and transactional queue writer.
 */
export function retryWorkspaceFounding(
  db: Db,
  input: {
    foundingId: string;
    founderUserId: string;
    slug: string;
    insertJobTx: InsertFoundingJobTx;
  },
): Promise<WorkspaceFounding & { jobId: string }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(workspaceFoundings)
      .set({
        slug: input.slug,
        status: 'approved',
        failureReason: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(workspaceFoundings.id, input.foundingId),
          eq(workspaceFoundings.founderUserId, input.founderUserId),
          eq(workspaceFoundings.status, 'failed'),
          gt(workspaceFoundings.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning();
    if (!rows[0]) throw new FoundingStateError('founding is not retryable');
    const job = await input.insertJobTx(tx, input.foundingId);
    if (!job.created) {
      throw new FoundingStateError(
        'the previous provisioning attempt is still finishing',
        'founding_job_busy',
      );
    }
    return { ...rows[0], jobId: job.jobId };
  });
}

/**
 * Lists workspaces in which the user has a durable membership.
 *
 * @param db - Control-plane database connection.
 * @param userId - User whose workspace switcher is requested.
 * @param sessionId - Authenticated browser session, absent for bearer-only clients.
 */
export function listWorkspacesForUser(
  db: Db,
  userId: string,
  sessionId?: string,
): Promise<
  Array<{
    id: string;
    name: string;
    slug: string;
    status: TenantStatus;
    role: string;
    signInAvailable: boolean;
    canSelect: boolean;
  }>
> {
  return db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      role: memberships.role,
      canSelect: sessionId
        ? sql<boolean>`${memberships.status} = 'active' and ${tenants.status} = 'active' and exists (
        select 1 from ${browserSessions} s where s.id = ${sessionId} and s.user_id = ${userId}
          and s.revoked_at is null and s.idle_expires_at > clock_timestamp()
          and s.absolute_expires_at > clock_timestamp()
          and ${workspaceSessionProviderEligible(sql`s.provider_id`, sql`${tenants.id}`, sql`s.binding_claim_value`)}
      )`
        : sql<boolean>`false`,
      signInAvailable: sql<boolean>`exists (
        select 1 from ${tenantIdentityBindings} b
        join ${identityProviders} p on p.id = b.provider_id
        where b.tenant_id = ${tenants.id}
          and p.kind = 'oidc' and p.authorization_endpoint is not null
          and p.browser_client_id is not null
          and (p.scope = 'tenant' or (p.tenant_claim is not null and b.claim_value is not null))
          and (not ${tenants.requireDirectory} or p.scope = 'tenant')
          and (p.status = 'active' or (p.status = 'pending_verification' and exists (
            select 1 from ${workspaceFoundings} f
            where f.tenant_id = ${tenants.id} and f.provider_id = p.id
              and f.status = 'active' and f.founder_user_id = ${userId}
          )))
      )`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(eq(memberships.userId, userId), ne(memberships.status, 'removed')))
    .orderBy(tenants.name, tenants.id);
}

/**
 * Returns the public workspace identity and lifecycle status for one tenant id.
 *
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace identifier to summarize.
 */
export async function getWorkspaceSummary(
  db: Db,
  tenantId: string,
): Promise<{ id: string; name: string; slug: string; status: TenantStatus } | null> {
  const rows = await db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return rows[0] ?? null;
}
