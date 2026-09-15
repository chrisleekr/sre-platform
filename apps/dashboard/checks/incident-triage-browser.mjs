import { createServer } from 'vite';
import { resolve } from 'node:path';
import { checks, TRIAGE_ID } from './__tests__/incident-triage-data.fixture';

export async function startIncidentTriageFixture() {
  const root = process.cwd();
  const sockets = new Set();
  const socketServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      return server.upgrade(request, { data: undefined })
        ? undefined
        : new Response('Not found', { status: 404 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        for (const message of history) socket.send(JSON.stringify({ ...message, replay: true }));
      },
      close(socket) {
        sockets.delete(socket);
      },
      message() {},
    },
  });
  let updates = 0;
  const history = [
    {
      id: 'opening',
      incidentId: TRIAGE_ID,
      author: 'human',
      kind: 'text',
      content: 'Initial responder context',
      createdAt: '2026-09-14T00:00:00Z',
    },
  ];
  const server = await createServer({
    root: resolve(root, 'apps/dashboard'),
    configFile: resolve(root, 'apps/dashboard/vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null },
    plugins: [
      {
        name: 'incident-triage-acceptance',
        configureServer(vite) {
          vite.middlewares.use('/__api', (request, response, next) => {
            try {
              const url = new URL(request.url ?? '/', 'http://fixture');
              response.setHeader('content-type', 'application/json');
              if (url.pathname === '/disconnect') {
                for (const client of sockets) client.close();
                response.end('{}');
                return;
              }
              if (url.pathname === '/publish') {
                const message = {
                  id: `update-${++updates}`,
                  incidentId: TRIAGE_ID,
                  author: 'human',
                  kind: 'text',
                  content: `New responder evidence ${updates}`,
                  createdAt: new Date().toISOString(),
                  replay: false,
                };
                history.push(message);
                for (const client of sockets) client.send(JSON.stringify(message));
                response.end('{}');
                return;
              }
              if (url.pathname === '/ws/ticket') {
                response.end(JSON.stringify({ ticket: 'fixture' }));
                return;
              }
              if (url.pathname.endsWith('/evidence')) {
                const offset = Number(url.searchParams.get('before') ?? 0);
                response.end(
                  JSON.stringify({
                    evidence: checks
                      .slice(offset, offset + 20)
                      .map(
                        ({ input: _input, output: _output, projection: _projection, ...item }) =>
                          item,
                      ),
                    nextCursor: offset + 20 < checks.length ? String(offset + 20) : null,
                  }),
                );
                return;
              }
              if (url.pathname.includes('/evidence/')) {
                const detail = checks.find((item) => url.pathname.endsWith(`/${item.id}`));
                response.statusCode = detail ? 200 : 404;
                response.end(JSON.stringify(detail ?? { error: 'not found' }));
                return;
              }
              response.end(
                JSON.stringify({ messages: history, attachments: [], nextCursor: null }),
              );
            } catch (error) {
              next(error);
            }
          });
          vite.middlewares.use('/__triage', async (_request, response, next) => {
            try {
              response.setHeader('content-type', 'text/html');
              response.end(
                await vite.transformIndexHtml(
                  '/__triage',
                  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script>window.__SRE_PLATFORM_CONFIG__={apiBaseUrl:location.origin+'/__api',wsBaseUrl:'ws://127.0.0.1:${socketServer.port}'}</script><script type="module" src="/@fs/${root}/apps/dashboard/checks/__tests__/incident-triage.fixture.tsx"></script></body></html>`,
                ),
              );
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const stop = async () => {
    for (const client of sockets) client.close();
    socketServer.stop(true);
    await server.close();
  };
  return { url: `http://127.0.0.1:${address.port}/__triage`, stop };
}
if (import.meta.main) {
  const fixture = await startIncidentTriageFixture();
  console.log(`Incident fixture: ${fixture.url}`);
  const stop = () => void fixture.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
