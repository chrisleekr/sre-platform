import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import { lockOwnershipWorkspaces } from './ownership';
import {
  identityProviderDomains,
  identityProviders,
  memberships,
  platformAdminInvitations,
  platformOperators,
  tenantIdentityBindings,
  tenantInvitations,
  tenants,
  users,
  workspaceFoundings,
  type MembershipRole,
} from './schema';

export {
  upsertUserForSignIn,
  type SignInIdentity,
  type SignInResult,
  type SignInUser,
} from './sign-in-repo';

export interface Identity {
  issuer: string;
  subject: string;
  email?: string;
}

/**
 * JIT upsert: create the canonical user on first sight, and keep its id stable afterwards.
 *
 * @param db - Database connection used for the operation.
 * @param identity - Validated identity used by the operation.
 */
export async function upsertIdentity(db: Db, identity: Identity): Promise<string> {
  const { issuer, subject, email } = identity;
  const [inserted] = await db
    .insert(users)
    .values({ issuer, subject, email })
    .onConflictDoUpdate({
      target: [users.issuer, users.subject],
      // No-clobber: an absent incoming email keeps the stored value (coalesce($1, "users"."email")).
      set: { email: sql`coalesce(${email ?? null}, ${users.email})` },
      // An identical bootstrap rerun must not create a new row version.
      setWhere: sql`${users.status} = 'active' and ${users.email} is distinct from coalesce(${email ?? null}, ${users.email})`,
    })
    .returning({ id: users.id });
  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.issuer, issuer), eq(users.subject, subject)))
    .limit(1);
  if (!existing) throw new Error('user upsert returned no row');
  return existing.id;
}

export type BindingResolution =
  | {
      status: 'ok';
      tenantId: string;
      role: MembershipRole;
      founderOnly: boolean;
    }
  | { status: 'unaffiliated' }
  | { status: 'suspended'; tenantId: string }
  | { status: 'deleting'; tenantId: string }
  | { status: 'removed'; tenantId: string }
  | { status: 'directory_unverified'; tenantId: string }
  | { status: 'directory_required'; tenantId: string };

/**
 * Resolves one tenant binding and performs guarded just-in-time membership creation.
 *
 * @param db - Control-plane application connection used for binding and membership work.
 * @param args - Verified provider, claim, user, and optional invitation email.
 */
