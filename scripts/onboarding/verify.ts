/// <reference lib="dom" />
import { chromium, type Browser, type Page } from 'playwright';
import { count, eq } from 'drizzle-orm';
import { identityProviders, tenants, workspaceFoundings } from '../../packages/db/src/index';
import { startOnboardingStack } from './stack';
import { verifyOnboardingLayout } from './layout';

/** Injects one transient start failure, then returns retries to the real API.
 * @param page - Isolated test browser page.
 */
async function failNextStart(page: Page): Promise<void> {
  await page.route('**/auth/browser/start', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': stack.dashboardUrl,
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify({ error: 'Directory temporarily unavailable' }),
    });
    await page.unroute('**/auth/browser/start');
  });
}

const longValues = process.argv.includes('--long-values');
const stack = await startOnboardingStack(longValues);
let browser: Browser | undefined;
let activePage: Page | undefined;
try {
  console.log(
    JSON.stringify({
      dashboard: stack.dashboardUrl,
      directory: stack.directoryUrl,
      issuer: stack.issuer,
      clientId: stack.clientId,
      testClientSecret: stack.clientSecret,
      workDomain: stack.domain,
      note: 'Isolated simulated directory, mailbox, and DNS. Application API, sessions, database, queue and worker are real.',
    }),
  );
  if (process.argv.includes('--serve')) {
    console.log(
      'Waiting for browser walkthrough. SIGINT or SIGTERM stops this stack and removes both test containers.',
    );
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } else {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(30_000);
    const errors: string[] = [];
    let foundingRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/foundings')
        foundingRequests++;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(stack.dashboardUrl);
    await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Create a workspace', exact: true }).waitFor();
    await verifyOnboardingLayout(page, 'unified entry', 'Continue');
    if (await page.getByLabel('Workspace address', { exact: true }).count())
      throw new Error('Sign-in asks for a workspace address');
    await page.goto(`${stack.dashboardUrl}/sign-in`);
    await page.getByLabel('Work email', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Create a workspace', exact: true }).click();
    await page
      .getByLabel('Workspace name', { exact: true })
      .pressSequentially('Example Operations');
    let slug = await page.getByLabel('Workspace address', { exact: true }).inputValue();
    if (slug !== 'example-operations') throw new Error(`Unexpected suggested address: ${slug}`);
    if (longValues) {
      await page.getByLabel('Workspace address', { exact: true }).fill(slug);
      await page.getByLabel('Workspace name', { exact: true }).fill('Engineering'.repeat(9));
      slug = await page.getByLabel('Workspace address', { exact: true }).inputValue();
    }
    await verifyOnboardingLayout(page, 'workspace details', 'Continue to company sign-in');
    await page.getByRole('button', { name: 'Continue to company sign-in', exact: true }).click();
    await page.getByRole('heading', { name: 'Connect company sign-in' }).waitFor();
    if (new URL(page.url()).pathname !== '/get-started')
      throw new Error('Workspace setup left its canonical URL');
    await page.getByRole('navigation', { name: 'Workspace setup progress' }).waitFor();
    await page.getByLabel('Identity service', { exact: true }).selectOption('other');
    await page.getByRole('button', { name: 'Copy callback URL', exact: true }).click();
    if (
      (await page.evaluate(() => navigator.clipboard.readText())) !==
      `${stack.dashboardUrl}/auth/callback`
    )
      throw new Error('Callback clipboard value did not match the displayed URL');
    await page.getByLabel('Directory URL', { exact: true }).fill(stack.issuer);
    await page.getByLabel('Client ID', { exact: true }).fill(stack.clientId);
    await page.getByLabel('Work email domain', { exact: true }).fill(stack.domain);
    await page.getByLabel('Client secret', { exact: true }).fill(stack.clientSecret);
    await page.getByRole('button', { name: /Back to workspace details/ }).click();
    await page.getByRole('heading', { name: 'Create your workspace' }).waitFor();
    if ((await page.getByLabel('Workspace address', { exact: true }).inputValue()) !== slug)
      throw new Error('Workspace address was lost when going back');
    await page.getByRole('button', { name: 'Continue to company sign-in', exact: true }).click();
    await page.getByRole('heading', { name: 'Connect company sign-in' }).waitFor();
    if ((await page.getByLabel('Client ID', { exact: true }).inputValue()) !== stack.clientId)
      throw new Error('Application details were lost when returning to sign-in setup');
    if (await page.getByLabel('Client secret', { exact: true }).inputValue())
      throw new Error('Client secret persisted after leaving sign-in setup');
    if (Number(foundingRequests) !== 0) throw new Error('Back navigation created a setup request');
    await page.reload();
    if ((await page.getByLabel('Client ID', { exact: true }).inputValue()) !== stack.clientId)
      throw new Error('Non-secret setup was lost on reload');
    if (await page.getByLabel('Client secret', { exact: true }).inputValue())
      throw new Error('Client secret persisted in browser storage');
    await page.getByLabel('Client secret', { exact: true }).fill(`${stack.clientSecret}-incorrect`);
    await verifyOnboardingLayout(page, 'connection details', 'Continue to sign in');
    await page.getByRole('button', { name: 'Continue to sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Simulated company sign-in' }).waitFor();
    await page.getByRole('link', { name: `Sign in as owner@${stack.domain}` }).click();
    await page.waitForURL('**/sign-in');
    await page.getByRole('alert').filter({ hasText: 'Sign-in could not be completed' }).waitFor();
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
    await page.getByRole('heading', { name: 'Connect company sign-in' }).waitFor();
    await page.getByRole('checkbox', { name: 'Replace stored client secret' }).check();
    await page.getByLabel('Client secret', { exact: true }).fill(stack.clientSecret);
    await failNextStart(page);
    await page.getByRole('button', { name: 'Continue to sign in', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'Directory temporarily unavailable' })
      .waitFor();
    await page.reload();
    await page.goto(`${stack.dashboardUrl}/get-started`);
    await page.getByRole('heading', { name: 'Connect company sign-in' }).waitFor();
    await page.getByRole('button', { name: 'Continue to sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Simulated company sign-in' }).waitFor();
    if (foundingRequests !== 1) throw new Error('Start retry recreated the saved workspace setup');
    await page.getByRole('link', { name: `Sign in as owner@${stack.domain}` }).click();
    await page.waitForURL('**/auth/verify-email');
    await page.reload();
    await page.getByText(`o***@${stack.domain}`, { exact: true }).waitFor();
    await failNextStart(page);
    await page.getByRole('button', { name: 'Restart this sign-in', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'Directory temporarily unavailable' })
      .waitFor();
    await page.getByRole('button', { name: 'Retry this sign-in', exact: true }).click();
    await page.getByRole('link', { name: `Sign in as owner@${stack.domain}` }).click();
    await page.waitForURL('**/auth/verify-email');
    await page.getByText(`o***@${stack.domain}`, { exact: true }).waitFor();
    const oldCode = stack.mailboxCode();
    await page
      .getByLabel('Verification code', { exact: true })
      .fill(oldCode === '00000000' ? '11111111' : '00000000');
    await page.getByRole('button', { name: 'Verify email and continue' }).click();
    await page.getByRole('alert').waitFor();
    await verifyOnboardingLayout(
      page,
      'mailbox proof with invalid-code error',
      'Verification code',
      [`o***@${stack.domain}`],
    );
    const resend = page.getByRole('button', { name: /^Send another code/ });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent === 'Send another code' && !button.disabled,
        ),
      undefined,
      { timeout: 70_000 },
    );
    await resend.click();
    await page.getByText('A new code was sent. The previous code no longer works.').waitFor();
    await page.getByLabel('Verification code', { exact: true }).fill(oldCode!);
    await page.getByRole('button', { name: 'Verify email and continue' }).click();
    await page.getByRole('alert').waitFor();
    const code = stack.mailboxCode();
    if (!code) throw new Error('The mailbox verification email was not delivered');
    await page.getByLabel('Verification code', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Verify email and continue' }).click();
    await page.waitForURL('**/get-started');
    await page.reload();
    await page.getByText(stack.domain, { exact: true }).waitFor();
    await page.getByText(stack.issuer, { exact: true }).waitFor();
    await verifyOnboardingLayout(page, 'saved server review', 'Set up workspace', [
      stack.issuer,
      stack.domain,
      `owner@${stack.domain} · Owner`,
    ]);
    await page
      .getByRole('navigation', { name: 'Workspace setup progress' })
      .getByRole('button', { name: 'Company sign-in · Edit' })
      .click();
    await page.getByRole('heading', { name: 'Connect company sign-in' }).waitFor();
    await page.getByRole('checkbox', { name: 'Replace stored client secret' }).check();
    await page.getByLabel('Client secret', { exact: true }).fill(stack.clientSecret);
    await page.getByRole('button', { name: 'Continue to sign in', exact: true }).click();
    await page.getByRole('link', { name: `Sign in as owner@${stack.domain}` }).click();
    await page.waitForURL('**/auth/verify-email');
    await page.getByLabel('Verification code', { exact: true }).fill(stack.mailboxCode()!);
    await page.getByRole('button', { name: 'Verify email and continue' }).click();
    await page.waitForURL('**/get-started');
    if (foundingRequests !== 1) throw new Error('Editing from review created a duplicate setup');
    await page.getByRole('button', { name: 'Set up workspace', exact: true }).click();
    await page.waitForURL('**/w');
    await page.reload();
    await verifyOnboardingLayout(
      page,
      'provisioned workspace checklist',
      'Verify domain',
      ['Finish setting up your workspace'],
      false,
    );
    const workspaceName = longValues ? 'Engineering'.repeat(9) : 'Example Operations';
    await stack.db
      .update(workspaceFoundings)
      .set({ expiresAt: new Date(Date.now() - 3600000) })
      .where(eq(workspaceFoundings.slug, slug));
    const signedOutBeforeDns = await page.evaluate(
      async (api) =>
        (
          await fetch(`${api}/auth/browser/logout`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'x-sre-session': '1' },
          })
        ).status,
      stack.apiUrl,
    );
    if (signedOutBeforeDns !== 200) throw new Error('Pre-DNS logout failed');
    await page.goto(`${stack.dashboardUrl}/sign-in`);
    await page.getByLabel('Work email', { exact: true }).fill(`owner@${stack.domain}`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('link', { name: `Sign in as owner@${stack.domain}` }).click();
    await page.waitForURL('**/auth/verify-email');
    await page.getByLabel('Verification code', { exact: true }).fill(stack.mailboxCode()!);
    await page.getByRole('button', { name: 'Verify email and continue' }).click();
    await page.waitForURL('**/w');
    console.log(
      'PASS: founder returns through Work email after logout while DNS remains unverified',
    );
    await page.reload();
    await page.getByRole('link', { name: 'Verify domain', exact: true }).click();
    await page.getByRole('heading', { name: 'Verify your domain' }).waitFor();
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.getByRole('status').filter({ hasText: 'not visible yet' }).waitFor();
    await verifyOnboardingLayout(
      page,
      'pending DNS with unsuccessful check',
      'Check now',
      ['Verify your domain', stack.domain],
      false,
    );
    stack.publishDns();
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.getByRole('link', { name: 'Open workspace' }).waitFor();
    await verifyOnboardingLayout(
      page,
      'verified DNS',
      'Open workspace',
      ['Verify your domain', stack.domain],
      false,
    );
    await page.getByRole('link', { name: 'Open workspace' }).click();
    await page.waitForURL('**/w');
    await page.reload();
    await page.getByRole('heading', { name: 'Operational dashboard', exact: true }).waitFor();
    if (await page.getByRole('link', { name: 'Verify domain', exact: true }).count())
      throw new Error('The workspace checklist did not reflect the verified domain');
    const stored = await page.evaluate(() => ({
      local: { ...localStorage },
      tab: { ...sessionStorage },
    }));
    if (
      JSON.stringify(stored).includes('opaque-upstream-token') ||
      JSON.stringify(stored).includes(stack.clientSecret)
    )
      throw new Error('Upstream credentials leaked into browser storage');
    const [workspaceCount] = await stack.db
      .select({ value: count() })
      .from(tenants)
      .where(eq(tenants.slug, slug));
    const [providerCount] = await stack.db
      .select({ value: count() })
      .from(identityProviders)
      .where(eq(identityProviders.browserClientId, stack.clientId));
    const [foundingCount] = await stack.db
      .select({ value: count() })
      .from(workspaceFoundings)
      .where(eq(workspaceFoundings.slug, slug));
    if (workspaceCount?.value !== 1 || providerCount?.value !== 1 || foundingCount?.value !== 1)
      throw new Error('Setup created duplicate durable records');
    const logout = await page.evaluate(async (api) => {
      const response = await fetch(`${api}/auth/browser/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-sre-session': '1' },
      });
      return response.status;
    }, stack.apiUrl);
    if (logout !== 200) throw new Error(`Logout failed: ${logout}`);
    let releaseHydration!: () => void;
    const hydrationGate = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    await page.route('**/auth/browser/session', async (route) => {
      const response = await route.fetch();
      await hydrationGate;
      await route.fulfill({ response });
      await page.unroute('**/auth/browser/session');
    });
    await failNextStart(page);
    await page.goto(`${stack.dashboardUrl}/${slug}`);
    await page
      .getByRole('alert')
      .filter({ hasText: 'Directory temporarily unavailable' })
      .waitFor();
    const lateHydration = page.waitForResponse('**/auth/browser/session');
    releaseHydration();
    await lateHydration;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page
      .getByRole('alert')
      .filter({ hasText: 'Directory temporarily unavailable' })
      .waitFor();
    await page.getByRole('button', { name: 'Retry this sign-in', exact: true }).click();
    await page.getByRole('link', { name: `Sign in as owner@${stack.domain}` }).click();
    await page.waitForURL('**/auth/verify-email');
    await page.getByLabel('Verification code', { exact: true }).fill(stack.mailboxCode()!);
    await page.getByRole('button', { name: 'Verify email and continue' }).click();
    await page.waitForURL('**/w');
    await page.reload();
    await page.waitForURL('**/w');
    await page.getByRole('heading', { name: 'Operational dashboard', exact: true }).waitFor();
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    await page.goto(`${stack.dashboardUrl}/w/select?switch=true`);
    await page.getByRole('heading', { name: 'Choose a workspace', exact: true }).waitFor();
    await verifyOnboardingLayout(page, 'authenticated workspace chooser', `Open ${workspaceName}`);
    await page.getByRole('link', { name: `Open ${workspaceName}`, exact: true }).click();
    await page.getByRole('heading', { name: 'Operational dashboard', exact: true }).waitFor();
    await page.goto(`${stack.dashboardUrl}/w/select?switch=true`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Work email', { exact: true }).fill(`owner@${stack.domain}`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('link', { name: `Sign in as owner@${stack.domain}` }).click();
    await page.waitForURL('**/auth/verify-email');
    await page.getByLabel('Verification code', { exact: true }).fill(stack.mailboxCode()!);
    await page.getByRole('button', { name: 'Verify email and continue' }).click();
    await page.getByRole('heading', { name: 'Operational dashboard', exact: true }).waitFor();
    if (new URL(page.url()).pathname !== '/w')
      throw new Error('Email sign-in did not open the sole authorized workspace');
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    console.log(
      'PASS: authenticated workspace chooser, account change, and email-first returning sign-in.',
    );
    console.log(
      'PASS: real HTTP signup, mailbox proof, review, provisioning worker, DNS activation, logout, returning login, reload, durable uniqueness, and responsive layouts. Start failure recovery passed for saved setup/reload, mailbox restart, and returning workspace. Directory, SMTP and DNS were simulated; one transient start failure per recovery path was injected.',
    );
  }
} catch (error) {
  if (activePage)
    console.error(
      'Isolated browser failure:',
      activePage.url(),
      await activePage.locator('body').innerText(),
    );
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    await stack.close();
  }
  console.log('Removed isolated onboarding containers and stopped all child processes.');
}
// Bun retains the library's unref'ed Ryuk socket after cleanup. Exit only this completed CLI.
process.exit(0);
