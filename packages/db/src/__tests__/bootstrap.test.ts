import { registerInactiveBootstrapCases } from './bootstrap-inactive-cases';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { formatBootstrapReport, parseBootstrapInput, runBootstrap } from '../bootstrap';
import { makeDb, type DbHandle } from '../index';
import { INVALID_BOOTSTRAP_CASES } from './bootstrap-invalid-cases';
import { registerBootstrapProviderCases } from './bootstrap-provider-cases';
import {
  ADMIN_URL,
  bootstrapRowVersions,
  bootstrapEnv,
  cleanupBootstrapFixtures,
  discovery,
  fixture,
  grantedUserId,
  markerCounts,
  rejectionMessage,
  runBootstrapCli,
  type BootstrapFixture,
  type Discovery,
} from './bootstrap-test-support';
import { markerTenantState, runBootstrapRejectingTenantWrites } from './bootstrap-write-guard';

const BOOTSTRAP_LOCK_KEY = 'sre:bootstrap';

let admin: DbHandle;
let releaseProviderTestLock: (() => Promise<void>) | undefined;

beforeAll(() => {
  admin = makeDb(ADMIN_URL);
});

beforeEach(async () => {
  const reserved = await admin.sql.reserve();
  await reserved`select pg_advisory_lock(hashtextextended('sre:test:identity-provider', 0))`;
  releaseProviderTestLock = async () => {
    try {
      await reserved`select pg_advisory_unlock(hashtextextended('sre:test:identity-provider', 0))`;
    } finally {
      reserved.release();
    }
  };
});

afterEach(async () => {
  try {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (admin) await cleanupBootstrapFixtures(admin);
  } finally {
    await releaseProviderTestLock?.();
    releaseProviderTestLock = undefined;
  }
});

afterAll(async () => {
  if (!admin) return;
  await admin.close();
});

describe('bootstrap input', () => {
  test('parses and trims the staff provider and both administrator forms', () => {
    const value = fixture('parse');
    const env = {
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
        ...value.provider,
        displayName: `  ${value.provider.displayName}  `,
      }),
      BOOTSTRAP_PLATFORM_ADMINS: JSON.stringify([
        { subject: ` ${value.subjectAdmin.subject} `, email: ` ${value.subjectAdmin.email} ` },
        { email: ` ${value.emailAdmin.email} ` },
      ]),
    };

    expect(parseBootstrapInput(env)).toEqual({
      staffProvider: value.provider,
      admins: [value.subjectAdmin, value.emailAdmin],
    });
  });

  test('accepts internal HTTPS endpoints and a JWKS query string', () => {
    const value = fixture('private-endpoints');
    value.provider.issuer = 'https://oidc.internal:8443/path';
    value.provider.jwksUri = 'https://keys.internal:9443/jwks?version=1';
    expect(parseBootstrapInput(bootstrapEnv(value)).staffProvider).toEqual(value.provider);
  });

  test('permits distinct subject identities to share optional email metadata', () => {
    const value = fixture('shared-subject-email');
    const admins = [
      { subject: `${value.marker}|one`, email: 'shared@example.invalid' },
      { subject: `${value.marker}|two`, email: 'SHARED@example.invalid' },
    ];
    expect(parseBootstrapInput(bootstrapEnv(value, admins)).admins).toEqual(admins);
  });

  test.each([
    {
      admins: [
        { subject: 'subject-one', email: 'shared@example.invalid' },
        { email: 'SHARED@example.invalid' },
      ],
      message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[1]: email conflicts with subject entry 0',
    },
    {
      admins: [
        { email: 'shared@example.invalid' },
        { subject: 'subject-one', email: 'SHARED@example.invalid' },
      ],
      message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[1]: email conflicts with email-only entry 0',
    },
  ])('rejects cross-form email collisions in input order', ({ admins, message }) => {
    expect(() => parseBootstrapInput(bootstrapEnv(fixture('cross-form'), admins))).toThrow(
      new Error(message),
    );
  });

  test('rejects case-insensitive duplicate email-only invitations', () => {
    const value = fixture('invitation-case-duplicate');
    expect(() =>
      parseBootstrapInput(
        bootstrapEnv(value, [
          { email: 'Operator@example.invalid' },
          { email: 'operator@example.invalid' },
        ]),
      ),
    ).toThrow(new Error('Invalid BOOTSTRAP_PLATFORM_ADMINS[1]: duplicate email, same as entry 0'));
  });

  test.each(INVALID_BOOTSTRAP_CASES)(
    'rejects $name with its exact variable/index',
    ({ env, message }) => {
      const value = fixture(`invalid-${message}`.replaceAll(/[^a-z]+/gi, '-'));
      expect(() => parseBootstrapInput(env(value))).toThrow(new Error(message));
    },
  );

  test('rejects invalid input before database or discovery I/O', async () => {
    const value = fixture('parse-before-io');
    const fetchDiscovery = vi.fn<Discovery>();
    const saved = process.env.DATABASE_URL;
    let message: string;
    try {
      delete process.env.DATABASE_URL;
      message = await rejectionMessage(
        runBootstrap(
          bootstrapEnv(value, [{ ...value.emailAdmin, unexpected: true }]),
          fetchDiscovery,
        ),
      );
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
    expect(message).toBe('Invalid BOOTSTRAP_PLATFORM_ADMINS[0]: unexpected key "unexpected"');
    expect(fetchDiscovery).not.toHaveBeenCalled();
  });
});

