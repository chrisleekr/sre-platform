import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  expireWorkspaceFoundings,
  identityProviderDomains,
  identityProviders,
  issueDomainChallengeTx,
  jobs,
  makeDb,
  tenants,
  verifyDomainProof,
  workspaceFoundings,
  type DbHandle,
} from '../index';

const marker = randomUUID();
const tenantId = randomUUID();
const providerId = randomUUID();
const domain = `${marker}.example.test`;
const issuer = `https://directory-${marker}.example.test`;
let db: DbHandle;
let domainId: string;
const expiredProviderIds = new Set<string>();

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  await db.db
    .insert(tenants)
    .values({ id: tenantId, name: `Domain ${marker}`, slug: `domain-${marker}` });
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: `Domain ${marker}`,
    issuer,
    jwksUri: `${issuer}/jwks`,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    audience: 'https://api.sre.example',
    browserClientId: `browser-${marker}`,
    kind: 'oidc',
    scope: 'tenant',
    status: 'pending_verification',
  });
});

afterAll(async () => {
  if (!db) return;
  await db.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
  if (expiredProviderIds.size > 0) {
    await db.db.delete(jobs).where(inArray(jobs.idempotencyKey, [...expiredProviderIds]));
  }
  await db.db.delete(workspaceFoundings).where(eq(workspaceFoundings.declaredDomain, domain));
  await db.db
    .delete(identityProviders)
    .where(inArray(identityProviders.id, [providerId, ...expiredProviderIds]));
  await db.db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.close();
});

