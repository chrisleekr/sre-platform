import { Hono } from 'hono';
import type { LlmRuntimeConfig, UpdateLlmSettingsRequest } from '@sre/contracts';
import { readPlatformLlmUsageSummary, type Db, type PlatformSecretStore } from '@sre/db';
import {
  llmCredentialSecretName,
  llmRuntimeConfigSchema,
  smtpSettingsSchema,
  type SmtpSettings,
  type PlatformSettings,
} from '@sre/platform-settings';
import { makeSmtpAdapter, type EmailAdapter } from '@sre/notifications';
import { requirePlatformAdmin, requireUser, type AuthDeps, type AuthVariables } from './auth';

export interface PlatformSettingsRoutesDeps {
  auth: AuthDeps;
  /** App-role connection used only for the platform operator allowlist lookup. */
  operatorDb: Db;
  /** Admin connection for global configuration and cross-tenant aggregate usage. */
  controlDb?: Db;
  settings: Pick<PlatformSettings, 'list' | 'set'> &
    Partial<Pick<PlatformSettings, 'llmRuntime' | 'smtp'>>;
  platformSecrets?: PlatformSecretStore;
  validateCustomProviderUrl: (url: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  makeEmailAdapter?: (settings: SmtpSettings, password: string | null) => EmailAdapter;
}

function environmentCredentialConfigured(
  config: LlmRuntimeConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  if (config.authMode === 'ambient') return true;
  if (config.provider === 'custom-anthropic') return false;
  if (config.runtime === 'openai-chat') return Boolean(env.OPENAI_API_KEY?.trim());
  return config.authMode === 'oauth'
    ? Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim())
    : Boolean(env.ANTHROPIC_API_KEY?.trim());
}

