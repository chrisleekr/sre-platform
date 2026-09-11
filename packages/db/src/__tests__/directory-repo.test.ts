import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import {
  createDirectoryAccount,
  createBrowserSession,
  deleteDirectoryAccount,
  directoryAccountLinks,
  directoryAccounts,
  identityProviders,
  getBrowserSession,
  makeDb,
  replaceDirectoryAccount,
  upsertUserForSignIn,
  users,
  type DbHandle,
} from '../index';

const marker = randomUUID();
const providerId = randomUUID();
const otherProviderId = randomUUID();
const issuer = `https://directory-gate-${marker}.invalid`;
const hash = createHash('sha256').update(`token-${marker}`).digest('hex');
let db: DbHandle;

function account(
  userName: string,
  externalId: string | null,
  options: { active?: boolean; emails?: string[] } = {},
) {
  return createDirectoryAccount(db.db, providerId, {
    userName,
    externalId,
    active: options.active ?? true,
    name: {},
    emails: (options.emails ?? [userName]).map((value) => ({ value })),
  });
}

function signIn(subject: string, email?: string, emailVerified = false) {
  return upsertUserForSignIn(db.db, {
    providerId,
    issuer,
    subject,
    email,
    emailVerified,
  });
}

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  const credential = {
    scimEnabled: true,
    scimTokenHash: hash,
    scimTokenCreatedAt: new Date(),
    scimTokenExpiresAt: new Date(Date.now() + 86_400_000),
    requireProvisioned: true,
  };
  await db.db.insert(identityProviders).values([
    {
      id: providerId,
      displayName: 'Directory gate provider',
      issuer,
      jwksUri: `${issuer}/jwks`,
      browserClientId: 'directory-gate-client',
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
      ...credential,
    },
    {
      id: otherProviderId,
      displayName: 'Other directory gate provider',
      issuer: `${issuer}/other`,
      jwksUri: `${issuer}/other/jwks`,
      browserClientId: 'other-directory-gate-client',
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
      ...credential,
    },
  ]);
});

beforeEach(async () => {
  await db.db
    .delete(directoryAccounts)
    .where(inArray(directoryAccounts.providerId, [providerId, otherProviderId]));
  await db.db.delete(users).where(eq(users.issuer, issuer));
  await db.db
    .update(identityProviders)
    .set({
      scimIdentityAttribute: 'externalId',
      requireProvisioned: true,
      scimEnabled: true,
      scimTokenHash: hash,
      scimTokenCreatedAt: new Date(),
      scimTokenExpiresAt: new Date(Date.now() + 86_400_000),
    })
    .where(eq(identityProviders.id, providerId));
});

afterAll(async () => {
  if (!db) return;
  await db.db
    .delete(directoryAccounts)
    .where(inArray(directoryAccounts.providerId, [providerId, otherProviderId]));
  await db.db.delete(users).where(eq(users.issuer, issuer));
  await db.db
    .delete(identityProviders)
    .where(inArray(identityProviders.id, [providerId, otherProviderId]));
  await db.close();
});

test('required provisioning refuses an unmatched identity without creating a user', async () => {
  await expect(signIn('missing-person', 'missing@example.test', true)).resolves.toEqual({
    status: 'directory_unverified',
  });
  await expect(
    db.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.issuer, issuer), eq(users.subject, 'missing-person'))),
  ).resolves.toEqual([]);
});

test('optional provisioning preserves just-in-time sign-in for an unmatched identity', async () => {
  await db.db
    .update(identityProviders)
    .set({ requireProvisioned: false })
    .where(eq(identityProviders.id, providerId));

  await expect(signIn('jit-person', 'jit@example.test', true)).resolves.toMatchObject({
    status: 'active',
  });
});

test('the configured subject attribute links exactly once without assuming externalId equals sub', async () => {
  await account('person@example.test', 'directory-object');
  await db.db
    .update(identityProviders)
    .set({ scimIdentityAttribute: 'userName' })
    .where(eq(identityProviders.id, providerId));
  await expect(signIn('directory-object')).resolves.toEqual({ status: 'directory_unverified' });
  const allowed = await signIn('PERSON@example.test');
  expect(allowed.status).toBe('active');
  if (allowed.status !== 'active') throw new Error('expected an active sign-in');
  const links = await db.db
    .select()
    .from(directoryAccountLinks)
    .where(eq(directoryAccountLinks.userId, allowed.userId));
  expect(links).toHaveLength(1);
  await expect(signIn('PERSON@example.test')).resolves.toMatchObject({ userId: allowed.userId });
});

test('verified email bootstraps only one active unlinked account', async () => {
  await account('first@example.test', 'first', { emails: ['shared@example.test'] });
  await account('second@example.test', 'second', { emails: ['shared@example.test'] });
  await expect(signIn('no-subject-match', 'shared@example.test', false)).resolves.toEqual({
    status: 'directory_unverified',
  });
  await expect(signIn('no-subject-match', 'shared@example.test', true)).resolves.toEqual({
    status: 'directory_unverified',
  });
  await account('sole@example.test', 'sole', { emails: ['unique@example.test'] });
  await expect(signIn('other-subject', 'unique@example.test', true)).resolves.toMatchObject({
    status: 'active',
  });
});