export async function resolveTenantByBinding(
  db: Db,
  args: {
    providerId: string;
    claimValue: string | null;
    userId: string;
    invitationEmail?: string;
  },
): Promise<BindingResolution> {
  return db.transaction(async (tx) => {
    const claimMatch =
      args.claimValue === null
        ? isNull(tenantIdentityBindings.claimValue)
        : eq(tenantIdentityBindings.claimValue, args.claimValue);
    const bound = await tx
      .select({
        tenantId: tenantIdentityBindings.tenantId,
        tenantStatus: tenants.status,
        requireDirectory: tenants.requireDirectory,
        providerScope: identityProviders.scope,
      })
      .from(tenantIdentityBindings)
      .innerJoin(tenants, eq(tenants.id, tenantIdentityBindings.tenantId))
      .innerJoin(identityProviders, eq(identityProviders.id, tenantIdentityBindings.providerId))
      .where(and(eq(tenantIdentityBindings.providerId, args.providerId), claimMatch))
      .limit(1);
    const binding = bound[0];
    if (!binding) return { status: 'unaffiliated' };
    if (binding.tenantStatus === 'suspended') {
      return { status: 'suspended', tenantId: binding.tenantId };
    }
    if (binding.tenantStatus === 'deleting') {
      return { status: 'deleting', tenantId: binding.tenantId };
    }
    if (binding.requireDirectory && binding.providerScope === 'installation') {
      return { status: 'directory_required', tenantId: binding.tenantId };
    }

    await lockOwnershipWorkspaces(tx, [binding.tenantId]);
    const [workspace] = await tx
      .select({ status: tenants.status, requireDirectory: tenants.requireDirectory })
      .from(tenants)
      .where(eq(tenants.id, binding.tenantId));
    if (!workspace) return { status: 'unaffiliated' };
    if (workspace.status !== 'active')
      return { status: workspace.status, tenantId: binding.tenantId };
    if (workspace.requireDirectory && binding.providerScope === 'installation')
      return { status: 'directory_required', tenantId: binding.tenantId };
    const lockedUsers = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, args.userId))
      .limit(1)
      .for('no key update');
    if (!lockedUsers[0]) throw new Error('tenant binding user disappeared');
    if (lockedUsers[0].status !== 'active') return { status: 'unaffiliated' };

    const membershipRows = await tx
      .select({ role: memberships.role, status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.userId, args.userId), eq(memberships.tenantId, binding.tenantId)))
      .limit(1)
      .for('update');
    const membership = membershipRows[0];
    if (membership?.status === 'removed') {
      return { status: 'removed', tenantId: binding.tenantId };
    }

    let founderOnly = false;
    if (!membership && binding.providerScope === 'tenant') {
      const verifiedDomains = await tx
        .select({ id: identityProviderDomains.id })
        .from(identityProviderDomains)
        .where(
          and(
            eq(identityProviderDomains.providerId, args.providerId),
            eq(identityProviderDomains.status, 'verified'),
          ),
        )
        .limit(1);
      if (verifiedDomains.length === 0) {
        const founder = await tx
          .select({ id: workspaceFoundings.id })
          .from(workspaceFoundings)
          .where(
            and(
              eq(workspaceFoundings.providerId, args.providerId),
              eq(workspaceFoundings.tenantId, binding.tenantId),
              eq(workspaceFoundings.founderUserId, args.userId),
            ),
          )
          .limit(1);
        if (founder.length === 0) {
          return { status: 'directory_unverified', tenantId: binding.tenantId };
        }
        founderOnly = true;
      }
    }

    let role: MembershipRole = founderOnly ? 'owner' : (membership?.role ?? 'member');
    let invitationId: string | undefined;
    if (!founderOnly && args.invitationEmail) {
      const invitations = await tx
        .select({ id: tenantInvitations.id, role: tenantInvitations.role })
        .from(tenantInvitations)
        .where(
          and(
            eq(tenantInvitations.tenantId, binding.tenantId),
            sql`lower(${tenantInvitations.email}) = lower(${args.invitationEmail})`,
            eq(tenantInvitations.status, 'pending'),
            gt(tenantInvitations.expiresAt, new Date()),
          ),
        )
        .limit(2)
        .for('update');
      if (invitations.length === 1) {
        const invitation = invitations[0]!;
        invitationId = invitation.id;
        if (invitation.role === 'admin' && role === 'member') role = 'admin';
      }
    }

    if (membership) {
      if (membership.role !== role) {
        await tx
          .update(memberships)
          .set({ role })
          .where(
            and(
              eq(memberships.userId, args.userId),
              eq(memberships.tenantId, binding.tenantId),
              eq(memberships.status, 'active'),
            ),
          );
      }
    } else {
      await tx
        .insert(memberships)
        .values({ userId: args.userId, tenantId: binding.tenantId, role })
        .onConflictDoNothing({ target: [memberships.userId, memberships.tenantId] });
    }
    const stored = await tx
      .select({ role: memberships.role, status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.userId, args.userId), eq(memberships.tenantId, binding.tenantId)))
      .limit(1);
    if (!stored[0]) throw new Error('membership insert returned no row');
    if (stored[0].status === 'removed') {
      return { status: 'removed', tenantId: binding.tenantId };
    }
    if (invitationId) {
      await tx
        .update(tenantInvitations)
        .set({ status: 'accepted' })
        .where(
          and(eq(tenantInvitations.id, invitationId), eq(tenantInvitations.status, 'pending')),
        );
    }
    return {
      status: 'ok',
      tenantId: binding.tenantId,
      role: stored[0].role,
      founderOnly,
    };
  });
}

/**
 * Accepts one matching administrator invitation and grants access in one owner transaction.
 *
 * @param db - Administrator connection that owns the protected allowlist write.
 * @param identity - Verified issuer, email, and canonical user id.
 */
export async function acceptPlatformAdminInvitation(
  db: Db,
  identity: { issuer: string; email: string; userId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: platformAdminInvitations.id })
      .from(platformAdminInvitations)
      .where(
        and(
          eq(platformAdminInvitations.issuer, identity.issuer),
          sql`lower(${platformAdminInvitations.email}) = lower(${identity.email})`,
          isNull(platformAdminInvitations.acceptedAt),
        ),
      )
      .limit(1)
      .for('update');
    const invitation = rows[0];
    if (!invitation) return false;
    await tx.insert(platformOperators).values({ userId: identity.userId }).onConflictDoNothing();
    await tx
      .update(platformAdminInvitations)
      .set({ acceptedAt: new Date(), acceptedUserId: identity.userId })
      .where(
        and(
          eq(platformAdminInvitations.id, invitation.id),
          isNull(platformAdminInvitations.acceptedAt),
        ),
      );
    return true;
  });
}