function usageWindow(url: URL): { from: Date; to: Date } | null {
  const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : new Date();
  const from = url.searchParams.get('from')
    ? new Date(url.searchParams.get('from')!)
    : new Date(to.getTime() - 30 * 86_400_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return null;
  if (from >= to || to.getTime() - from.getTime() > 366 * 86_400_000) return null;
  return { from, to };
}

export function platformSettingsRoutes(
  deps: PlatformSettingsRoutesDeps,
): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  routes.use('*', requireUser(deps.auth));
  routes.use('*', requirePlatformAdmin(deps.auth));

  routes.get('/', async (c) => c.json({ settings: await deps.settings.list() }));

  routes.get('/llm', async (c) => {
    if (!deps.settings.llmRuntime) {
      return c.json({ error: 'LLM settings are unavailable' }, 503);
    }
    const current = await deps.settings.llmRuntime();
    const encrypted =
      (await deps.platformSecrets?.has(llmCredentialSecretName(current.config))) ?? false;
    return c.json({
      config: current.config,
      source: current.source,
      credentialConfigured:
        encrypted || environmentCredentialConfigured(current.config, deps.env ?? process.env),
      updatedAt: current.updatedAt?.toISOString() ?? null,
    });
  });

  routes.put('/llm', async (c) => {
    if (!deps.settings.llmRuntime) {
      return c.json({ error: 'LLM settings are unavailable' }, 503);
    }
    const body = await c.req.json<UpdateLlmSettingsRequest>().catch(() => null);
    const parsed = llmRuntimeConfigSchema.safeParse(body?.config);
    if (!parsed.success) return c.json({ error: 'invalid LLM runtime configuration' }, 400);
    const credential = body?.credential?.trim();
    if (credential && parsed.data.authMode === 'ambient') {
      return c.json({ error: 'ambient authentication does not accept a stored credential' }, 400);
    }
    if (credential && !deps.platformSecrets) {
      return c.json({ error: 'encrypted platform credential storage is unavailable' }, 503);
    }

    if (parsed.data.provider === 'custom-anthropic') {
      try {
        await deps.validateCustomProviderUrl(parsed.data.baseUrl!);
      } catch {
        return c.json({ error: 'custom provider URL is not allowed' }, 400);
      }
    }

    const secretName = llmCredentialSecretName(parsed.data);
    const credentialConfigured =
      parsed.data.authMode === 'ambient' ||
      Boolean(credential) ||
      Boolean(await deps.platformSecrets?.has(secretName)) ||
      environmentCredentialConfigured(parsed.data, deps.env ?? process.env);
    if (!credentialConfigured) {
      return c.json({ error: 'a credential is required before activating this model' }, 400);
    }

    // Validate first, then replace the credential before publishing the new config. A failed secret
    // write leaves the active configuration untouched.
    if (credential) {
      await deps.platformSecrets!.put(secretName, credential);
    }
    await deps.settings.set('LLM_RUNTIME', parsed.data, { actorUserId: c.get('user').userId });
    const current = await deps.settings.llmRuntime();
    return c.json({
      config: current.config,
      source: current.source,
      credentialConfigured: true,
      updatedAt: current.updatedAt?.toISOString() ?? null,
    });
  });

  routes.get('/llm/usage', async (c) => {
    if (!deps.controlDb) return c.json({ error: 'usage reporting is unavailable' }, 503);
    const window = usageWindow(new URL(c.req.url));
    if (!window) return c.json({ error: 'invalid usage window' }, 400);
    return c.json(await readPlatformLlmUsageSummary(deps.controlDb, window.from, window.to));
  });

  routes.get('/smtp', async (c) => {
    if (!deps.settings.smtp || !deps.platformSecrets) {
      return c.json({ error: 'SMTP settings are unavailable' }, 503);
    }
    const current = await deps.settings.smtp();
    return c.json({
      config: current.config,
      source: current.source,
      passwordConfigured:
        Boolean(current.config?.username) && (await deps.platformSecrets.has('smtp.password')),
      updatedAt: current.updatedAt?.toISOString() ?? null,
    });
  });

  routes.put('/smtp', async (c) => {
    if (!deps.settings.smtp || !deps.platformSecrets) {
      return c.json({ error: 'SMTP settings are unavailable' }, 503);
    }
    const body = await c.req.json<{ config?: unknown; password?: unknown }>().catch(() => null);
    if (!body || !Object.hasOwn(body, 'config')) {
      return c.json({ error: 'SMTP configuration is required' }, 400);
    }
    const parsed = smtpSettingsSchema.safeParse(body.config);
    if (!parsed.success) return c.json({ error: 'invalid SMTP configuration' }, 400);
    if (body.password !== undefined && typeof body.password !== 'string') {
      return c.json({ error: 'invalid SMTP password' }, 400);
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (!parsed.data && password) {
      return c.json({ error: 'disabled SMTP does not accept a password' }, 400);
    }
    if (parsed.data && !parsed.data.username && password) {
      return c.json({ error: 'SMTP username is required with a password' }, 400);
    }
    const passwordConfigured =
      Boolean(parsed.data?.username) &&
      (Boolean(password) || (await deps.platformSecrets.has('smtp.password')));
    if (parsed.data?.username && !passwordConfigured) {
      return c.json({ error: 'SMTP password is required with a username' }, 400);
    }
    if (password) await deps.platformSecrets.put('smtp.password', password);
    await deps.settings.set('SMTP', parsed.data, { actorUserId: c.get('user').userId });
    const current = await deps.settings.smtp();
    return c.json({
      config: current.config,
      source: current.source,
      passwordConfigured: Boolean(current.config?.username) && passwordConfigured,
      updatedAt: current.updatedAt?.toISOString() ?? null,
    });
  });

  routes.post('/smtp/test', async (c) => {
    if (!deps.settings.smtp || !deps.platformSecrets) {
      return c.json({ error: 'SMTP settings are unavailable' }, 503);
    }
    const to = c.get('user').email;
    if (!to) return c.json({ error: 'a verified account email is required' }, 400);
    const current = await deps.settings.smtp();
    if (!current.config) return c.json({ error: 'SMTP is not configured' }, 409);
    try {
      const password = current.config.username
        ? await deps.platformSecrets.get('smtp.password')
        : null;
      const adapter = (deps.makeEmailAdapter ?? makeSmtpAdapter)(current.config, password);
      await adapter.send({
        to,
        subject: 'SRE Platform SMTP test',
        text: 'SMTP delivery from SRE Platform is working.',
      });
      return c.json({ ok: true, to });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  routes.put('/:key', async (c) => {
    const body = await c.req.json<{ value?: unknown }>().catch(() => null);
    if (!body || !Object.hasOwn(body, 'value')) return c.json({ error: 'value is required' }, 400);
    try {
      const key = c.req.param('key');
      if (key === 'REGISTRATION_MODE' || key === 'LLM_RUNTIME' || key === 'SMTP') {
        return c.json({ error: `setting is not numeric: ${key}` }, 400);
      }
      const value = await deps.settings.set(key, body.value, {
        actorUserId: c.get('user').userId,
      });
      if (typeof value !== 'number') throw new TypeError(`setting is not numeric: ${key}`);
      return c.json({ key, value });
    } catch (error) {
      if (error instanceof TypeError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  return routes;
}
