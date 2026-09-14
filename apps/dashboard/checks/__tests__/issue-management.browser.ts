import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { issueFixture } from '../../../api/src/__tests__/issue-management.fixture';

const f = issueFixture();
test.each(['github', 'gitlab'] as const)(
  '%s browser confirmation reaches authenticated API, database and provider adapter',
  async (provider) => {
    f.configure(provider);
    f.fail(null);
    f.writes.length = 0;
    const incidentId = await f.incident();
    const root = process.cwd();
    const server = await createServer({
      root: resolve(root, 'apps/dashboard'),
      configFile: resolve(root, 'apps/dashboard/vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, watch: null },
      plugins: [
        {
          name: 'issue-acceptance',
          configureServer(vite) {
            vite.middlewares.use('/__issues', async (_request, response, next) => {
              try {
                response.setHeader('Content-Type', 'text/html');
                response.end(
                  await vite.transformIndexHtml(
                    '/__issues',
                    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/@fs/${root}/apps/dashboard/checks/__tests__/issue-management.fixture.tsx"></script></body></html>`,
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
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(
        ({ token, id }) => Object.assign(window, { integrationToken: token, incidentId: id }),
        { token: f.token, id: incidentId },
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
      await page.goto(`http://127.0.0.1:${address.port}/__issues`);
      await page
        .getByRole('option', { name: `${provider} · ${provider}` })
        .waitFor({ state: 'attached' });
      await page.getByRole('button', { name: 'Find repositories' }).click();
      await page.getByRole('button', { name: 'team/service', exact: true }).click();
      await page.getByRole('button', { name: 'Load issues' }).click();
      await page.getByRole('button', { name: 'Edit issue #12' }).waitFor();
      await page.getByRole('button', { name: 'New issue', exact: true }).click();
      await page.getByLabel('Title', { exact: true }).fill('Investigate worker saturation');
      await page
        .getByLabel('Description', { exact: true })
        .fill('Observed queue delay. Confirm the cause before remediation.');
      await page.getByRole('button', { name: 'Review changes' }).click();
      await page.getByRole('button', { name: 'Publish issue' }).waitFor();
      await page
        .getByText(
          `https://${provider === 'github' ? 'github.com' : 'gitlab.example.com'}/team/service`,
          {
            exact: true,
          },
        )
        .waitFor();
      expect(f.writes).toHaveLength(0);
      await page.getByRole('button', { name: 'Publish issue' }).click();
      await page.getByText('team/service · New issue · succeeded', { exact: true }).waitFor();
      expect(f.writes).toHaveLength(1);
      for (const state of ['closed', 'open'] as const) {
        await page.getByRole('button', { name: 'Load issues' }).click();
        await page.getByRole('button', { name: 'Edit issue #12' }).click();
        await page.getByRole('combobox', { name: /^New issue state/ }).selectOption(state);
        await page.getByRole('button', { name: 'Review changes' }).click();
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await page
          .getByRole('button', { name: 'Save changes', exact: true })
          .waitFor({ state: 'detached' });
      }
      expect(f.writes).toHaveLength(3);
      await page.getByRole('button', { name: 'New issue', exact: true }).click();
      await page.getByLabel('Title', { exact: true }).fill('Do not publish');
      await page.getByRole('button', { name: 'Review changes' }).click();
      await page.getByRole('button', { name: 'Discard draft' }).click();
      await page.getByText('team/service · New issue · cancelled', { exact: true }).waitFor();
      expect(f.writes).toHaveLength(3);
      await page.getByRole('button', { name: 'New issue', exact: true }).click();
      await page.getByLabel('Title', { exact: true }).fill('Uncertain response');
      await page.getByRole('button', { name: 'Review changes' }).click();
      f.fail('network');
      await page.getByRole('button', { name: 'Publish issue' }).click();
      await page.getByText('team/service · New issue · unknown', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Refresh status' }).click();
      expect(f.writes).toHaveLength(4);
      expect(await page.getByRole('button', { name: /Publish issue|Save changes/ }).count()).toBe(
        0,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
  60_000,
);