describe('runBootstrap', () => {
  test('seeds one staff provider, grants or invites admins, and creates no tenant membership', async () => {
    const value = fixture('fresh');
    const before = await markerTenantState(admin, value.marker);

    const report = await runBootstrapRejectingTenantWrites(
      admin,
      ADMIN_URL,
      bootstrapEnv(value),
      discovery(value),
    );

    expect(report.provider).toEqual({
      id: expect.any(String),
      issuer: value.provider.issuer,
      created: true,
    });
    expect(report.admins).toEqual([
      {
        kind: 'granted',
        subject: value.subjectAdmin.subject,
        userId: expect.any(String),
        operator: 'granted',
      },
      {
        kind: 'invited',
        email: value.emailAdmin.email,
        invitation: 'created',
      },
    ]);
    expect(await markerTenantState(admin, value.marker)).toEqual(before);
    expect(await markerCounts(admin, value.marker)).toEqual({
      providers: 1,
      users: 1,
      operators: 1,
      invitations: 1,
      memberships: 0,
    });
    expect(
      await admin.sql`
        select display_name, issuer, jwks_uri, browser_client_id, audience, kind, scope,
               supports_signup, email_claim, tenant_claim, status
        from identity_providers where issuer = ${value.provider.issuer}
      `,
    ).toEqual([
      {
        display_name: value.provider.displayName,
        issuer: value.provider.issuer,
        jwks_uri: value.provider.jwksUri,
        browser_client_id: value.provider.browserClientId,
        audience: value.provider.audience,
        kind: 'oidc',
        scope: 'installation',
        supports_signup: false,
        email_claim: value.provider.emailClaim,
        tenant_claim: null,
        status: 'active',
      },
    ]);
  });

  test('discovers jwks_uri only while inserting a provider', async () => {
    const value = fixture('discovery', false);
    const jwksUri = `https://${value.marker}.internal/jwks?version=1`;
    const fetchDiscovery = vi.fn(async () => ({
      issuer: value.provider.issuer,
      jwks_uri: jwksUri,
      authorization_endpoint: `https://${value.marker}.internal/authorize`,
      token_endpoint: `https://${value.marker}.internal/token`,
    }));

    await runBootstrap(bootstrapEnv(value, [value.emailAdmin]), fetchDiscovery);

    expect(fetchDiscovery).toHaveBeenCalledOnce();
    expect(fetchDiscovery).toHaveBeenCalledWith(value.provider.issuer);
    expect(
      (
        await admin.sql`select jwks_uri from identity_providers where issuer = ${value.provider.issuer}`
      )[0]?.jwks_uri,
    ).toBe(jwksUri);
  });

  test.each([
    {
      label: 'issuer mismatch',
      document: (value: BootstrapFixture) => ({
        issuer: `${value.provider.issuer}other`,
        jwks_uri: `https://${value.marker}.example.invalid/jwks`,
      }),
      message: 'does not match BOOTSTRAP_STAFF_PROVIDER.issuer',
    },
    {
      label: 'blank jwks_uri',
      document: (value: BootstrapFixture) => ({ issuer: value.provider.issuer, jwks_uri: ' ' }),
      message: 'jwks_uri must be a non-empty HTTPS URL',
    },
    {
      label: 'non-HTTPS jwks_uri',
      document: (value: BootstrapFixture) => ({
        issuer: value.provider.issuer,
        jwks_uri: `http://${value.marker}.example.invalid/jwks`,
      }),
      message: 'jwks_uri must be a non-empty HTTPS URL',
    },
    {
      label: 'credentialed jwks_uri',
      document: (value: BootstrapFixture) => ({
        issuer: value.provider.issuer,
        jwks_uri: `https://user:password@${value.marker}.example.invalid/jwks`,
      }),
      message: 'jwks_uri must be a non-empty HTTPS URL',
    },
    {
      label: 'fragmented jwks_uri',
      document: (value: BootstrapFixture) => ({
        issuer: value.provider.issuer,
        jwks_uri: `https://${value.marker}.example.invalid/jwks#fragment`,
      }),
      message: 'jwks_uri must be a non-empty HTTPS URL',
    },
    {
      label: 'non-HTTPS authorization_endpoint',
      document: (value: BootstrapFixture) => ({
        issuer: value.provider.issuer,
        jwks_uri: `https://${value.marker}.example.invalid/jwks`,
        authorization_endpoint: `http://${value.marker}.example.invalid/authorize`,
        token_endpoint: `https://${value.marker}.example.invalid/token`,
      }),
      message: 'authorization_endpoint must be a non-empty HTTPS URL',
    },
    {
      label: 'credentialed token_endpoint',
      document: (value: BootstrapFixture) => ({
        issuer: value.provider.issuer,
        jwks_uri: `https://${value.marker}.example.invalid/jwks`,
        authorization_endpoint: `https://${value.marker}.example.invalid/authorize`,
        token_endpoint: `https://user:password@${value.marker}.example.invalid/token`,
      }),
      message: 'token_endpoint must be a non-empty HTTPS URL',
    },
  ])('rejects a discovery document with $label', async ({ label, document, message }) => {
    const value = fixture(`discovery-${label.replaceAll(' ', '-')}`, false);
    const error = await rejectionMessage(
      runBootstrap(bootstrapEnv(value, [value.emailAdmin]), async () => document(value)),
    );
    expect(error).toContain(message);
    expect(await markerCounts(admin, value.marker)).toEqual({
      providers: 0,
      users: 0,
      operators: 0,
      invitations: 0,
      memberships: 0,
    });
  });

  test('stores nothing when guarded discovery fails', async () => {
    const value = fixture('discovery-http-failure', false);
    const discover = vi.fn(async () => {
      throw new Error('guarded discovery unavailable');
    });

    expect(
      await rejectionMessage(runBootstrap(bootstrapEnv(value, [value.emailAdmin]), discover)),
    ).toContain('guarded discovery unavailable');
    expect(discover).toHaveBeenCalledOnce();
    expect(await markerCounts(admin, value.marker)).toEqual({
      providers: 0,
      users: 0,
      operators: 0,
      invitations: 0,
      memberships: 0,
    });
  });

  test.each([
    ['wrong-shaped JSON', []],
    ['missing jwks_uri', { issuer: 'https://ignored.example.invalid/' }],
  ])('rejects guarded discovery with %s', async (label, document) => {
    const value = fixture(`discovery-${String(label).replaceAll(' ', '-')}`, false);
    expect(
      await rejectionMessage(
        runBootstrap(bootstrapEnv(value, [value.emailAdmin]), async () => document),
      ),
    ).toContain('Invalid discovery document');
    expect(await markerCounts(admin, value.marker)).toEqual({
      providers: 0,
      users: 0,
      operators: 0,
      invitations: 0,
      memberships: 0,
    });
  });

  registerBootstrapProviderCases(() => admin);

  test('identical reruns preserve edited provider fields and skip discovery', async () => {
    const value = fixture('rerun-preserves');
    const first = await runBootstrap(bootstrapEnv(value), discovery(value));
    await admin.sql`
      update identity_providers
      set display_name = 'Edited staff', browser_client_id = 'edited-client',
          audience = 'edited-audience', email_claim = 'edited-email',
          jwks_uri = 'https://edited.example.invalid/jwks'
      where id = ${first.provider.id}
    `;
    const mustNotFetch = vi.fn<Discovery>(async () => {
      throw new Error('discovery must not run');
    });
    const withoutJwks = { ...value, provider: { ...value.provider, jwksUri: undefined } };

    const repeat = await runBootstrap(bootstrapEnv(withoutJwks), mustNotFetch);

    expect(mustNotFetch).not.toHaveBeenCalled();
    expect(repeat).toEqual({
      provider: { id: first.provider.id, issuer: value.provider.issuer, created: false },
      admins: [
        {
          kind: 'granted',
          subject: value.subjectAdmin.subject,
          userId: grantedUserId(first),
          operator: 'already granted',
        },
        {
          kind: 'invited',
          email: value.emailAdmin.email,
          invitation: 'already present',
        },
      ],
    });
    expect(
      await admin.sql`
        select display_name, browser_client_id, audience, email_claim, jwks_uri
        from identity_providers where id = ${first.provider.id}
      `,
    ).toEqual([
      {
        display_name: 'Edited staff',
        browser_client_id: 'edited-client',
        audience: 'edited-audience',
        email_claim: 'edited-email',
        jwks_uri: 'https://edited.example.invalid/jwks',
      },
    ]);
    expect(await markerCounts(admin, value.marker)).toEqual({
      providers: 1,
      users: 1,
      operators: 1,
      invitations: 1,
      memberships: 0,
    });
  });

  test('reports identical sequential input as already present without new writes', async () => {
    const value = fixture('idempotent');
    const input = bootstrapEnv(value);
    const first = await runBootstrap(input, discovery(value));
    const counts = await markerCounts(admin, value.marker);
    const versions = await bootstrapRowVersions(admin, value.marker);
    expect(versions.map((row) => row.entity)).toEqual([
      'invitation',
      'operator',
      'provider',
      'user',
    ]);

    const repeat = await runBootstrap(input, discovery(value));

    expect(repeat).toEqual({
      provider: { id: first.provider.id, issuer: value.provider.issuer, created: false },
      admins: [
        {
          kind: 'granted',
          subject: value.subjectAdmin.subject,
          userId: grantedUserId(first),
          operator: 'already granted',
        },
        {
          kind: 'invited',
          email: value.emailAdmin.email,
          invitation: 'already present',
        },
      ],
    });
    expect(await markerCounts(admin, value.marker)).toEqual(counts);
    expect(await bootstrapRowVersions(admin, value.marker)).toEqual(versions);
  });

  test('serializes two identical runs and inserts each durable row once', async () => {
    const value = fixture('race', false);
    const fetchDiscovery = discovery(value);

    const reports = await Promise.all([
      runBootstrap(bootstrapEnv(value), fetchDiscovery),
      runBootstrap(bootstrapEnv(value), fetchDiscovery),
    ]);

    expect(fetchDiscovery).toHaveBeenCalledOnce();
    expect(reports.map((report) => report.provider.created).sort()).toEqual([false, true]);
    expect(await markerCounts(admin, value.marker)).toEqual({
      providers: 1,
      users: 1,
      operators: 1,
      invitations: 1,
      memberships: 0,
    });
  });

  test('waits for the advisory lock before discovery or writes', async () => {
    const value = fixture('lock-wait', false);
    const fetchDiscovery = discovery(value);
    const holder = await admin.sql.reserve();
    let locked = false;
    let pending: Promise<Awaited<ReturnType<typeof runBootstrap>>> | undefined;
    try {
      const [session] = await holder<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
      if (!session) throw new Error('lock-holder session has no backend pid');
      await holder`select pg_advisory_lock(hashtextextended(${BOOTSTRAP_LOCK_KEY}, 0))`;
      locked = true;
      pending = runBootstrap(bootstrapEnv(value, [value.emailAdmin]), fetchDiscovery);
      await vi.waitFor(async () => {
        const [state] = await admin.sql<Array<{ waiters: number }>>`
          select count(*)::int as waiters
          from pg_catalog.pg_locks held
          join pg_catalog.pg_locks waiting
            on waiting.locktype = held.locktype
           and waiting.database is not distinct from held.database
           and waiting.classid is not distinct from held.classid
           and waiting.objid is not distinct from held.objid
           and waiting.objsubid is not distinct from held.objsubid
          where held.pid = ${session.pid}
            and held.locktype = 'advisory'
            and held.granted
            and not waiting.granted
        `;
        expect(state?.waiters).toBe(1);
      });
      expect(fetchDiscovery).not.toHaveBeenCalled();
      await holder`select pg_advisory_unlock(hashtextextended(${BOOTSTRAP_LOCK_KEY}, 0))`;
      locked = false;
      await expect(pending).resolves.toMatchObject({ provider: { created: true } });
      expect(fetchDiscovery).toHaveBeenCalledOnce();
    } finally {
      if (locked) {
        await holder`select pg_advisory_unlock(hashtextextended(${BOOTSTRAP_LOCK_KEY}, 0))`;
      }
      holder.release();
      await pending?.catch(() => undefined);
    }
  });

  test('releases the advisory lock after discovery failure', async () => {
    const value = fixture('lock-cleanup', false);
    await expect(
      runBootstrap(bootstrapEnv(value, [value.emailAdmin]), async () => {
        throw new Error('discovery unavailable');
      }),
    ).rejects.toThrow('discovery unavailable');

    const reserved = await admin.sql.reserve();
    try {
      const [lock] = await reserved<{ acquired: boolean }[]>`
        select pg_try_advisory_lock(hashtextextended(${BOOTSTRAP_LOCK_KEY}, 0)) as acquired
      `;
      expect(lock?.acquired).toBe(true);
      await reserved`select pg_advisory_unlock(hashtextextended(${BOOTSTRAP_LOCK_KEY}, 0))`;
    } finally {
      reserved.release();
    }
  });

  test('formats one exact secret-free line per provider and administrator in input order', () => {
    const report = {
      provider: {
        id: '10000000-0000-4000-8000-000000000001',
        issuer: 'https://staff.example.invalid/',
        created: true,
      },
      admins: [
        {
          kind: 'granted' as const,
          subject: 'staff|operator',
          userId: '20000000-0000-4000-8000-000000000001',
          operator: 'granted' as const,
        },
        {
          kind: 'invited' as const,
          email: 'invited@example.invalid',
          invitation: 'created' as const,
        },
      ],
    };
    const output = formatBootstrapReport(report);
    expect(output).toBe(
      [
        'Staff provider https://staff.example.invalid/ (10000000-0000-4000-8000-000000000001): created',
        'Platform administrator staff|operator (20000000-0000-4000-8000-000000000001): granted',
        'Platform administrator invited@example.invalid: invitation created',
      ].join('\n'),
    );
    expect(output).not.toMatch(/client|audience|jwks|claim/i);
  });
});