describe('directory domain proof', () => {
  test('keeps independent verification jobs for multiple domains on the same directory', async () => {
    const first = await db.db.transaction((tx) =>
      issueDomainChallengeTx(tx, {
        providerId,
        tenantId,
        domain: `first-${marker}.example.test`,
      }),
    );
    const second = await db.db.transaction((tx) =>
      issueDomainChallengeTx(tx, {
        providerId,
        tenantId,
        domain: `second-${marker}.example.test`,
      }),
    );
    const jobScope = sql`${jobs.payload}->>'domainId' in (${first.id}, ${second.id})`;
    try {
      expect(await db.db.select().from(jobs).where(jobScope)).toHaveLength(2);
      expect(await verifyDomainProof(db.db, first.id, async () => [[first.challenge]])).toEqual({
        status: 'verified',
      });
      expect(
        await db.db
          .select({ status: jobs.status })
          .from(jobs)
          .where(sql`${jobs.payload}->>'domainId' = ${second.id}`),
      ).toEqual([{ status: 'queued' }]);
      expect(await verifyDomainProof(db.db, second.id, async () => [[second.challenge]])).toEqual({
        status: 'verified',
      });
    } finally {
      await db.db.delete(jobs).where(jobScope);
      await db.db
        .delete(identityProviderDomains)
        .where(inArray(identityProviderDomains.id, [first.id, second.id]));
      await db.db
        .update(identityProviders)
        .set({ status: 'pending_verification' })
        .where(eq(identityProviders.id, providerId));
    }
  });
  test('issues one random seven-day challenge and one durable check due in five minutes', async () => {
    const before = Date.now();
    const issued = await db.db.transaction((tx) =>
      issueDomainChallengeTx(tx, { providerId, tenantId, domain }),
    );
    domainId = issued.id;

    expect(issued.challenge).toMatch(/^sre-platform-verify=[a-f0-9]{32,64}$/);
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000 - 1_000);
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000 + 1_000);
    expect(
      await db.db
        .select({ type: jobs.type, status: jobs.status, availableAt: jobs.availableAt })
        .from(jobs)
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.type, 'domain.verify'))),
    ).toEqual([
      {
        type: 'domain.verify',
        status: 'queued',
        availableAt: expect.any(Date),
      },
    ]);
    const job = await db.db
      .select({ availableAt: jobs.availableAt })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.type, 'domain.verify')))
      .limit(1);
    expect(job[0]!.availableAt.getTime()).toBeGreaterThanOrEqual(before + 299_000);
  });

  test('records an unsuccessful check and coalesces one unexpired successor', async () => {
    await db.db
      .update(jobs)
      .set({ status: 'done' })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.type, 'domain.verify')));

    await Promise.all([
      verifyDomainProof(db.db, domainId, async () => []),
      verifyDomainProof(db.db, domainId, async () => []),
    ]);

    expect(
      await db.db
        .select({
          status: identityProviderDomains.status,
          lastCheckedAt: identityProviderDomains.lastCheckedAt,
        })
        .from(identityProviderDomains)
        .where(eq(identityProviderDomains.id, domainId)),
    ).toEqual([{ status: 'pending', lastCheckedAt: expect.any(Date) }]);
    expect(
      await db.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.tenantId, tenantId),
            eq(jobs.type, 'domain.verify'),
            eq(jobs.status, 'queued'),
          ),
        ),
    ).toHaveLength(1);
  });

  test('excludes the processing command when scheduling its delayed successor', async () => {
    await db.db
      .update(jobs)
      .set({ status: 'done' })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.type, 'domain.verify')));
    const [current] = await db.db
      .insert(jobs)
      .values({
        tenantId,
        type: 'domain.verify',
        payload: { domainId, providerId },
        idempotencyKey: providerId,
        status: 'processing',
        stream: 'sre:founding',
      })
      .returning({ id: jobs.id });

    await verifyDomainProof(db.db, domainId, async () => [], current!.id);

    expect(
      await db.db
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(
          and(
            eq(jobs.tenantId, tenantId),
            eq(jobs.type, 'domain.verify'),
            eq(jobs.status, 'queued'),
          ),
        ),
    ).toEqual([{ id: expect.not.stringMatching(current!.id), status: 'queued' }]);
  });

  test.each(['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ETIMEOUT'])(
    'records %s as pending and retains one retry',
    async (code) => {
      await db.db
        .update(jobs)
        .set({ status: 'done' })
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.type, 'domain.verify')));
      const failure = Object.assign(new Error('DNS unavailable'), { code });

      await expect(
        verifyDomainProof(db.db, domainId, async () => Promise.reject(failure)),
      ).resolves.toEqual({ status: 'pending' });
      expect(
        await db.db
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.tenantId, tenantId),
              eq(jobs.type, 'domain.verify'),
              eq(jobs.status, 'queued'),
            ),
          ),
      ).toHaveLength(1);
    },
  );

  test('atomically verifies matching TXT proof and activates its provider', async () => {
    const row = await db.db
      .select({ challenge: identityProviderDomains.challenge })
      .from(identityProviderDomains)
      .where(eq(identityProviderDomains.id, domainId))
      .limit(1);

    await expect(
      verifyDomainProof(db.db, domainId, async (name) => {
        expect(name).toBe(`_sre-platform.${domain}`);
        const challenge = row[0]!.challenge!;
        return [['unrelated'], [challenge.slice(0, 20), challenge.slice(20)]];
      }),
    ).resolves.toMatchObject({ status: 'verified' });
    expect(
      await db.db
        .select({ status: identityProviderDomains.status })
        .from(identityProviderDomains)
        .where(eq(identityProviderDomains.id, domainId)),
    ).toEqual([{ status: 'verified' }]);
    expect(
      await db.db
        .select({ status: identityProviders.status })
        .from(identityProviders)
        .where(eq(identityProviders.id, providerId)),
    ).toEqual([{ status: 'active' }]);
  });

  test('fails a competing domain activation without partially activating its provider', async () => {
    const competingProviderId = randomUUID();
    const competingDomainId = randomUUID();
    const competingIssuer = `https://competing-${marker}.example.test`;
    await db.db.insert(identityProviders).values({
      id: competingProviderId,
      displayName: `Competing ${marker}`,
      issuer: competingIssuer,
      jwksUri: `${competingIssuer}/jwks`,
      audience: `browser-competing-${marker}`,
      browserClientId: `browser-competing-${marker}`,
      kind: 'oidc',
      scope: 'tenant',
      status: 'pending_verification',
    });
    await db.db.insert(identityProviderDomains).values({
      id: competingDomainId,
      providerId: competingProviderId,
      domain: domain.toUpperCase(),
      status: 'pending',
      challenge: 'sre-platform-verify=competing',
      expiresAt: new Date(Date.now() + 60_000),
    });
    try {
      await expect(
        verifyDomainProof(db.db, competingDomainId, async () => [
          ['sre-platform-verify=competing'],
        ]),
      ).resolves.toMatchObject({ status: 'conflict' });
      expect(
        await db.db
          .select({ status: identityProviderDomains.status })
          .from(identityProviderDomains)
          .where(eq(identityProviderDomains.id, competingDomainId)),
      ).not.toEqual([{ status: 'verified' }]);
      expect(
        await db.db
          .select({ status: identityProviders.status })
          .from(identityProviders)
          .where(eq(identityProviders.id, competingProviderId)),
      ).toEqual([{ status: 'pending_verification' }]);
    } finally {
      await db.db.delete(identityProviders).where(eq(identityProviders.id, competingProviderId));
    }
  });

  test('serializes concurrent normalized-domain activation with one complete winner', async () => {
    const raceDomain = `race-${marker}.example.test`;
    const providerIds = [randomUUID(), randomUUID()];
    const domainIds = [randomUUID(), randomUUID()];
    const challenges = ['sre-platform-verify=race-one', 'sre-platform-verify=race-two'];
    for (const [index, id] of providerIds.entries()) {
      const raceIssuer = `https://race-${index}-${marker}.example.test`;
      await db.db.insert(identityProviders).values({
        id,
        displayName: `Race ${index} ${marker}`,
        issuer: raceIssuer,
        jwksUri: `${raceIssuer}/jwks`,
        audience: `race-${index}`,
        kind: 'oidc',
        scope: 'tenant',
        status: 'pending_verification',
      });
      await db.db.insert(identityProviderDomains).values({
        id: domainIds[index]!,
        providerId: id,
        domain: index === 0 ? raceDomain : raceDomain.toUpperCase(),
        status: 'pending',
        challenge: challenges[index],
        expiresAt: new Date(Date.now() + 60_000),
      });
    }
    let arrivals = 0;
    let release!: () => void;
    const bothResolved = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = (challenge: string) => async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothResolved;
      return [[challenge]];
    };
    try {
      const results = await Promise.all([
        verifyDomainProof(db.db, domainIds[0]!, resolver(challenges[0]!)),
        verifyDomainProof(db.db, domainIds[1]!, resolver(challenges[1]!)),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'verified']);
      const domains = await db.db
        .select({ status: identityProviderDomains.status })
        .from(identityProviderDomains)
        .where(inArray(identityProviderDomains.id, domainIds));
      expect(domains.filter((row) => row.status === 'verified')).toHaveLength(1);
      expect(domains.filter((row) => row.status === 'failed')).toHaveLength(1);
      const providers = await db.db
        .select({ status: identityProviders.status })
        .from(identityProviders)
        .where(inArray(identityProviders.id, providerIds));
      expect(providers.filter((row) => row.status === 'active')).toHaveLength(1);
      expect(providers.filter((row) => row.status === 'pending_verification')).toHaveLength(1);
    } finally {
      await db.db.delete(identityProviders).where(inArray(identityProviders.id, providerIds));
    }
  });

  test('expires, detaches, and deletes only an abandoned provisional provider', async () => {
    const expiredProviderId = randomUUID();
    expiredProviderIds.add(expiredProviderId);
    const expiredFoundingId = randomUUID();
    const expiredIssuer = `https://expired-${marker}.example.test`;
    await db.db.insert(identityProviders).values({
      id: expiredProviderId,
      displayName: `Expired ${marker}`,
      issuer: expiredIssuer,
      jwksUri: `${expiredIssuer}/jwks`,
      audience: `browser-expired-${marker}`,
      browserClientId: `browser-expired-${marker}`,
      kind: 'oidc',
      scope: 'tenant',
      status: 'provisional',
      expiresAt: new Date(Date.now() - 1_000),
    });
    await db.db.insert(workspaceFoundings).values({
      id: expiredFoundingId,
      path: 'own_directory',
      slug: `expired-${marker}`,
      requestedName: `Expired ${marker}`,
      providerId: expiredProviderId,
      declaredDomain: domain,
      status: 'awaiting_founder',
      expiresAt: new Date(Date.now() - 1_000),
    });
    await db.db.insert(jobs).values({
      tenantId: '00000000-0000-0000-0000-000000000000',
      type: 'domain.verify',
      payload: { foundingId: expiredFoundingId, providerId: expiredProviderId },
      idempotencyKey: expiredProviderId,
      status: 'queued',
      stream: 'sre:founding',
      availableAt: new Date(Date.now() + 300_000),
    });

    await expect(expireWorkspaceFoundings(db.db)).resolves.toBeGreaterThanOrEqual(1);
    expect(
      await db.db
        .select({ status: workspaceFoundings.status, providerId: workspaceFoundings.providerId })
        .from(workspaceFoundings)
        .where(eq(workspaceFoundings.id, expiredFoundingId)),
    ).toEqual([{ status: 'expired', providerId: null }]);
    expect(
      await db.db
        .select()
        .from(identityProviders)
        .where(eq(identityProviders.id, expiredProviderId)),
    ).toEqual([]);
    expect(
      await db.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.idempotencyKey, expiredProviderId),
            inArray(jobs.status, ['queued', 'processing']),
          ),
        ),
    ).toEqual([]);
  });

  test('expires every non-provisioned workflow still linked to an expired provisional provider', async () => {
    const statuses = [
      'authenticating_founder',
      'founder_authenticated',
      'pending',
      'approved',
      'failed',
    ] as const;
    const foundingIds: string[] = [];
    const providerIds: string[] = [];
    for (const status of statuses) {
      const id = randomUUID();
      const foundingId = randomUUID();
      providerIds.push(id);
      foundingIds.push(foundingId);
      expiredProviderIds.add(id);
      const expiredIssuer = `https://expired-${status}-${marker}.example.test`;
      await db.db.insert(identityProviders).values({
        id,
        displayName: `Expired ${status} ${marker}`,
        issuer: expiredIssuer,
        jwksUri: `${expiredIssuer}/jwks`,
        audience: `expired-${status}`,
        kind: 'oidc',
        scope: 'tenant',
        status: 'provisional',
        expiresAt: new Date(Date.now() - 1_000),
      });
      await db.db.insert(workspaceFoundings).values({
        id: foundingId,
        path: 'own_directory',
        slug: `expired-${status}-${marker}`,
        requestedName: `Expired ${status}`,
        providerId: id,
        declaredDomain: domain,
        status,
        expiresAt: new Date(Date.now() - 1_000),
        ...(status === 'authenticating_founder'
          ? { authAttemptId: randomUUID(), authAttemptStartedAt: new Date(Date.now() - 120_000) }
          : {}),
      });
    }

    await expect(expireWorkspaceFoundings(db.db)).resolves.toBeGreaterThanOrEqual(statuses.length);
    expect(
      await db.db
        .select({ status: workspaceFoundings.status, providerId: workspaceFoundings.providerId })
        .from(workspaceFoundings)
        .where(inArray(workspaceFoundings.id, foundingIds)),
    ).toEqual(
      expect.arrayContaining(statuses.map(() => ({ status: 'expired', providerId: null }))),
    );
    expect(
      await db.db
        .select()
        .from(identityProviders)
        .where(inArray(identityProviders.id, providerIds)),
    ).toEqual([]);
  });

  test('recovers a stale callback claim without deleting its unexpired provider', async () => {
    const staleProviderId = randomUUID();
    const staleFoundingId = randomUUID();
    expiredProviderIds.add(staleProviderId);
    const staleIssuer = `https://stale-auth-${marker}.example.test`;
    await db.db.insert(identityProviders).values({
      id: staleProviderId,
      displayName: `Stale auth ${marker}`,
      issuer: staleIssuer,
      jwksUri: `${staleIssuer}/jwks`,
      tokenEndpoint: `${staleIssuer}/token`,
      audience: `stale-auth-${marker}`,
      browserClientId: `stale-browser-${marker}`,
      kind: 'oidc',
      scope: 'tenant',
      status: 'provisional',
      expiresAt: new Date(Date.now() + 300_000),
    });
    await db.db.insert(workspaceFoundings).values({
      id: staleFoundingId,
      path: 'own_directory',
      slug: `stale-auth-${marker}`,
      requestedName: `Stale auth ${marker}`,
      providerId: staleProviderId,
      declaredDomain: domain,
      status: 'authenticating_founder',
      authAttemptId: randomUUID(),
      authAttemptStartedAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() + 300_000),
    });

    await expireWorkspaceFoundings(db.db);

    expect(
      await db.db
        .select({
          status: workspaceFoundings.status,
          authAttemptId: workspaceFoundings.authAttemptId,
          authAttemptStartedAt: workspaceFoundings.authAttemptStartedAt,
        })
        .from(workspaceFoundings)
        .where(eq(workspaceFoundings.id, staleFoundingId)),
    ).toEqual([{ status: 'awaiting_founder', authAttemptId: null, authAttemptStartedAt: null }]);
    expect(
      await db.db
        .select({ id: identityProviders.id })
        .from(identityProviders)
        .where(eq(identityProviders.id, staleProviderId)),
    ).toEqual([{ id: staleProviderId }]);
  });
});
