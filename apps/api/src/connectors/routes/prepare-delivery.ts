import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import type { TenantAuthVariables } from '../../auth';
import { connectorInstanceId, requestObject, smeeUrlInput } from '../helpers';

/** Allocate an address without creating a connector, starting a relay, or accepting events. */
export function registerPrepareDeliveryRoutes(r: Hono<{ Variables: TenantAuthVariables }>): void {
  r.post('/:type/prepare-delivery', async (c) => {
    c.header('Cache-Control', 'no-store');
    const type = c.req.param('type');
    if (!['github', 'gitlab', 'prometheus'].includes(type))
      return c.json({ error: 'unsupported event connector' }, 400);
    const body = requestObject(await c.req.json().catch(() => null));
    if (!body || !['direct', 'smee'].includes(String(body.transport)))
      return c.json({ error: 'invalid delivery mode' }, 400);
    const setupId = body.setupId === undefined ? randomUUID() : connectorInstanceId(body.setupId);
    if (!setupId) return c.json({ error: 'invalid setup ID' }, 400);
    let smeeUrl: string | undefined;
    if (body.transport === 'smee') {
      try {
        const response = await fetch('https://smee.io/new', {
          method: 'HEAD',
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
        });
        const location = response.headers.get('location');
        const valid = location && smeeUrlInput(location);
        if (
          ![302, 303, 307, 308].includes(response.status) ||
          !valid ||
          new URL(valid).origin !== 'https://smee.io' ||
          !/^\/[A-Za-z0-9_-]{12,128}$/.test(new URL(valid).pathname)
        )
          throw new Error('invalid channel response');
        smeeUrl = valid;
      } catch {
        return c.json(
          { error: 'Could not create a Smee channel. Retry when the relay service is available.' },
          502,
        );
      }
    }
    return c.json({
      setupId,
      webhookPath: `/webhooks/${type === 'prometheus' ? 'alertmanager' : type}/${setupId}`,
      ...(smeeUrl ? { smeeUrl } : {}),
    });
  });
}
