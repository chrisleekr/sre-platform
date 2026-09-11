import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  ROOT,
  freePort,
  spawnChild,
  startInfrastructure,
  waitForHttp,
  type Child,
} from '../docs/screenshots/harness';

// Real API processes and throwaway databases exercise ephemeral-key restart recovery.
const stack = await startInfrastructure();
const children: Child[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const apiPort = await freePort();
  const dashboardPort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const dashboardBase = `http://127.0.0.1:${dashboardPort}`;
  const apiEnv = {
    NODE_ENV: 'development',
    PORT: String(apiPort),
    DATABASE_URL: stack.adminUrl,
    APP_DATABASE_URL: stack.appDbUrl,
    APP_DB_PASSWORD: 'app',
    VALKEY_URL: stack.valkeyUrl,
    SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
    ALLOW_LOCAL_DEVELOPMENT_LOGIN: 'true',
    ALLOW_LOCAL_PASSWORD_LOGIN: 'false',
    LOCAL_LOGIN_EMAIL: 'dev@example.com',
    LOCAL_LOGIN_PASSWORD: '',
    TRUST_PROXY_HOPS: '0',
    CORS_ORIGINS: dashboardBase,
    DASHBOARD_BASE_URL: dashboardBase,
  };
  function startApi() {
    const child = spawnChild(
      ['bun', 'run', '--no-env-file', 'apps/api/src/index.ts'],
      apiEnv,
      'local auto-login API',
    );
    children.push(child);
    return child;
  }
  let api = startApi();
  const dashboard = spawnChild(
    ['bun', 'run', '--no-env-file', 'apps/dashboard/src/server.ts'],
    {
      PORT: String(dashboardPort),
      DASHBOARD_DIST_DIR: join(ROOT, 'apps/dashboard/dist'),
      DASHBOARD_API_BASE_URL: apiBase,
    },
    'local auto-login dashboard',
  );
  children.push(dashboard);
  await waitForHttp(`${apiBase}/healthz`, 'API', api);
  await waitForHttp(`${dashboardBase}/healthz`, 'dashboard', dashboard);
  browser = await chromium.launch();
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const heading = page.getByRole('heading', { name: 'Operational dashboard', exact: true });
      await page.goto(`${dashboardBase}/login`);
      await page.getByLabel('Work email', { exact: true }).fill('dev@example.com');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await heading.waitFor();
      if (await page.locator('input[type=password]').count())
        throw new Error('Routine development requires a password');
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: 963 });
        await page.getByRole('button', { name: /^Account menu/ }).waitFor();
        if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
          throw new Error(`Layout overflows at ${width}`);
      }
      await page.reload();
      await heading.waitFor();
      await page.evaluate(() => {
        const value = JSON.parse(sessionStorage.getItem('sre.localSession')!);
        sessionStorage.setItem(
          'sre.localSession',
          JSON.stringify({ ...value, expiresAt: Date.now() - 1 }),
        );
      });
      await page.reload();
      await heading.waitFor();
      console.log(
        `PASS ${colorScheme}: dev@example.com email-only login, reload, expiry and responsive layout`,
      );

      api.stop();
      await api.process.exited;
      api = startApi();
      await waitForHttp(`${apiBase}/healthz`, 'restarted API', api);
      await page.reload();
      await heading.waitFor().catch(async (error: unknown) => {
        console.error('Restart recovery page:', await page.locator('body').innerText());
        throw error;
      });
      console.log(
        `PASS ${colorScheme}: real API restart invalidates old key and recovers automatically`,
      );

      await page.getByRole('button', { name: /^Account menu/ }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByLabel('Work email', { exact: true }).waitFor();
      await page.reload();
      await page.getByLabel('Work email', { exact: true }).waitFor();
      if (await page.getByLabel('Development mode').count())
        throw new Error('Development mode banner remains');
      await page.getByLabel('Work email', { exact: true }).fill('someone@other.example');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByText(/We could not find company sign-in/).waitFor();
      await page.getByRole('link', { name: 'Create a workspace', exact: true }).click();
      await page.waitForURL('**/get-started');
      await page.goto(`${dashboardBase}/sign-in`);
      await page.getByLabel('Work email', { exact: true }).fill('DEV@example.com');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await heading.waitFor();
      await page.getByRole('button', { name: /^Account menu/ }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByLabel('Work email', { exact: true }).waitFor();
      await page.reload();
      await page.getByLabel('Work email', { exact: true }).waitFor();
      console.log(
        `PASS ${colorScheme}: company discovery for non-dev email, onboarding access, and sign-out stays signed out`,
      );
      await page.goto(`${dashboardBase}/w/incidents`);
      await page.getByLabel('Work email', { exact: true }).fill('dev@example.com');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.waitForURL('**/w/incidents');
      await page.getByRole('heading', { name: 'Incidents', exact: true }).waitFor();
      console.log(`PASS ${colorScheme}: protected deep link is restored after email sign-in`);
      await page.goto(`${dashboardBase}/admin/workspaces`);
      const search = page.getByRole('textbox', { name: 'Search workspaces' });
      await search.fill('unsaved search');
      const input = await search.elementHandle();
      for (let attempt = 0; attempt < 3; attempt++) {
        const revalidated = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/me',
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await revalidated;
        if (!(await input!.evaluate((element) => element.isConnected)))
          throw new Error('Focus revalidation unmounted the workspace page');
        if ((await search.inputValue()) !== 'unsaved search')
          throw new Error('Focus revalidation discarded the workspace search');
      }
      console.log(
        `PASS ${colorScheme}: repeated focus preserves the admin page and unsaved search`,
      );
      if (errors.length) throw new Error(errors.join('\n'));
    } finally {
      await context.close();
    }
  }
  const rejectedHeaders: Record<string, string>[] = [
    { origin: 'https://attacker.test', 'x-sre-local-development': 'true' },
    { origin: dashboardBase, 'x-sre-local-development': 'true', 'x-forwarded-for': '127.0.0.1' },
    { origin: dashboardBase },
  ];
  for (const headers of rejectedHeaders) {
    const response = await fetch(`${apiBase}/auth/local/session`, { method: 'POST', headers });
    if (response.status !== 403)
      throw new Error('Unsafe automatic session request was not rejected');
  }
  console.log('PASS real HTTP boundary rejects cross-site, forwarded and missing-header requests');
} finally {
  try {
    await browser?.close();
  } finally {
    for (const child of children) child.stop();
    try {
      await Promise.all(children.map((child) => child.process.exited));
    } finally {
      await Promise.all([stack.postgres.stop(), stack.valkey.stop()]);
    }
  }
  console.log('Removed isolated development-auth containers and stopped all child processes.');
}
// Bun retains Testcontainers' unref'ed Ryuk socket after successful cleanup.
process.exit(0);
