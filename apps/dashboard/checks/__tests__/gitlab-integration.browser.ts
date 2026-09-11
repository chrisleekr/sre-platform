import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { makeDbConnectorProvider } from '../../../../packages/agent-tools/src/index';
import {
  discoverGitLabGroup,
  gitLabWebhookSigningToken,
} from '../../../../packages/connectors/src/index';
import {
  connectorCredentialKey,
  connectorConfigs,
  memberships,
  gitlabEvents,
  listChangesPage,
  withTenant,
} from '../../../../packages/db/src/index';
import { makeSnapshotCache } from '../../../../packages/queue/src/index';
import { createFixture } from '../../../api/src/__tests__/connectors.fixture';
import { gitLabWebhookRoutes } from '../../../api/src/gitlab-webhook';
import { makePollHandler } from '../../../triage-worker/src/poller';
import { persistDeploys } from '../../../triage-worker/src/persist-deploys';
import { reconcileGitLabHooks } from '../../../triage-worker/src/gitlab-hook-management/reconcile';

const fixture = createFixture();
const providerTime = '2026-09-08T00:00:00.123456Z';
const project = {
  id: 42,
  name: 'service',
  path_with_namespace: 'platform/service',
  web_url: 'https://gitlab.example.com/platform/service',
  default_branch: 'main',
};
const group = {
  id: 7,
  name: 'Platform',
  full_path: 'platform',
  web_url: 'https://gitlab.example.com/groups/platform',
};
const pipeline = {
  id: 9,
  project_id: 42,
  status: 'success',
  updated_at: providerTime,
  sha: 'abc123',
  ref: 'main',
};
let managedHook: Record<string, unknown> | undefined;
let managementWrites = 0;
let loseNextCreate = false;

const gitlabFetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://gitlab.example.com')
      throw new Error('Test attempted an unscoped provider request');
    if (init?.method && init.method !== 'GET') {
      if (
        !['POST', 'PUT'].includes(init.method) ||
        !/^\/api\/v4\/projects\/42\/hooks(?:\/55)?$/.test(url.pathname) ||
        new Headers(init.headers).get('PRIVATE-TOKEN') !== 'isolated-management-token'
      )
        throw new Error('Test attempted an unapproved provider write');
      managementWrites++;
      if (init.method === 'POST' && loseNextCreate) {
        loseNextCreate = false;
        throw new Error('Simulated uncertain create with no hook retained');
      }
      managedHook = { ...JSON.parse(String(init.body)), project_id: 42, id: 55 };
      return Response.json(managedHook);
    }
    if (url.pathname.endsWith('/hooks/55')) return Response.json(managedHook);
    if (url.pathname.endsWith('/hooks'))
      return Response.json(managedHook ? [managedHook] : [], { headers: { 'x-next-page': '' } });
    if (url.pathname.endsWith('/version'))
      return Response.json({ version: '19.2.4', enterprise: false });
    if (url.pathname.endsWith('/user')) return Response.json({ id: 1 });
    if (/\/groups\/[^/]+\/projects$/.test(url.pathname))
      return Response.json([project], { headers: { 'x-next-page': '' } });
    if (/\/groups\/[^/]+$/.test(url.pathname)) return Response.json(group);
    if (/\/projects\/[^/]+$/.test(url.pathname)) return Response.json(project);
    if (url.pathname.endsWith('/pipelines'))
      return Response.json(url.searchParams.has('source') ? [] : [pipeline]);
    if (/\/(commits|deployments|jobs|releases)$/.test(url.pathname)) return Response.json([]);
    throw new Error(`Unhandled simulated GitLab path: ${url.pathname}`);
  },
  { preconnect: () => undefined },
);

