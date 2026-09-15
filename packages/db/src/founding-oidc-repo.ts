import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { FoundingStateError, type WorkspaceFounding } from './founding-repo';
import type { Tx } from './rls';
import {
  identityProviders,
  memberships,
  platformSecrets,
  tenants,
  users,
  workspaceFoundings,
} from './schema';

export interface OidcFoundingProvider {
  id: string;
  issuer: string;
  jwksUri: string;
  tokenEndpoint: string;
  browserClientId: string;
  apiAudience: string;
  emailClaim: string;
  subjectClaim: string;
}

export interface OidcFoundingContinuation {
  provider: OidcFoundingProvider;
  declaredDomain: string;
  founderSubject: string;
}

export interface OidcFoundingOwnerRecovery {
  foundingId: string;
  providerId: string;
}

function projectProvider(
  provider: typeof identityProviders.$inferSelect,
): OidcFoundingProvider | null {
  if (!provider.tokenEndpoint || !provider.browserClientId) return null;
  return {
    id: provider.id,
    issuer: provider.issuer,
    jwksUri: provider.jwksUri,
    tokenEndpoint: provider.tokenEndpoint,
    browserClientId: provider.browserClientId,
    apiAudience: provider.audience ?? '',
    emailClaim: provider.emailClaim,
    subjectClaim: provider.subjectClaim,
  };
}

/** Finds an existing workspace after the same OIDC application verifies its founder.
 * @param db - Control-plane database connection.
 * @param input - Verified application, subject, and duplicate setup identifier.
 */
