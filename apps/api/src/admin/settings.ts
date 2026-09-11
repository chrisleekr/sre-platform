import type { PlatformSettingKey } from '@sre/platform-settings';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminRoutesDeps, AdminVariables } from './contracts';
import { adminBody } from './support';

const ADMIN_SETTING_KEYS = [
  'REGISTRATION_MODE',
  'PRODUCT_NAME',
  'PRODUCT_VALUE_LINE',
  'TERMS_URL',
  'PRIVACY_URL',
  'SUPPORT_URL',
] as const satisfies readonly PlatformSettingKey[];

const settingBody = z
  .object({
    key: z.enum(ADMIN_SETTING_KEYS),
    value: z.unknown(),
    reason: z.string().trim().min(3).max(2_000).optional(),
  })
  .strict();

/** Builds onboarding-copy and policy administration routes. */
export function adminSettingRoutes(deps: AdminRoutesDeps) {
  const routes = new Hono<{ Variables: AdminVariables }>();
  routes.get('/', async (c) => {
    const entries = await Promise.all(
      ADMIN_SETTING_KEYS.map(async (key) => ({ key, value: await deps.settings.get(key) })),
    );
    return c.json({
      settings: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
    });
  });
  routes.put('/', async (c) => {
    const body = await adminBody(c, settingBody);
    if (!body) return c.json({ error: 'valid setting input is required' }, 400);
    try {
      const value = await deps.settings.set(body.key, body.value, {
        actorUserId: c.get('user').userId,
        reason: body.reason,
      });
      return c.json({ key: body.key, value });
    } catch (error) {
      if (error instanceof TypeError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
  return routes;
}