describe('db:bootstrap CLI', () => {
  test('prints the new ordered report and exits zero', async () => {
    const value = fixture('cli-success');
    await runBootstrap(bootstrapEnv(value), discovery(value));
    const result = await runBootstrapCli(bootstrapEnv(value) as Record<string, string>);

    expect(result, result.stderr || result.stdout).toMatchObject({ exitCode: 0 });
    expect(result.stdout.trim().split('\n')).toEqual([
      expect.stringMatching(/^Staff provider .+: already present$/),
      expect.stringMatching(/^Platform administrator .+: already granted$/),
      `Platform administrator ${value.emailAdmin.email}: invitation already present`,
    ]);
    expect(await markerCounts(admin, value.marker)).toEqual({
      providers: 1,
      users: 1,
      operators: 1,
      invitations: 1,
      memberships: 0,
    });
  }, 30_000);

  test('exits non-zero and names the new offending variable', async () => {
    const value = fixture('cli-invalid');
    const result = await runBootstrapCli({
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify(value.provider),
      BOOTSTRAP_PLATFORM_ADMINS: 'not json',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('BOOTSTRAP_PLATFORM_ADMINS');
    expect(await markerCounts(admin, value.marker)).toEqual({
      providers: 0,
      users: 0,
      operators: 0,
      invitations: 0,
      memberships: 0,
    });
  }, 30_000);
});
registerInactiveBootstrapCases(() => admin);
