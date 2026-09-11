import { chromium } from 'playwright';
import { count } from 'drizzle-orm';
import {
  ensureStaffProvider,
  grantPlatformOperator,
  upsertIdentity,
  tenants,
  memberships,
  workspaceFoundings,
} from '../../packages/db/src/index';
import { startOnboardingStack } from './stack';

const stack = await startOnboardingStack();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const provider = await ensureStaffProvider(
    stack.db,
    {
      displayName: 'Staff sign-in',
      issuer: stack.issuer,
      browserClientId: stack.clientId,
      clientAuthentication: 'client_secret_post',
      emailClaim: 'email',
    },
    async () => ({
      authorizationEndpoint: `${stack.directoryUrl}/authorize`,
      tokenEndpoint: `${stack.issuer}/token`,
      jwksUri: `${stack.issuer}/jwks`,
    }),
  );
  await stack.platformSecrets.put(`oidc-client:${provider.id}`, stack.clientSecret);
  const userId = await upsertIdentity(stack.db, {
    issuer: stack.issuer,
    subject: 'owner-subject',
    email: `owner@${stack.domain}`,
  });
  await grantPlatformOperator(stack.db, userId);
  stack.directoryVerifiesEmail();
  browser = await chromium.launch();
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(stack.dashboardUrl);
      await page.getByLabel('Work email', { exact: true }).waitFor();
      if (await page.getByRole('button', { name: 'Continue with Staff sign-in' }).count())
        throw new Error('Provider shortcut bypasses the email-first entry page');
      await page.getByLabel('Work email', { exact: true }).fill(`owner@${stack.domain}`);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('link', { name: `Sign in as owner@${stack.domain}` }).click();
      await page.waitForURL('**/admin');
      await page.getByRole('heading', { name: 'Registrations', exact: true }).waitFor();
      await page.getByText('No workspace registrations need review.').waitFor();
      const meResponse = await context.request.get(`${stack.apiUrl}/me`);
      const me = await meResponse.json();
      if (!meResponse.ok() || !me.user.isPlatformAdmin || me.tenant || me.workspaces.length)
        throw new Error('Staff sign-in did not produce a workspace-independent operator session');
      if (errors.length) throw new Error(errors.join('\n'));
      console.log(
        `PASS operator email-first sign-in in ${colorScheme} mode reaches administration without onboarding`,
      );
    } finally {
      await context.close();
    }
  }
  const [workspaceCount] = await stack.db.select({ value: count() }).from(tenants);
  const [foundingCount] = await stack.db.select({ value: count() }).from(workspaceFoundings);
  if (workspaceCount?.value || foundingCount?.value)
    throw new Error('Operator login created a workspace or founding');
  const workspaceId = crypto.randomUUID();
  const directoryWorkspaceId = crypto.randomUUID();
  const secondWorkspaceId = crypto.randomUUID();
  await stack.db.insert(tenants).values([
    { id: workspaceId, name: 'Operations', slug: 'operations' },
    { id: secondWorkspaceId, name: 'Analytics', slug: 'analytics' },
    {
      id: directoryWorkspaceId,
      name: 'Customer-facing services and infrastructure engineering',
      slug: 'engineering',
      requireDirectory: true,
    },
  ]);
  await stack.db.insert(memberships).values(
    [workspaceId, directoryWorkspaceId, secondWorkspaceId].map((tenantId) => ({
      userId,
      tenantId,
      role: 'member' as const,
    })),
  );
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(stack.dashboardUrl);
      await page.getByLabel('Work email', { exact: true }).fill(`owner@${stack.domain}`);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('link', { name: `Sign in as owner@${stack.domain}` }).click();
      await page.waitForURL('**/w/select');
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: 963 });
        await page.getByRole('button', { name: 'Open Operations', exact: true }).waitFor();
        await page.getByRole('link', { name: /Platform administration/ }).waitFor();
        if (
          await page
            .getByRole('link', {
              name: 'Open Customer-facing services and infrastructure engineering',
              exact: true,
            })
            .count()
        )
          throw new Error('Directory-required workspace offered an unconfigured sign-in');
        if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
          throw new Error(`Workspace chooser overflows at ${width}px`);
      }
      await page.getByRole('button', { name: 'Open Operations', exact: true }).click();
      await page.waitForURL('**/w');
      await page.getByRole('heading', { name: 'Operational dashboard', exact: true }).waitFor();
      await page.reload();
      await page.getByRole('heading', { name: 'Operational dashboard', exact: true }).waitFor();
      const response = await context.request.get(`${stack.apiUrl}/me`);
      const me = await response.json();
      if (
        !response.ok() ||
        me.state !== 'active' ||
        me.tenant?.id !== workspaceId ||
        me.tenant.role !== 'member'
      )
        throw new Error('Existing membership did not produce a durable member workspace session');
      if (errors.length) throw new Error(errors.join('\n'));
      const staleTab = await context.newPage();
      await staleTab.goto(`${stack.dashboardUrl}/w`);
      await staleTab.getByRole('heading', { name: 'Operational dashboard', exact: true }).waitFor();
      const original = await (
        await context.request.get(`${stack.apiUrl}/auth/browser/session`)
      ).json();
      await page.goto(`${stack.dashboardUrl}/w/select?switch=true`);
      await page.getByRole('button', { name: 'Open Analytics', exact: true }).click();
      await page.getByRole('heading', { name: 'Operational dashboard', exact: true }).waitFor();
      const denied = staleTab.waitForResponse((result) => result.url() === `${stack.apiUrl}/me`);
      await staleTab.evaluate(() => window.dispatchEvent(new Event('focus')));
      const staleResponse = await denied;
      if (
        staleResponse.status() !== 401 ||
        staleResponse.request().headers()['x-sre-session-id'] !== original.sessionId
      )
        throw new Error('A stale tab did not retain and reject its original session');
      await staleTab.goto(`${stack.dashboardUrl}/w`);
      await staleTab.getByRole('heading', { name: 'Operational dashboard', exact: true }).waitFor();
      await staleTab.close();
      console.log(
        `PASS membership selection in ${colorScheme}, 390/768/1440px, dashboard, reload and stale-tab rejection`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    await stack.close();
  }
  console.log('Removed isolated staff sign-in containers and stopped all child processes.');
}
process.exit(0);
