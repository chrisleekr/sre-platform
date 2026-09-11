import { seedMembership } from '@sre/db/test-support';
import { afterAll, beforeAll, describe, expect, test, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { eq, sql } from 'drizzle-orm';
import {
  makeDb,
  memberships,
  platformOperators,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
  type PlatformSecretStore,
} from '@sre/db';
import type { LlmRuntimeConfig } from '@sre/contracts';
import type { EmailAdapter } from '@sre/notifications';
import type { SmtpSettings } from '@sre/platform-settings';
import type { AuthDeps, AuthVariables } from '../auth';
import { platformSettingsRoutes } from '../platform-settings';
import { makeTestAuth } from './auth-test-support';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const ISSUER = 'https://platform-settings.test/';
const AUDIENCE = 'sre-api';
const KID = 'platform-settings-key';
const KEY = 'CLASSIFY_FAIRNESS_WINDOW_SEC';

interface SettingsPort {
  list: Mock<() => Promise<Array<{ key: typeof KEY; value: number; defaultValue: number }>>>;
  set: Mock<(key: string, value: unknown) => Promise<number>>;
  llmRuntime?: Mock<
    () => Promise<{
      config: LlmRuntimeConfig;
      source: 'stored' | 'environment';
      updatedAt: Date | null;
    }>
  >;
  smtp?: Mock<
    () => Promise<{
      config: SmtpSettings | null;
      source: 'stored' | 'environment';
      updatedAt: Date | null;
    }>
  >;
}

let admin: DbHandle;
let appDb: DbHandle;
let auth: AuthDeps;
let privateKey: CryptoKey;
let tenantId: string;
let operatorId: string;
const operatorSubject = `operator|${randomUUID()}`;
const memberSubject = `member|${randomUUID()}`;

async function sign(subject: string): Promise<string> {
  return new SignJWT({ sub: subject, email: `${subject}@example.test`, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function makeSettingsApi(
  settings: SettingsPort,
  extra: {
    platformSecrets?: PlatformSecretStore;
    controlDb?: DbHandle['db'];
    env?: NodeJS.ProcessEnv;
    validateCustomProviderUrl?: (url: string) => Promise<void>;
    makeEmailAdapter?: (settings: SmtpSettings, password: string | null) => EmailAdapter;
  } = {},
): Promise<Hono<{ Variables: AuthVariables }>> {
  const api = new Hono<{ Variables: AuthVariables }>();
  api.route(
    '/platform-settings',
    platformSettingsRoutes({
      auth,
      operatorDb: appDb.db,
      settings,
      validateCustomProviderUrl: async () => undefined,
      ...extra,
    }),
  );
  return api;
}

function fakeSettings(): SettingsPort {
  return {
    list: vi.fn(async () => [{ key: KEY, value: 3600, defaultValue: 3600 }]),
    set: vi.fn(async (_key: string, value: unknown) => {
      if (!Number.isInteger(value) || Number(value) <= 0) throw new TypeError('invalid setting');
      return Number(value);
    }),
  };
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  appDb = makeDb(APP_URL);
  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Platform settings test' });
  operatorId = await seedMembership(
    admin.db,
    { issuer: ISSUER, subject: operatorSubject },
    tenantId,
  );
  await seedMembership(admin.db, { issuer: ISSUER, subject: memberSubject }, tenantId);
  await admin.db.insert(platformOperators).values({ userId: operatorId });
  auth = await makeTestAuth({
    adminDb: admin.db,
    appDb: appDb.db,
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet),
    bindings: [
      { tenantId, subject: operatorSubject },
      { tenantId, subject: memberSubject },
    ],
  });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(platformOperators).where(eq(platformOperators.userId, operatorId));
    await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
    await admin.db
      .delete(tenantIdentityBindings)
      .where(eq(tenantIdentityBindings.tenantId, tenantId));
    await admin.db
      .delete(users)
      .where(sql`issuer = ${ISSUER} and subject in (${operatorSubject}, ${memberSubject})`);
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (appDb) await appDb.close();
});

describe('platform settings operator API', () => {
  test('authentication runs before operator authorization and settings access', async () => {
    const settings = fakeSettings();
    const api = await makeSettingsApi(settings);

    const response = await api.request('/platform-settings');

    expect(response.status).toBe(401);
    expect(settings.list).not.toHaveBeenCalled();
  });

  test('a tenant member outside the operator allowlist receives exact 403', async () => {
    const settings = fakeSettings();
    const api = await makeSettingsApi(settings);

    const response = await api.request('/platform-settings', {
      headers: { authorization: `Bearer ${await sign(memberSubject)}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(settings.list).not.toHaveBeenCalled();
  });

  test('an operator lists settings and updates a known setting', async () => {
    const settings = fakeSettings();
    const api = await makeSettingsApi(settings);
    const authorization = `Bearer ${await sign(operatorSubject)}`;

    const listResponse = await api.request('/platform-settings', { headers: { authorization } });
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      settings: [{ key: KEY, value: 3600, defaultValue: 3600 }],
    });

    const putResponse = await api.request(`/platform-settings/${KEY}`, {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 7200 }),
    });
    expect(putResponse.status).toBe(200);
    expect(await putResponse.json()).toEqual({ key: KEY, value: 7200 });
    expect(settings.set).toHaveBeenCalledWith(KEY, 7200, {
      actorUserId: expect.any(String),
    });
  });

  test('unknown keys and invalid values are client errors', async () => {
    const settings = fakeSettings();
    settings.set.mockRejectedValue(new TypeError('invalid setting'));
    const api = await makeSettingsApi(settings);
    const authorization = `Bearer ${await sign(operatorSubject)}`;

    for (const [key, value] of [
      ['UNKNOWN', 7200],
      [KEY, 0],
      [KEY, '7200'],
    ] as const) {
      const response = await api.request(`/platform-settings/${key}`, {
        method: 'PUT',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      expect(response.status).toBe(400);
    }
  });

  test.each([
    ['malformed JSON', '{'],
    ['a missing value', '{}'],
  ])('rejects %s with exact 400 before calling the settings store', async (_label, body) => {
    const settings = fakeSettings();
    const api = await makeSettingsApi(settings);
    const response = await api.request(`/platform-settings/${KEY}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await sign(operatorSubject)}`,
        'content-type': 'application/json',
      },
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'value is required' });
    expect(settings.set).not.toHaveBeenCalled();
  });

  test('reads and replaces a validated write-only LLM credential without returning plaintext', async () => {
    const initial: LlmRuntimeConfig = {
      runtime: 'claude-agent-sdk',
      provider: 'anthropic',
      model: 'claude-test',
      baseUrl: null,
      authMode: 'api-key',
      maxTurns: 8,
      pricing: null,
    };
    const stored: LlmRuntimeConfig = {
      ...initial,
      model: 'claude-new',
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 2,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 1.25,
      },
    };
    const settings = fakeSettings();
    settings.llmRuntime = vi
      .fn()
      .mockResolvedValueOnce({ config: initial, source: 'environment', updatedAt: null })
      .mockResolvedValueOnce({ config: stored, source: 'stored', updatedAt: new Date(0) });
    settings.set.mockResolvedValue(stored as never);
    const platformSecrets: PlatformSecretStore = {
      get: vi.fn(async () => null),
      has: vi.fn(async () => false),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const api = await makeSettingsApi(settings, { platformSecrets, env: {} });
    const authorization = `Bearer ${await sign(operatorSubject)}`;

    const getResponse = await api.request('/platform-settings/llm', {
      headers: { authorization },
    });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({
      config: initial,
      source: 'environment',
      credentialConfigured: false,
      updatedAt: null,
    });

    const putResponse = await api.request('/platform-settings/llm', {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ config: stored, credential: 'new-secret-value' }),
    });
    expect(putResponse.status).toBe(200);
    const putBody = await putResponse.json();
    expect(putBody).toEqual({
      config: stored,
      source: 'stored',
      credentialConfigured: true,
      updatedAt: new Date(0).toISOString(),
    });
    expect(platformSecrets.put).toHaveBeenCalledWith(
      'llm:credential:anthropic:api-key',
      'new-secret-value',
    );
    expect(settings.set).toHaveBeenCalledWith('LLM_RUNTIME', stored, {
      actorUserId: expect.any(String),
    });
    expect(JSON.stringify(putBody)).not.toContain('new-secret-value');
  });

  test('reads and replaces write-only SMTP credentials without returning plaintext', async () => {
    const initial: SmtpSettings = {
      host: 'smtp.old.example.test',
      port: 587,
      secure: false,
      from: 'alerts@example.test',
      username: 'old-user',
    };
    const stored: SmtpSettings = {
      ...initial,
      host: 'smtp.example.test',
      username: 'mailer',
    };
    const settings = fakeSettings();
    settings.smtp = vi
      .fn()
      .mockResolvedValueOnce({ config: initial, source: 'environment', updatedAt: null })
      .mockResolvedValueOnce({ config: stored, source: 'stored', updatedAt: new Date(0) });
    settings.set.mockResolvedValue(stored as never);
    const platformSecrets: PlatformSecretStore = {
      get: vi.fn(async () => null),
      has: vi.fn(async () => true),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const api = await makeSettingsApi(settings, { platformSecrets });
    const authorization = `Bearer ${await sign(operatorSubject)}`;

    const getResponse = await api.request('/platform-settings/smtp', {
      headers: { authorization },
    });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({
      config: initial,
      source: 'environment',
      passwordConfigured: true,
      updatedAt: null,
    });

    const putResponse = await api.request('/platform-settings/smtp', {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ config: stored, password: ' smtp-secret ' }),
    });
    expect(putResponse.status).toBe(200);
    const responseBody = await putResponse.json();
    expect(responseBody).toEqual({
      config: stored,
      source: 'stored',
      passwordConfigured: true,
      updatedAt: new Date(0).toISOString(),
    });
    expect(platformSecrets.put).toHaveBeenCalledWith('smtp.password', ' smtp-secret ');
    expect(settings.set).toHaveBeenCalledWith('SMTP', stored, {
      actorUserId: expect.any(String),
    });
    expect(JSON.stringify(responseBody)).not.toContain('smtp-secret');
  });

  test('sends an SMTP test to the operator verified email and returns adapter errors verbatim', async () => {
    const config: SmtpSettings = {
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      from: 'alerts@example.test',
      username: 'mailer',
    };
    const settings = fakeSettings();
    settings.smtp = vi.fn(async () => ({ config, source: 'stored', updatedAt: new Date(0) }));
    const platformSecrets: PlatformSecretStore = {
      get: vi.fn(async () => 'smtp-secret'),
      has: vi.fn(async () => true),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const send = vi.fn(async () => {
      throw new Error('relay refused recipient');
    });
    const api = await makeSettingsApi(settings, {
      platformSecrets,
      makeEmailAdapter: () => ({ send }),
    });

    const response = await api.request('/platform-settings/smtp/test', {
      method: 'POST',
      headers: { authorization: `Bearer ${await sign(operatorSubject)}` },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'relay refused recipient' });
    expect(send).toHaveBeenCalledWith({
      to: `${operatorSubject}@example.test`,
      subject: 'SRE Platform SMTP test',
      text: 'SMTP delivery from SRE Platform is working.',
    });
  });

  test('rejects incompatible LLM settings and credentials for ambient authentication', async () => {
    const settings = fakeSettings();
    settings.llmRuntime = vi.fn();
    const platformSecrets: PlatformSecretStore = {
      get: vi.fn(async () => null),
      has: vi.fn(async () => false),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const api = await makeSettingsApi(settings, { platformSecrets });
    const authorization = `Bearer ${await sign(operatorSubject)}`;
    const incompatible = await api.request('/platform-settings/llm', {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          runtime: 'openai-chat',
          provider: 'anthropic',
          model: 'wrong',
          baseUrl: null,
          authMode: 'oauth',
          maxTurns: 8,
          pricing: null,
        },
      }),
    });
    expect(incompatible.status).toBe(400);

    const ambient = await api.request('/platform-settings/llm', {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          runtime: 'claude-agent-sdk',
          provider: 'bedrock',
          model: 'bedrock-model',
          baseUrl: null,
          authMode: 'ambient',
          maxTurns: 8,
          pricing: null,
        },
        credential: 'must-not-be-accepted',
      }),
    });
    expect(ambient.status).toBe(400);

    const missingCredential = await api.request('/platform-settings/llm', {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          runtime: 'openai-chat',
          provider: 'openai',
          model: 'gpt-test',
          baseUrl: null,
          authMode: 'api-key',
          maxTurns: 8,
          pricing: null,
        },
      }),
    });
    expect(missingCredential.status).toBe(400);

    const validateCustomProviderUrl = vi.fn(async () => {
      throw new Error('blocked');
    });
    const guarded = await makeSettingsApi(settings, {
      platformSecrets,
      validateCustomProviderUrl,
    });
    const unsafeEndpoint = await guarded.request('/platform-settings/llm', {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        config: {
          runtime: 'claude-agent-sdk',
          provider: 'custom-anthropic',
          model: 'claude-test',
          baseUrl: 'https://169.254.169.254',
          authMode: 'api-key',
          maxTurns: 8,
          pricing: null,
        },
        credential: 'must-not-leave-the-platform',
      }),
    });
    expect(unsafeEndpoint.status).toBe(400);
    expect(validateCustomProviderUrl).toHaveBeenCalledWith('https://169.254.169.254');
    expect(platformSecrets.put).not.toHaveBeenCalled();
    expect(settings.set).not.toHaveBeenCalled();
  });
});