export async function findOidcFoundingOwnerRecovery(
  db: Db,
  input: {
    issuer: string;
    browserClientId: string;
    subjectClaim: string;
    subject: string;
    duplicateFoundingId: string;
  },
): Promise<OidcFoundingOwnerRecovery | null> {
  const [row] = await db
    .select({ foundingId: workspaceFoundings.id, providerId: identityProviders.id })
    .from(workspaceFoundings)
    .innerJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
    .innerJoin(users, eq(users.id, workspaceFoundings.founderUserId))
    .innerJoin(tenants, eq(tenants.id, workspaceFoundings.tenantId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.tenantId, workspaceFoundings.tenantId)),
    )
    .where(
      and(
        eq(identityProviders.issuer, input.issuer),
        eq(identityProviders.browserClientId, input.browserClientId),
        eq(identityProviders.subjectClaim, input.subjectClaim),
        inArray(identityProviders.status, ['active', 'pending_verification']),
        eq(users.issuer, input.issuer),
        eq(users.subject, input.subject),
        eq(workspaceFoundings.status, 'active'),
        eq(tenants.status, 'active'),
        eq(memberships.status, 'active'),
        eq(memberships.role, 'owner'),
        ne(workspaceFoundings.id, input.duplicateFoundingId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Retires an exact duplicate OIDC setup after its replacement session is durable.
 * @param db - Control-plane database connection.
 * @param input - Provisional founding and provider identifiers to retire.
 */
export function retireDuplicateOidcFounding(
  db: Db,
  input: { foundingId: string; providerId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [abandoned] = await tx
      .update(workspaceFoundings)
      .set({
        status: 'expired',
        providerId: null,
        authAttemptId: null,
        authAttemptStartedAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(workspaceFoundings.id, input.foundingId),
          eq(workspaceFoundings.providerId, input.providerId),
          eq(workspaceFoundings.status, 'awaiting_founder'),
        ),
      )
      .returning({ id: workspaceFoundings.id });
    if (!abandoned) return false;
    await tx
      .delete(platformSecrets)
      .where(
        inArray(platformSecrets.name, [
          `setup-editor:${input.foundingId}`,
          `oidc-client:${input.providerId}`,
        ]),
      );
    await tx
      .delete(identityProviders)
      .where(
        and(
          eq(identityProviders.id, input.providerId),
          eq(identityProviders.status, 'provisional'),
        ),
      );
    return true;
  });
}

/**
 * Atomically creates a provisional OIDC provider and its one-hour founding.
 *
 * @param db - Control-plane database connection.
 * @param input - Validated OIDC metadata and requested workspace identity.
 */
export function createOidcWorkspaceFounding(
  db: Db,
  input: {
    slug: string;
    requestedName: string;
    declaredDomain: string;
    clientId: string;
    apiAudience: string | null;
    clientAuthentication?: 'none' | 'client_secret_post' | 'client_secret_basic';
    subjectClaim?: 'sub' | 'oid';
    authorizationScopes?: string[];
    authorizationAudience?: string | null;
    metadata: {
      issuer: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      jwksUri: string;
    };
  },
): Promise<{ founding: WorkspaceFounding; provider: OidcFoundingProvider }> {
  return db.transaction(async (tx) => {
    const [provider] = await tx
      .insert(identityProviders)
      .values({
        displayName: input.requestedName,
        issuer: input.metadata.issuer,
        jwksUri: input.metadata.jwksUri,
        authorizationEndpoint: input.metadata.authorizationEndpoint,
        tokenEndpoint: input.metadata.tokenEndpoint,
        audience: input.apiAudience,
        browserClientId: input.clientId,
        clientAuthentication: input.clientAuthentication ?? 'none',
        subjectClaim: input.subjectClaim ?? 'sub',
        authorizationScopes: input.authorizationScopes ?? [],
        authorizationAudience: input.authorizationAudience || null,
        kind: 'oidc',
        scope: 'tenant',
        status: 'provisional',
        expiresAt: sql`clock_timestamp() + interval '1 hour'`,
      })
      .returning();
    const projected = provider ? projectProvider(provider) : null;
    if (!provider || !projected) throw new Error('provisional provider insert returned no row');
    const [founding] = await tx
      .insert(workspaceFoundings)
      .values({
        path: 'own_directory',
        slug: input.slug,
        requestedName: input.requestedName,
        declaredDomain: input.declaredDomain,
        providerId: provider.id,
        status: 'awaiting_founder',
        expiresAt: provider.expiresAt,
      })
      .returning();
    if (!founding) throw new Error('workspace founding insert returned no row');
    return { founding, provider: projected };
  });
}

/**
 * Loads the exact non-active provider and founder identity allowed to continue one founding session.
 *
 * @param db - Control-plane database connection.
 * @param foundingId - Founding whose authentication session is being continued.
 * @param providerId - Provider recorded in the browser session.
 */
export async function getOidcFoundingContinuation(
  db: Db,
  foundingId: string,
  providerId: string,
): Promise<OidcFoundingContinuation | null> {
  const [row] = await db
    .select({
      founding: workspaceFoundings,
      provider: identityProviders,
      founderSubject: users.subject,
      founderIssuer: users.issuer,
    })
    .from(workspaceFoundings)
    .innerJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
    .innerJoin(users, eq(users.id, workspaceFoundings.founderUserId))
    .where(
      and(
        eq(workspaceFoundings.id, foundingId),
        eq(workspaceFoundings.providerId, providerId),
        inArray(workspaceFoundings.status, [
          'founder_authenticated',
          'pending',
          'approved',
          'provisioning',
          'active',
        ]),
        or(
          and(
            eq(identityProviders.status, 'provisional'),
            gt(identityProviders.expiresAt, sql`clock_timestamp()`),
          ),
          eq(identityProviders.status, 'pending_verification'),
        ),
      ),
    )
    .limit(1);
  const provider = row ? projectProvider(row.provider) : null;
  if (!row || !provider || !row.founding.declaredDomain || row.founderIssuer !== provider.issuer) {
    return null;
  }
  return {
    provider,
    declaredDomain: row.founding.declaredDomain,
    founderSubject: row.founderSubject,
  };
}

async function assertIssuerAvailable(
  tx: Tx,
  provider: OidcFoundingProvider,
  foundingId: string,
): Promise<void> {
  const [active] = await tx
    .select({ id: identityProviders.id })
    .from(identityProviders)
    .where(
      and(
        eq(identityProviders.issuer, provider.issuer),
        eq(identityProviders.browserClientId, provider.browserClientId),
        eq(identityProviders.status, 'active'),
        ne(identityProviders.id, provider.id),
      ),
    )
    .limit(1);
  const [claimed] = await tx
    .select({ id: workspaceFoundings.id })
    .from(workspaceFoundings)
    .innerJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
    .where(
      and(
        eq(identityProviders.issuer, provider.issuer),
        eq(identityProviders.browserClientId, provider.browserClientId),
        ne(workspaceFoundings.id, foundingId),
        inArray(workspaceFoundings.status, [
          'authenticating_founder',
          'founder_authenticated',
          'pending',
          'approved',
          'provisioning',
          'active',
        ]),
      ),
    )
    .limit(1);
  if (active || claimed) {
    throw new FoundingStateError(
      'this directory is already connected to another workspace',
      'directory_already_connected',
    );
  }
}

async function releaseAuthAttempt(db: Db, foundingId: string, attemptId: string): Promise<void> {
  await db
    .update(workspaceFoundings)
    .set({
      status: 'awaiting_founder',
      authAttemptId: null,
      authAttemptStartedAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workspaceFoundings.id, foundingId),
        eq(workspaceFoundings.status, 'authenticating_founder'),
        eq(workspaceFoundings.authAttemptId, attemptId),
        gt(workspaceFoundings.expiresAt, sql`clock_timestamp()`),
      ),
    );
}

/**
 * Claims one callback durably, performs remote verification without a DB lease, then finalizes it.
 *
 * @param db - Control-plane database connection.
 * @param foundingId - Founding whose exact provider must verify the callback.
 * @param providerId - Provisional provider recorded in the browser authorization attempt.
 * @param exchange - Bounded provider exchange and verification operation.
 */
export async function completeOidcFoundingOnce<T>(
  db: Db,
  foundingId: string,
  providerId: string,
  exchange: (input: {
    founding: WorkspaceFounding;
    provider: OidcFoundingProvider;
  }) => Promise<{ identity: { issuer: string; subject: string; email: string }; result: T }>,
): Promise<{ founding: WorkspaceFounding; result: T }> {
  const attemptId = randomUUID();
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ founding: workspaceFoundings, provider: identityProviders })
      .from(workspaceFoundings)
      .innerJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
      .where(
        and(
          eq(workspaceFoundings.id, foundingId),
          eq(workspaceFoundings.providerId, providerId),
          eq(workspaceFoundings.status, 'awaiting_founder'),
          gt(workspaceFoundings.expiresAt, sql`clock_timestamp()`),
          eq(identityProviders.status, 'provisional'),
          gt(identityProviders.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .limit(1)
      .for('update');
    const provider = row ? projectProvider(row.provider) : null;
    if (!row || !provider) {
      throw new FoundingStateError('founding is missing, expired, or already claimed');
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${provider.issuer}, 0))`);
    await assertIssuerAvailable(tx, provider, foundingId);
    const [founding] = await tx
      .update(workspaceFoundings)
      .set({
        status: 'authenticating_founder',
        authAttemptId: attemptId,
        authAttemptStartedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(workspaceFoundings.id, foundingId),
          eq(workspaceFoundings.status, 'awaiting_founder'),
        ),
      )
      .returning();
    if (!founding) throw new FoundingStateError('founding completion lost its claim');
    return { founding, provider };
  });

  let completed: Awaited<ReturnType<typeof exchange>>;
  try {
    completed = await exchange(claimed);
  } catch (error) {
    await releaseAuthAttempt(db, foundingId, attemptId);
    throw error;
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ founding: workspaceFoundings, provider: identityProviders })
        .from(workspaceFoundings)
        .innerJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
        .where(
          and(
            eq(workspaceFoundings.id, foundingId),
            eq(workspaceFoundings.providerId, providerId),
            eq(workspaceFoundings.status, 'authenticating_founder'),
            eq(workspaceFoundings.authAttemptId, attemptId),
            gt(workspaceFoundings.expiresAt, sql`clock_timestamp()`),
            eq(identityProviders.status, 'provisional'),
            gt(identityProviders.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1)
        .for('update');
      const provider = row ? projectProvider(row.provider) : null;
      if (!row || !provider || completed.identity.issuer !== provider.issuer) {
        throw new FoundingStateError('founding completion attempt is no longer valid');
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${provider.issuer}, 0))`);
      await assertIssuerAvailable(tx, provider, foundingId);
      const [founder] = await tx
        .insert(users)
        .values(completed.identity)
        .onConflictDoUpdate({
          target: [users.issuer, users.subject],
          set: { email: completed.identity.email },
          setWhere: eq(users.status, 'active'),
        })
        .returning({ id: users.id });
      if (!founder) throw new FoundingStateError('founder account is not active');
      const [updated] = await tx
        .update(workspaceFoundings)
        .set({
          founderUserId: founder.id,
          status: 'founder_authenticated',
          authAttemptId: null,
          authAttemptStartedAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(workspaceFoundings.id, foundingId),
            eq(workspaceFoundings.status, 'authenticating_founder'),
            eq(workspaceFoundings.authAttemptId, attemptId),
          ),
        )
        .returning();
      if (!updated) throw new FoundingStateError('founding completion lost its state transition');
      return { founding: updated, result: completed.result };
    });
  } catch (error) {
    await releaseAuthAttempt(db, foundingId, attemptId);
    throw error;
  }
}
