import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { and, eq } from 'drizzle-orm';
import { memberships, users } from '../../../../packages/db/src';
import { ownershipFixture } from '../../../api/src/admin/__tests__/ownership.fixture';

const f = ownershipFixture();
test('operator confirms the exact owner and member permissions refresh through authenticated API', async () => {
  await f.db.db.update(memberships).set({ role: 'owner' }).where(eq(memberships.userId, f.peerId));
  await f.db.db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.peerId));
  const root = process.cwd();
  const evidence = resolve(root, '.ownership-evidence.local');
  await mkdir(evidence, { recursive: true });
  const server = await createServer({
    root: resolve(root, 'apps/dashboard'),
    configFile: resolve(root, 'apps/dashboard/vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, watch: null },
    plugins: [
      {
        name: 'ownership-acceptance',
        configureServer(vite) {
          vite.middlewares.use('/__ownership', async (_request, response, next) => {
            try {
              response.setHeader('Content-Type', 'text/html');
              response.end(
                await vite.transformIndexHtml(
                  '/__ownership',
                  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/@fs/${root}/apps/dashboard/checks/__tests__/ownership.fixture.tsx"></script></body></html>`,
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
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ operatorToken, memberToken }) =>
        Object.assign(window, {
          operatorToken,
          memberToken,
          __SRE_PLATFORM_CONFIG__: { apiBaseUrl: 'https://api.fixture.example' },
        }),
      { operatorToken: f.actorToken, memberToken: f.memberToken },
    );
    await page.route('https://api.fixture.example/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const cors = {
        'access-control-allow-origin': `http://127.0.0.1:${address.port}`,
        'access-control-allow-credentials': 'true',
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (url.pathname === '/auth/browser/session')
        return route.fulfill({ headers: cors, json: { authenticated: false } });
      if (url.pathname === '/public-config')
        return route.fulfill({
          headers: cors,
          json: { staffProvider: null, development: { enabled: false } },
        });
      const response = await f.api.request(url.pathname + url.search, {
        method: request.method(),
        headers: request.headers(),
        body: request.postData() ?? undefined,
      });
      await route.fulfill({
        status: response.status,
        headers: { ...Object.fromEntries(response.headers), ...cors },
        body: await response.text(),
      });
    });
    await page.goto(`http://127.0.0.1:${address.port}/__ownership`);
    const workspace = page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'Ownerless workspace', exact: true }) });
    await workspace.getByRole('button', { name: 'Recover owner' }).click();
    await workspace.getByLabel('New owner').selectOption(f.memberId);
    await workspace.getByLabel('Recovery reason').fill('Confirmed legacy workspace ownership');
    await workspace.getByRole('button', { name: 'Review recovery' }).click();
    await workspace
      .getByRole('heading', { name: 'Make member@example.test the owner of Ownerless workspace?' })
      .waitFor();
    expect(await f.role()).toBe('member');
    expect(await workspace.getByRole('button', { name: 'Confirm change' }).isDisabled()).toBe(true);
    await workspace
      .getByText('Existing inactive owners keep their grants.', { exact: false })
      .waitFor();
    await page.screenshot({ path: resolve(evidence, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(evidence, 'mobile.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await workspace.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await f.role()).toBe('member');
    await workspace.getByRole('button', { name: 'Review recovery' }).click();
    // A changed account is rejected by the real API, without leaving the confirmation screen.
    await f.db.db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.memberId));
    await workspace
      .getByLabel(`Type ownerless-${f.tenantId} to confirm`)
      .fill(`ownerless-${f.tenantId}`);
    await workspace.getByRole('button', { name: 'Confirm change' }).click();
    await workspace
      .getByRole('alert')
      .filter({ hasText: 'choose an existing active member' })
      .waitFor();
    expect(await f.role()).toBe('member');
    await f.db.db.update(users).set({ status: 'active' }).where(eq(users.id, f.memberId));
    await workspace.getByRole('button', { name: 'Confirm change' }).click();
    await workspace.getByRole('button', { name: 'Confirm change' }).waitFor({ state: 'detached' });
    expect(await f.role()).toBe('owner');
    await page.getByRole('button', { name: 'View as member' }).click();
    await page.getByRole('button', { name: 'Invite member', exact: true }).waitFor();
    await page.getByRole('cell', { name: 'owner', exact: true }).first().waitFor();
    expect(await page.getByText('This workspace has no owner.', { exact: false }).count()).toBe(0);
    expect(
      await f.db.db
        .select()
        .from(memberships)
        .where(and(eq(memberships.tenantId, f.tenantId), eq(memberships.role, 'owner'))),
    ).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await server.close();
  }
}, 60_000);