/**
 * Revokes credentials issued before the current instant.
 *
 * @param db - Control-plane application connection used for the durable revocation.
 * @param userId - Canonical user whose prior tokens are invalidated.
 * @param issuedAt - Authenticated token issue time in Unix seconds.
 */
export async function setUserNotBefore(db: Db, userId: string, issuedAt: number): Promise<Date> {
  const rows = await db
    .update(users)
    .set({
      notBefore: sql`greatest(
        coalesce(${users.notBefore}, '-infinity'::timestamptz),
        clock_timestamp(),
        to_timestamp(${issuedAt + 1})
      )`,
    })
    .where(eq(users.id, userId))
    .returning({ notBefore: users.notBefore });
  if (!rows[0]?.notBefore) throw new Error('user revocation returned no row');
  return rows[0].notBefore;
}

/**
 * Whether the canonical platform user is in the system-scoped operator allowlist.
 *
 * @param db - Database connection used for the operation.
 * @param userId - Platform user targeted by the operation.
 */
export async function isPlatformOperator(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: platformOperators.userId })
    .from(platformOperators)
    .where(eq(platformOperators.userId, userId))
    .limit(1);
  return rows.length === 1;
}

/**
 * Grant system-wide operator access, returning false when the user was already listed. Call only
 * with an administrator connection.
 *
 * @param db - Database connection used for the operation.
 * @param userId - Platform user targeted by the operation.
 */
export async function grantPlatformOperator(db: Db, userId: string): Promise<boolean> {
  const granted = await db
    .insert(platformOperators)
    .values({ userId })
    .onConflictDoNothing()
    // ON CONFLICT DO NOTHING returns no row when it conflicted, which is the idempotence signal.
    .returning({ userId: platformOperators.userId });
  return granted.length === 1;
}

/**
 * Creates a pending platform-administrator invitation without duplicating an existing invitation.
 *
 * @param db - Administrator database connection used for the operation.
 * @param invitation - Provider issuer and email identifying the invited administrator.
 */
export async function insertAdminInvitation(
  db: Db,
  invitation: { issuer: string; email: string },
): Promise<boolean> {
  const inserted = await db
    .insert(platformAdminInvitations)
    .values({ ...invitation, email: invitation.email.toLowerCase() })
    .onConflictDoNothing({
      target: [platformAdminInvitations.issuer, platformAdminInvitations.email],
    })
    .returning({ id: platformAdminInvitations.id });
  return inserted.length === 1;
}

/**
 * Resolves user by email.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param email - Normalized email used for identity lookup.
 */
export async function resolveUserByEmail(
  db: Db,
  tenantId: string,
  email: string | null | undefined,
): Promise<string | null> {
  const normalized = email?.trim();
  if (!normalized) return null;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(
      and(eq(memberships.tenantId, tenantId), sql`lower(${users.email}) = lower(${normalized})`),
    )
    .limit(2); // 2 is enough to detect ambiguity without scanning the whole set
  return rows.length === 1 ? rows[0]!.id : null;
}

/**
 * Returns user email by id.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param userId - Platform user targeted by the operation.
 */
export async function getUserEmailById(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(eq(memberships.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  return rows[0]?.email ?? null;
}

/**
 * Attach an identity to a tenant idempotently; `created` is false when already present, so a caller
 * reports only what changed. Administrator connections only, never a request path.
 *
 * @param db - Database connection used for the operation.
 * @param identity - Validated identity used by the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param role - Role for a first attach; omitted takes the column default and the idempotent
 *   insert ignores it on a re-attach.
 */
export async function attachMembership(
  db: Db,
  identity: Identity,
  tenantId: string,
  role?: MembershipRole,
): Promise<{ userId: string; created: boolean }> {
  const userId = await upsertIdentity(db, identity);
  return db.transaction(async (tx) => {
    await lockOwnershipWorkspaces(tx, [tenantId]);
    const [user] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .for('no key update');
    if (user?.status !== 'active') throw new Error('cannot attach an inactive account');
    // `memberships` is exempt from RLS and the app role keeps INSERT on it, so nothing in the database
    // stops this from attaching an identity to a tenant it must never reach. Only an administrative or
    // test caller may run it.
    const attached = await tx
      .insert(memberships)
      // The column is omitted rather than defaulted in code, so the schema stays the single place
      // that decides what an unspecified membership role is.
      .values({ userId, tenantId, ...(role ? { role } : {}) })
      .onConflictDoNothing({ target: [memberships.userId, memberships.tenantId] })
      // ON CONFLICT DO NOTHING returns no row when it conflicted, which is the idempotence signal.
      .returning({ userId: memberships.userId });
    return { userId, created: attached.length === 1 };
  });
}
