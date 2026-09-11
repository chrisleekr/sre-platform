import type { Context } from 'hono';

export const LOCAL_DEVELOPMENT_LOGIN_FLAG = 'ALLOW_LOCAL_DEVELOPMENT_LOGIN';

/** Only literal loopback addresses qualify; forwarded addresses are never trusted here. */
function isLoopback(address: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(address);
}

/** Validate the opt-in before any listener or passwordless endpoint is created. */
export function localDevelopmentLoginOrigin(env: NodeJS.ProcessEnv): string | undefined {
  if (env[LOCAL_DEVELOPMENT_LOGIN_FLAG] !== 'true') return undefined;
  if (env.NODE_ENV !== 'development') {
    throw new Error(`${LOCAL_DEVELOPMENT_LOGIN_FLAG} requires NODE_ENV=development`);
  }
  if (Number(env.TRUST_PROXY_HOPS ?? '0') !== 0) {
    throw new Error(`${LOCAL_DEVELOPMENT_LOGIN_FLAG} does not support reverse proxies`);
  }
  const url = new URL(env.DASHBOARD_BASE_URL ?? 'http://localhost:45173');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !isLoopback(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${LOCAL_DEVELOPMENT_LOGIN_FLAG} requires a loopback DASHBOARD_BASE_URL origin`,
    );
  }
  return url.origin;
}

/** Prevent cross-site requests and DNS rebinding, even when the browser ignores CORS. */
export function allowLocalAutoLogin(c: Context, origin: string, peer: string | undefined): boolean {
  const host = new URL(c.req.url).hostname;
  return Boolean(
    peer &&
    peer !== 'localhost' &&
    isLoopback(peer) &&
    isLoopback(host) &&
    c.req.header('origin') === origin &&
    c.req.header('x-sre-local-development') === 'true' &&
    !c.req.header('forwarded') &&
    !c.req.header('x-forwarded-for') &&
    !c.req.header('x-forwarded-host'),
  );
}
