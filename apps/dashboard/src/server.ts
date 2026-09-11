import { resolve, sep } from 'node:path';

export interface DashboardRuntimeConfig {
  apiBaseUrl: string;
  wsBaseUrl: string;
}

export function loadDashboardRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): DashboardRuntimeConfig {
  return {
    apiBaseUrl: env.DASHBOARD_API_BASE_URL ?? '',
    wsBaseUrl: env.DASHBOARD_WS_BASE_URL ?? '',
  };
}

export function runtimeConfigScript(config: DashboardRuntimeConfig): string {
  const json = JSON.stringify(config).replaceAll('<', '\\u003c');
  return `window.__SRE_PLATFORM_CONFIG__ = ${json};\n`;
}

export function dashboardHeaders(cacheControl: string, contentType?: string): HeadersInit {
  return {
    ...(contentType ? { 'content-type': contentType } : {}),
    'cache-control': cacheControl,
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  };
}

function noCacheHeaders(contentType?: string): HeadersInit {
  return dashboardHeaders('no-store', contentType);
}

export function startDashboardServer(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof Bun.serve> {
  const port = Number(env.PORT ?? '8080');
  const dist = resolve(env.DASHBOARD_DIST_DIR ?? 'apps/dashboard/dist');
  const runtimeConfig = runtimeConfigScript(loadDashboardRuntimeConfig(env));

  const server = Bun.serve({
    hostname: '0.0.0.0',
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/healthz') {
        return Response.json({ status: 'ok' }, { headers: noCacheHeaders() });
      }
      if (url.pathname === '/runtime-config.js') {
        return new Response(runtimeConfig, {
          headers: noCacheHeaders('text/javascript; charset=utf-8'),
        });
      }

      let relative: string;
      try {
        relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      } catch {
        return new Response('Bad request', {
          status: 400,
          headers: dashboardHeaders('no-store', 'text/plain; charset=utf-8'),
        });
      }
      const candidate = resolve(dist, relative || 'index.html');
      const insideDist = candidate === dist || candidate.startsWith(`${dist}${sep}`);
      if (!insideDist) {
        return new Response('Not found', {
          status: 404,
          headers: dashboardHeaders('no-store', 'text/plain; charset=utf-8'),
        });
      }

      const file = Bun.file(candidate);
      if (await file.exists()) {
        const immutable = relative.startsWith('assets/');
        return new Response(file, {
          headers: dashboardHeaders(immutable ? 'public, max-age=31536000, immutable' : 'no-cache'),
        });
      }

      if (relative.includes('.')) {
        return new Response('Not found', {
          status: 404,
          headers: dashboardHeaders('no-store', 'text/plain; charset=utf-8'),
        });
      }
      return new Response(Bun.file(resolve(dist, 'index.html')), {
        headers: dashboardHeaders('no-cache'),
      });
    },
  });

  console.log(
    JSON.stringify({
      level: 'info',
      app: 'dashboard',
      msg: 'dashboard starting',
      port: server.port,
    }),
  );
  return server;
}

if (import.meta.main) startDashboardServer();