test('an inactive established link denies access and never moves to an email replacement', async () => {
  const original = await account('person@example.test', 'original-subject');
  const signedIn = await signIn('original-subject');
  expect(signedIn.status).toBe('active');
  if (signedIn.status !== 'active') throw new Error('expected an active sign-in');
  await replaceDirectoryAccount(db.db, providerId, original.id, {
    externalId: original.externalId,
    userName: original.userName,
    active: false,
    name: original.name,
    emails: original.emails,
  });
  await account('replacement@example.test', 'replacement-subject', {
    emails: ['person@example.test'],
  });
  await db.db
    .update(identityProviders)
    .set({ requireProvisioned: false })
    .where(eq(identityProviders.id, providerId));
  await expect(signIn('original-subject', 'person@example.test', true)).resolves.toEqual({
    status: 'directory_unverified',
  });
  const [link] = await db.db
    .select()
    .from(directoryAccountLinks)
    .where(eq(directoryAccountLinks.userId, signedIn.userId));
  expect(link!.directoryAccountId).toBe(original.id);

  await db.db
    .update(identityProviders)
    .set({
      scimEnabled: false,
      scimTokenHash: null,
      scimTokenCreatedAt: null,
      scimTokenExpiresAt: null,
    })
    .where(eq(identityProviders.id, providerId));
  await expect(signIn('original-subject', 'person@example.test', true)).resolves.toEqual({
    status: 'directory_unverified',
  });
});

test('deactivation invalidates an existing browser session through the durable cutoff', async () => {
  const original = await account('browser@example.test', 'browser-subject');
  const signedIn = await signIn('browser-subject');
  expect(signedIn.status).toBe('active');
  if (signedIn.status !== 'active') throw new Error('expected an active sign-in');
  const created = await createBrowserSession(db.db, {
    providerId,
    clientId: 'directory-gate-client',
    userId: signedIn.userId,
    foundingId: null,
    oidcSubject: 'browser-subject',
    bindingClaimValue: null,
    authenticatedAt: new Date(),
    idleSeconds: 3_600,
    absoluteSeconds: 86_400,
  });
  expect(await getBrowserSession(db.db, created.credential, 3_600)).not.toBeNull();

  await replaceDirectoryAccount(db.db, providerId, original.id, {
    externalId: original.externalId,
    userName: original.userName,
    active: false,
    name: original.name,
    emails: original.emails,
  });

  expect(await getBrowserSession(db.db, created.credential, 3_600)).toBeNull();
});

test('DELETE preserves the ownership link while hiding the tombstone', async () => {
  const original = await account('deleted@example.test', 'deleted-subject');
  const signedIn = await signIn('deleted-subject');
  expect(signedIn.status).toBe('active');
  if (signedIn.status !== 'active') throw new Error('expected an active sign-in');
  await deleteDirectoryAccount(db.db, providerId, original.id);
  const [stored] = await db.db
    .select()
    .from(directoryAccounts)
    .where(eq(directoryAccounts.id, original.id));
  expect(stored!.deletedAt).toBeInstanceOf(Date);
  expect(stored!.active).toBe(false);
  await expect(signIn('deleted-subject', 'deleted@example.test', true)).resolves.toEqual({
    status: 'directory_unverified',
  });
});

test('deactivation and the linked user cutoff roll back together', async () => {
  const original = await account('rollback@example.test', 'rollback-subject');
  const signedIn = await signIn('rollback-subject');
  expect(signedIn.status).toBe('active');
  if (signedIn.status !== 'active') throw new Error('expected an active sign-in');
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `reject_directory_cutoff_${suffix}`;
  const triggerName = `reject_directory_cutoff_trigger_${suffix}`;
  await db.db.execute(
    sql.raw(`
    create function ${functionName}() returns trigger language plpgsql as $$
    begin raise exception 'injected cutoff failure'; end $$;
    create trigger ${triggerName}
      before update of not_before on users
      for each row when (old.id = '${signedIn.userId}'::uuid)
      execute function ${functionName}();
  `),
  );
  try {
    await expect(
      replaceDirectoryAccount(db.db, providerId, original.id, {
        externalId: original.externalId,
        userName: original.userName,
        active: false,
        name: original.name,
        emails: original.emails,
      }),
    ).rejects.toThrow('Failed query');
    const [storedAccount] = await db.db
      .select()
      .from(directoryAccounts)
      .where(eq(directoryAccounts.id, original.id));
    const [storedUser] = await db.db.select().from(users).where(eq(users.id, signedIn.userId));
    expect(storedAccount!.active).toBe(true);
    expect(storedUser!.notBefore).toBeNull();
  } finally {
    await db.db.execute(
      sql.raw(`
      drop trigger if exists ${triggerName} on users;
      drop function if exists ${functionName}();
    `),
    );
  }
});
