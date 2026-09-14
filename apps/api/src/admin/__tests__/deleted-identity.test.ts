import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import {
  completeOidcFoundingOnce,
  createOidcWorkspaceFounding,
  FoundingStateError,
  identityProviders,
  tombstoneAdminUser,
  upsertIdentity,
  upsertUserForSignIn,
  users,
  workspaceFoundings,
} from '@sre/db';
import { ownershipFixture } from './ownership.fixture';

const f = ownershipFixture();
test('a deleted external identity cannot re-register from its still-valid signed token', async () => {
  await tombstoneAdminUser(f.db.db, {
    actorUserId: f.actorId,
    userId: f.memberId,
    reason: 'Remove this identity from the platform',
  });
  const [actor] = await f.db.db
    .select({ issuer: users.issuer })
    .from(users)
    .where(eq(users.id, f.actorId));
  const identity = { issuer: actor!.issuer, subject: 'member', email: 'resupplied@example.test' };
  const attachedId = await upsertIdentity(f.db.db, identity);
  const signIn = await upsertUserForSignIn(f.appDb.db, identity);
  const response = await f.request('/tenant/members', undefined, f.memberToken);
  expect(response.status).toBe(401);
  expect(attachedId).toBe(f.memberId);
  expect(signIn).toMatchObject({ userId: f.memberId, status: 'deleted' });
  const [deleted] = await f.db.db.select().from(users).where(eq(users.id, f.memberId));
  expect(deleted).toMatchObject({ status: 'deleted', email: null });
  expect(await f.db.db.select().from(users).where(eq(users.issuer, actor!.issuer))).toHaveLength(3);
});

test.each(['deleted', 'disabled'] as const)(
  'a different OIDC client cannot authenticate an existing %s identity as a founder',
  async (status) => {
    const [actor] = await f.db.db
      .select({ issuer: users.issuer })
      .from(users)
      .where(eq(users.id, f.actorId));
    const issuer = actor!.issuer;
    await f.db.db.update(users).set({ status, email: null }).where(eq(users.id, f.memberId));
    const setup = await createOidcWorkspaceFounding(f.db.db, {
      slug: `inactive-${crypto.randomUUID()}`,
      requestedName: 'Different client',
      declaredDomain: 'example.test',
      clientId: `different-${crypto.randomUUID()}`,
      apiAudience: 'sre-api',
      metadata: {
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
        jwksUri: `${issuer}/jwks`,
      },
    });
    try {
      await expect(
        completeOidcFoundingOnce(f.db.db, setup.founding.id, setup.provider.id, async () => ({
          identity: { issuer, subject: 'member', email: 'restored@example.test' },
          result: null,
        })),
      ).rejects.toBeInstanceOf(FoundingStateError);
      const [user] = await f.db.db.select().from(users).where(eq(users.id, f.memberId));
      expect(user).toMatchObject({ status, email: null });
      const [founding] = await f.db.db
        .select()
        .from(workspaceFoundings)
        .where(eq(workspaceFoundings.id, setup.founding.id));
      expect(founding).toMatchObject({
        status: 'awaiting_founder',
        founderUserId: null,
        authAttemptId: null,
      });
    } finally {
      await f.db.db.delete(workspaceFoundings).where(eq(workspaceFoundings.id, setup.founding.id));
      await f.db.db.delete(identityProviders).where(eq(identityProviders.id, setup.provider.id));
    }
  },
);