test.each([
  { strategy: 'group', recover: false },
  { strategy: 'system', recover: false },
  { strategy: 'managed_projects', recover: false },
  { strategy: 'managed_projects', recover: true },
] as const)(
  '$strategy recovery=$recover browser setup reaches authenticated API, durable storage, worker and coverage UI',
  async ({ strategy, recover }) => {
    managedHook = undefined;
    managementWrites = 0;
    loseNextCreate = recover;
    await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      tx.update(memberships).set({ role: 'admin' }),
    );
    const root = process.cwd();
    const server = await createServer({
      root: resolve(root, 'apps/dashboard'),
      configFile: resolve(root, 'apps/dashboard/vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, watch: null },
      plugins: [
        {
          name: 'gitlab-integration-page',
          configureServer(vite) {
            vite.middlewares.use('/__gitlab-integration', async (_request, response, next) => {
              try {
                response.setHeader('Content-Type', 'text/html');
                response.end(
                  await vite.transformIndexHtml(
                    '/__gitlab-integration',
                    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/@fs/${root}/apps/dashboard/checks/__tests__/gitlab-integration.fixture.tsx"></script></body></html>`,
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
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let redis: Redis | undefined;
    try {
      browser = await chromium.launch();
      redis = new Redis(process.env.VALKEY_URL!);
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Missing browser test port');
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors: string[] = [];
      const responses: Array<{ path: string; status: number }> = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(
        (token) => {
          (window as unknown as { integrationToken: string }).integrationToken = token;
        },
        await fixture.sign(fixture.orgA),
      );
      const api = fixture.makeConnApp(gitlabFetch, undefined, fixture.secrets, {
        discoverGroup: (settings, token) =>
          discoverGitLabGroup(settings, token, gitlabFetch, async () => ['93.184.216.34']),
      });
      // Bridge browser HTTP into the real authenticated router. Only the GitLab provider is simulated.
      await page.route('https://api.fixture.example/**', async (route) => {
        const request = route.request();
        const cors = {
          'access-control-allow-origin': `http://127.0.0.1:${address.port}`,
          'access-control-allow-credentials': 'true',
          'access-control-allow-headers': 'authorization,content-type',
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const response = await api.request(new URL(request.url()).pathname, {
          method: request.method(),
          headers: request.headers(),
          body: request.postData() ?? undefined,
        });
        responses.push({ path: new URL(request.url()).pathname, status: response.status });
        await route.fulfill({
          status: response.status,
          headers: { ...Object.fromEntries(response.headers), ...cors },
          body: await response.text(),
        });
      });
      await page.goto(`http://127.0.0.1:${address.port}/__gitlab-integration`);
      const connectionName = `GitLab ${strategy}${recover ? ' recovery' : ''}`;
      await page.getByLabel('Data source name', { exact: false }).fill(connectionName);
      await page.getByLabel('GitLab URL', { exact: true }).fill('https://gitlab.example.com');
      await page.getByLabel('Top-level group full path').fill('platform');
      await page.getByLabel('Read-only access token', { exact: false }).fill('isolated-read-token');
      await page.getByRole('button', { name: 'Check access and discover projects' }).click();
      await page.getByText('1 project discovered').waitFor();
      await page.getByRole('button', { name: 'Configure event sync' }).click();
      if (strategy === 'system')
        await page.getByRole('radio', { name: /System hook \+ polling/ }).check();
      else if (strategy === 'group') await page.getByRole('radio', { name: /Group hook/ }).check();
      else await page.getByRole('checkbox', { name: /Automatically manage project hooks/ }).check();
      await page.getByRole('radio', { name: /Public HTTPS API/ }).check();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Save and verify' }).click();
      await page
        .getByRole('button', { name: 'Finish', exact: true })
        .waitFor()
        .catch(async () => {
          throw new Error(
            JSON.stringify({ responses, alerts: await page.getByRole('alert').allTextContents() }),
          );
        });
      const [saved] = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
        tx.select().from(connectorConfigs).where(eq(connectorConfigs.name, connectionName)),
      );
      if (!saved) throw new Error('Missing saved integration connector');
      expect(saved.enabled).toBe(true);
      expect(saved.settings).toMatchObject({ eventStrategy: strategy, eventTransport: 'direct' });
      if (strategy === 'group') {
        const command = await page
          .getByLabel('install-hook command', { exact: true })
          .textContent();
        expect(command).toContain('groups/7/hooks');
        expect(command).not.toContain('for project_id');
        expect(managementWrites).toBe(0);
      }
      if (strategy === 'managed_projects') {
        await page.getByRole('button', { name: 'Review management scope' }).click();
        await page
          .getByLabel('Management access token', { exact: true })
          .fill('isolated-management-token');
        await page.getByRole('checkbox', { name: /I authorize ongoing creation/ }).check();
        await page.getByRole('button', { name: 'Authorize automatic hooks' }).click();
        await page.getByText('Management authorized', { exact: true }).waitFor();
      }

      const credential = await fixture.secrets.get(
        fixture.tenantA,
        connectorCredentialKey(saved.id),
      );
      const signingToken = gitLabWebhookSigningToken(credential!)!;
      const webhook = gitLabWebhookRoutes({
        adminDb: fixture.admin.db,
        appDb: fixture.app.db,
        secrets: fixture.secrets,
        fetch: gitlabFetch,
        lookup: async () => ['93.184.216.34'],
      });
      for (let i = 0; i < 2; i++) {
        const body = JSON.stringify({ project, object_attributes: pipeline });
        const id = randomUUID(),
          timestamp = String(Math.floor(Date.now() / 1000));
        const signature = createHmac('sha256', Buffer.from(signingToken.slice(6), 'base64'))
          .update(`${id}.${timestamp}.${body}`)
          .digest('base64');
        expect(
          (
            await webhook.request(`/${saved.webhookKey}`, {
              method: 'POST',
              headers: {
                'x-gitlab-event': 'Pipeline Hook',
                'webhook-id': id,
                'webhook-timestamp': timestamp,
                'webhook-signature': `v1,${signature}`,
              },
              body,
            })
          ).status,
        ).toBe(202);
      }
      const cache = makeSnapshotCache(redis);
      const poll = makePollHandler({
        reconcileGitLabHooks: (tenantId, connectorId) =>
          reconcileGitLabHooks(
            {
              db: fixture.app.db,
              secrets: fixture.secrets,
              fetch: gitlabFetch,
              lookup: async () => ['93.184.216.34'],
            },
            tenantId,
            connectorId,
          ),
        connectorProvider: makeDbConnectorProvider({
          db: fixture.app.db,
          registry: fixture.testRegistry(gitlabFetch),
          secrets: fixture.secrets,
        }),
        cache,
        ttlSec: 120,
        persistDeploys: (tenantId, snapshots, type, evidence, generation) =>
          persistDeploys(fixture.app.db, tenantId, snapshots, type, evidence, generation),
      });
      await poll({
        id: randomUUID(),
        tenantId: fixture.tenantA,
        type: 'poll',
        payload: { connectorId: saved.id },
        attempts: 1,
      });
      const receipts = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
        tx.select().from(gitlabEvents).where(eq(gitlabEvents.connectorId, saved.id)),
      );
      expect(receipts).toHaveLength(strategy === 'system' ? 3 : 2);
      expect(new Set(receipts.map((receipt) => receipt.observationKey)).size).toBe(1);
      expect(
        (await listChangesPage(fixture.app.db, fixture.tenantA)).changes.filter(
          (change) => change.dataSourceId === saved.id,
        ),
      ).toHaveLength(1);
      if (strategy === 'system')
        expect(
          await cache.get(fixture.tenantA, 'gitlab', {
            id: saved.id,
            lifecycleVersion: saved.lifecycleVersion,
          }),
        ).not.toEqual([]);
      await page.getByRole('button', { name: 'Finish', exact: true }).click();
      await page.getByRole('button', { name: 'Refresh coverage' }).click();
      if (strategy === 'system')
        await page
          .getByText('1 projects · 0 not yet checked · 0 failing · 0 with backlog')
          .waitFor();
      else if (strategy === 'managed_projects') {
        expect(managementWrites).toBe(1);
        const reconcile = () =>
          reconcileGitLabHooks(
            {
              db: fixture.app.db,
              secrets: fixture.secrets,
              fetch: gitlabFetch,
              lookup: async () => ['93.184.216.34'],
            },
            fixture.tenantA,
            saved.id,
          );
        if (recover) {
          await reconcile();
          expect(managementWrites).toBe(1);
          await page.getByRole('button', { name: 'Refresh coverage' }).click();
          await page.getByRole('button', { name: 'Review management scope' }).click();
          await page.getByText(/Planned project actions/).click();
          await page.getByLabel(/I checked GitLab and confirmed no hook exists/).check();
          await page.getByLabel('Management access token').fill('isolated-management-token');
          await page.getByLabel(/I authorize ongoing creation/).check();
          await page.getByRole('button', { name: 'Authorize automatic hooks' }).click();
          await page
            .getByText(
              'Management authorized. The worker will reconcile hooks; verify incoming events separately.',
              { exact: true },
            )
            .waitFor();
          expect(managementWrites).toBe(1);
          await reconcile();
          expect(managementWrites).toBe(2);
          await page.getByRole('button', { name: 'Refresh coverage' }).click();
        }
        await page
          .getByText(
            '1 covered · 0 confirmed missing · 0 pending · 0 needing attention · 1 known projects',
          )
          .waitFor();
        await page.getByRole('button', { name: 'Stop management' }).click();
        await page.getByText('Management not authorized for the current configuration').waitFor();
        await reconcile();
        expect(managementWrites).toBe(recover ? 2 : 1);
      } else {
        expect(managementWrites).toBe(0);
        const [health] = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
          tx.select().from(connectorConfigs).where(eq(connectorConfigs.id, saved.id)),
        );
        expect(health).toMatchObject({ eventCount: 2, eventFailureCategory: null });
        expect(health!.eventSucceededAt).toBeInstanceOf(Date);
      }
      expect(errors).toEqual([]);
    } finally {
      await Promise.all([redis?.quit(), browser?.close(), server.close()]);
    }
  },
);
