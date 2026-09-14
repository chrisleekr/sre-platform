#!/usr/bin/env bun
/**
 * Regenerate dashboard screenshots, optionally selecting one guide.
 * Disposable containers and explicit child URLs isolate the developer database.
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { Redis } from 'ioredis';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  incidents,
  identityProviderDomains,
  identityProviders,
  makeDb,
  makeSecretStore,
  tenants,
  tenantIdentityBindings,
  users,
  withTenant,
} from '../../../packages/db/src/index';
import { Queue, makeSnapshotCache } from '../../../packages/queue/src/index';
import { eq } from 'drizzle-orm';
import { seedDemoData } from './demo-data';
import { captureFullPage } from './full-page';
import { prepareTopologyCapture } from './topology-capture';
import * as incidentCapture from './incident-capture';
import { screenshotPlan, WIZARDS, type Shot, type Wizard } from './shots';
import {
  ROOT,
  freePort,
  log,
  spawnChild,
  startInfrastructure,
  waitForHttp,
  type Child,
} from './harness';

const OUT = join(ROOT, 'docs', 'assets', 'screenshots');
const STAGE = join(ROOT, 'docs', 'assets', '.screenshots-staging');
const capturePlan = screenshotPlan(process.argv.slice(2));
const TOPOLOGY_ONLY = capturePlan.only === 'topology';
const INCIDENT_ONLY = capturePlan.only === 'incident';

const LOGIN_EMAIL = 'dev@example.test';
const LOGIN_PASSWORD = 'documentation-demo-password';
/** Matches `local-session.ts`; the capture restores a session instead of typing into the form. */
const SESSION_KEY = 'sre.localSession';
const THEME_KEY = 'sre-platform-theme';
const NOW = new Date();
// Allow loaded development machines time to render before actions time out.
const ACTION_TIMEOUT_MS = 90_000;

interface Session {
  token: string;
  expiresAt: number;
  email: string;
}

/** Signs in once through the real endpoint, which also provisions the demo tenant. */
async function signIn(apiBase: string, api: Child): Promise<Session> {
  const response = await fetch(`${apiBase}/auth/local/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  if (!response.ok) {
    // Include the disposable API's log so sign-in failures are diagnosable.
    const body = await response.text().catch(() => '');
    throw new Error(
      `local sign-in failed: ${response.status} ${body.slice(0, 500)}\n\n${api.label} output:\n${api.output().trim()}`,
    );
  }
  return (await response.json()) as Session;
}

async function capture(
  context: BrowserContext,
  dashboardBase: string,
  incidentId: string,
  theme: 'light' | 'dark',
  shots: Shot[],
  sizeName: string,
): Promise<void> {
  const page = await incidentCapture.createPage(context);
  for (const shot of shots) {
    const path = shot.path.replace(':incident', incidentId);
    if (shot.sessionStorage) {
      await page.goto(dashboardBase, { waitUntil: 'load' });
      await page.evaluate((entries) => {
        for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
      }, shot.sessionStorage);
    }
    await page.goto(`${dashboardBase}${path}`, { waitUntil: 'load' });
    await page.waitForSelector(shot.waitFor, { state: 'visible', timeout: 20_000 });
    if (shot.expectedHeading) {
      await page
        .getByRole('heading', { name: shot.expectedHeading, exact: true })
        .waitFor({ state: 'visible', timeout: 20_000 });
    }
    if (shot.topology) {
      await prepareTopologyCapture(page, shot.topology);
    } else if (shot.file.startsWith('incident-detail')) {
      await incidentCapture.prepareIncidentCapture(page);
    } else await page.waitForTimeout(600);
    if (shot.click && (!shot.clickSizes || shot.clickSizes.includes(sizeName))) {
      await page.getByRole('button', { name: shot.click }).click();
      await page.waitForTimeout(1_200);
    }
    const sizeSuffix = sizeName === 'desktop' ? '' : `-${sizeName}`;
    const file = join(STAGE, `${shot.file}${sizeSuffix}-${theme}.png`);
    if (shot.incidentInspector) await incidentCapture.captureIncidentInspector(page, file);
    else await captureFullPage(page, file);
    log(`  ${theme}  ${shot.file}`);
  }
  await page.close();
}

/** Index of the step the wizard is currently on, from its own progress bar. */
async function activeStep(dialog: Locator): Promise<number> {
  const items = dialog.getByRole('list', { name: 'Setup progress' }).getByRole('listitem');
  const total = await items.count();
  for (let index = 0; index < total; index += 1) {
    if ((await items.nth(index).getAttribute('aria-current')) === 'step') return index;
  }
  return -1;
}

/**
 * Walks one connect wizard, writing an image per step.
 *
 * The walk stops before Save and verify in every wizard, so it never submits a form and never
 * reaches a third-party system. A step that cannot be driven fails the run rather than silently
 * writing the previous step's image under the next step's name.
 */
async function captureWizard(
  page: Page,
  dashboardBase: string,
  theme: 'light' | 'dark',
  wizard: Wizard,
): Promise<void> {
  for (const stub of wizard.intercept ?? []) {
    await page.route(
      (url) => url.pathname.endsWith(stub.url),
      (route) => {
        // A dashboard route can share a path with the control-plane endpoint behind it. Only the
        // data request is answered here; the page's own document still loads normally.
        if (route.request().resourceType() === 'document') return route.fallback();
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          // The dashboard and the API are served from different ports, so a fulfilled response
          // still has to satisfy the browser's cross-origin check or the fetch simply fails.
          headers: {
            'access-control-allow-origin': dashboardBase,
            'access-control-allow-credentials': 'true',
            'access-control-allow-headers':
              'content-type, authorization, x-sre-session, x-sre-session-id',
            'access-control-allow-methods': 'POST, OPTIONS',
          },
          body: JSON.stringify(stub.json),
        });
      },
    );
  }

  await page.goto(`${dashboardBase}${wizard.route ?? '/w/connectors?view=catalog'}`, {
    waitUntil: 'load',
  });
  await page.waitForSelector('main', { state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(600);
  await page
    .getByRole('button', { name: wizard.open, exact: true })
    .or(
      page.getByRole('button', { name: wizard.open.replace(/^Add /, 'Add another '), exact: true }),
    )
    .first()
    .click();

  const dialog = page.locator('dialog[open]');
  await dialog.waitFor({ state: 'visible', timeout: 20_000 });

  // The product's own progress bar is the authority on what the steps are called. Comparing it
  // here is what keeps the written guide honest: rename a step and this run stops.
  const rendered = (
    await dialog.getByRole('list', { name: 'Setup progress' }).getByRole('listitem').allInnerTexts()
  ).map((text) => text.replace(/^[0-9✓]+\s*/, '').trim());
  if (rendered.join(' | ') !== wizard.names.join(' | ')) {
    throw new Error(
      `${wizard.open}: wizard steps changed.\n  documented: ${wizard.names.join(' | ')}\n  rendered:   ${rendered.join(' | ')}`,
    );
  }

  for (const step of wizard.steps) {
    // Selections come first: a radio often decides which fields exist at all.
    for (const name of step.choose ?? []) {
      await dialog.getByRole('radio', { name }).first().check();
    }
    if (step.waitFor)
      await page.waitForSelector(step.waitFor, { state: 'visible', timeout: 20_000 });
    for (const [label, value] of step.fill ?? []) {
      // Labels are matched loosely, because several wrap a hint span that becomes part of the
      // accessible name. Loose matching can otherwise land on a radio whose long label happens to
      // contain the same word, so restrict it to what can actually hold text.
      await dialog
        .getByLabel(label, { exact: false })
        .and(dialog.locator('input:not([type="radio"]):not([type="checkbox"]), textarea'))
        .first()
        .fill(value);
    }
    await page.waitForTimeout(400);

    await captureFullPage(page, join(STAGE, `${step.file}-${theme}.png`));
    log(`  ${theme}  ${step.file}`);

    if (!step.advance) break;
    const before = await activeStep(dialog);
    await dialog.getByRole('button', { name: step.advance, exact: true }).first().click();
    await page.waitForTimeout(800);

    // The wizard staying put is the failure that matters: the walk would then capture the same
    // screen twice under two different names. Alerts alone are not the signal, because some steps
    // legitimately warn (a missing Slack connection) while still advancing.
    const after = await activeStep(dialog);
    if (after !== before + 1) {
      const alert = dialog.getByRole('alert');
      const said =
        (await alert.count()) > 0 ? ` The wizard said "${await alert.first().innerText()}".` : '';
      throw new Error(
        `${wizard.open}: "${step.advance}" did not leave step ${before + 1} of "${step.file}".${said}`,
      );
    }
  }
  await page.keyboard.press('Escape');
  // The page is reused across wizards, so this wizard's stubs must not outlive it.
  if (wizard.intercept) await page.unrouteAll({ behavior: 'ignoreErrors' });
}

async function captureAll(
  browser: Browser,
  dashboardBase: string,
  session: Session,
  incidentId: string,
): Promise<void> {
  for (const size of capturePlan.matrix) {
    const signedIn = size.shots.filter((shot) => !shot.anonymous);
    const signedOut = size.shots.filter((shot) => shot.anonymous);
    for (const theme of size.themes) {
      // A signed-out context for the sign-in screen: with a session in storage the router sends
      // /login straight to the dashboard, and the shot would silently duplicate the overview.
      const anonymous = await browser.newContext({
        viewport: size.viewport,
        deviceScaleFactor: 2,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await anonymous.addInitScript(
        ([themeKey, themeValue]: string[]) => {
          const global = globalThis as unknown as {
            localStorage?: { setItem(name: string, value: string): void };
          };
          try {
            global.localStorage?.setItem(themeKey!, themeValue!);
          } catch {
            // A storage-less context falls back to the system theme.
          }
        },
        [THEME_KEY, theme],
      );
      anonymous.setDefaultTimeout(ACTION_TIMEOUT_MS);
      await capture(anonymous, dashboardBase, incidentId, theme, signedOut, size.name);
      await anonymous.close();

      // The session and the theme are seeded before any script runs, so no shot ever catches the
      // login redirect or a theme flip mid-render.
      const context = await browser.newContext({
        viewport: size.viewport,
        deviceScaleFactor: 2,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await context.addInitScript(
        ([key, value, themeKey, themeValue]: string[]) => {
          // Typed inline: this function is serialised into the page, where the DOM lib is not in
          // scope for the compiler that checks this file.
          const global = globalThis as unknown as {
            sessionStorage?: { setItem(name: string, value: string): void };
            localStorage?: { setItem(name: string, value: string): void };
          };
          try {
            global.sessionStorage?.setItem(key!, value!);
            global.localStorage?.setItem(themeKey!, themeValue!);
          } catch {
            // A storage-less context simply renders signed out.
          }
        },
        [SESSION_KEY, JSON.stringify(session), THEME_KEY, theme],
      );
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      await capture(context, dashboardBase, incidentId, theme, signedIn, size.name);

      if (size.name === 'desktop' && !TOPOLOGY_ONLY && !INCIDENT_ONLY) {
        const wizardPage = await context.newPage();
        for (const wizard of WIZARDS) await captureWizard(wizardPage, dashboardBase, theme, wizard);
        await wizardPage.close();
      }

      await context.close();
    }
  }
}

async function main(): Promise<void> {
  const stack = await startInfrastructure();
  const children: Child[] = [];
  let browser: Browser | undefined;
  let redis: Redis | undefined;
  let appDb: ReturnType<typeof makeDb> | undefined;
  let adminDb: ReturnType<typeof makeDb> | undefined;

  try {
    const apiPort = await freePort();
    const dashboardPort = await freePort();
    const apiBase = `http://127.0.0.1:${apiPort}`;
    const dashboardBase = `http://127.0.0.1:${dashboardPort}`;

    // The seed and API must share the credential encryption key.
    const masterKey = randomBytes(32).toString('base64');
    const apiEnv: Record<string, string> = {
      NODE_ENV: 'development',
      PORT: String(apiPort),
      DATABASE_URL: stack.adminUrl,
      APP_DATABASE_URL: stack.appDbUrl,
      APP_DB_PASSWORD: 'app',
      VALKEY_URL: stack.valkeyUrl,
      SECRETS_MASTER_KEY: masterKey,
      // No Auth0 tenant is involved; the local password issuer is the only one that mints a token
      // here. The value must still be present because the API validates its configuration at boot.
      AUTH0_ISSUER: 'https://screenshots.invalid/',
      AUTH0_AUDIENCE: 'https://api.sre-platform/',
      AUTH0_JWKS_URI: 'https://screenshots.invalid/.well-known/jwks.json',
      ALLOW_LOCAL_PASSWORD_LOGIN: 'true',
      LOCAL_LOGIN_EMAIL: LOGIN_EMAIL,
      LOCAL_LOGIN_PASSWORD: LOGIN_PASSWORD,
      CORS_ORIGINS: dashboardBase,
      DASHBOARD_BASE_URL: dashboardBase,
    };

    log('building the dashboard');
    const build = Bun.spawn(['bun', 'run', '--filter', '@sre/dashboard', 'build'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if ((await build.exited) !== 0) {
      throw new Error(await new Response(build.stderr).text());
    }

    log('starting the API and the dashboard');
    const api = spawnChild(['bun', 'run', 'apps/api/src/index.ts'], apiEnv, 'api');
    children.push(api);
    const dashboard = spawnChild(
      ['bun', 'run', 'apps/dashboard/src/server.ts'],
      {
        PORT: String(dashboardPort),
        DASHBOARD_DIST_DIR: join(ROOT, 'apps', 'dashboard', 'dist'),
        DASHBOARD_API_BASE_URL: apiBase,
      },
      'dashboard',
    );
    children.push(dashboard);
    await waitForHttp(`${apiBase}/healthz`, 'api', api);
    await waitForHttp(`${dashboardBase}/healthz`, 'dashboard', dashboard);

    // Signing in is what provisions the tenant, so it has to happen before the seed.
    const session = await signIn(apiBase, api);
    adminDb = makeDb(stack.adminUrl);
    const [tenant] = await adminDb.db.select({ id: tenants.id }).from(tenants).limit(1);
    if (!tenant) throw new Error('sign-in did not provision a tenant');
    const [user] = await adminDb.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, LOGIN_EMAIL))
      .limit(1);
    if (!user) throw new Error('sign-in did not provision a user');
    const [binding] = await adminDb.db
      .select({ providerId: tenantIdentityBindings.providerId })
      .from(tenantIdentityBindings)
      .where(eq(tenantIdentityBindings.tenantId, tenant.id))
      .limit(1);
    if (!binding) throw new Error('sign-in did not bind an identity method');
    const screenshotProviders = [
      {
        id: randomUUID(),
        displayName: 'Company sign-in',
        issuer: 'https://identity-one.example.test/',
      },
      {
        id: randomUUID(),
        displayName: 'Backup sign-in',
        issuer: 'https://identity-two.example.test/',
      },
    ];
    await adminDb.db.insert(identityProviders).values(
      screenshotProviders.map((provider) => ({
        ...provider,
        jwksUri: `${provider.issuer}.well-known/jwks.json`,
        authorizationEndpoint: `${provider.issuer}authorize`,
        tokenEndpoint: `${provider.issuer}token`,
        audience: 'https://api.sre-platform/',
        browserClientId: `${provider.id}-browser`,
        kind: 'oidc' as const,
        scope: 'tenant' as const,
        status: 'active' as const,
      })),
    );
    await adminDb.db.insert(tenantIdentityBindings).values(
      screenshotProviders.map((provider) => ({
        tenantId: tenant.id,
        providerId: provider.id,
        claimValue: null,
      })),
    );
    await adminDb.db.insert(identityProviderDomains).values({
      providerId: binding.providerId,
      domain: 'example.test',
      status: 'pending',
      challenge: 'sre-platform-verification-example',
      lastCheckedAt: NOW,
    });

    log('seeding the demo tenant');
    appDb = makeDb(stack.appDbUrl);
    redis = new Redis(stack.valkeyUrl, { maxRetriesPerRequest: null });
    const queue = new Queue(appDb.db, redis);
    await seedDemoData({
      appDb: appDb.db,
      adminDb: adminDb.db,
      queue,
      cache: makeSnapshotCache(redis),
      secrets: makeSecretStore(appDb.db, masterKey),
      tenantId: tenant.id,
      userId: user.id,
      now: NOW,
    });

    const [lead] = await withTenant(appDb.db, tenant.id, (tx) =>
      tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.fingerprint, 'demo-checkout-latency'))
        .limit(1),
    );
    if (!lead) throw new Error('the demo incident was not seeded');

    const dismissed = await fetch(`${apiBase}/me/welcome/dismiss`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (!dismissed.ok) throw new Error(`welcome dismissal failed with ${dismissed.status}`);

    log('capturing');
    // Swap the staging directory in only after every capture succeeds, so a failed run cannot
    // leave committed documentation pointing at an empty output directory.
    rmSync(STAGE, { recursive: true, force: true });
    mkdirSync(STAGE, { recursive: true });
    browser = await chromium.launch();
    await captureAll(browser, dashboardBase, session, lead.id);
    if (TOPOLOGY_ONLY || INCIDENT_ONLY) {
      // Publish only the requested images after the entire four-viewport/theme matrix succeeds.
      for (const file of readdirSync(STAGE)) renameSync(join(STAGE, file), join(OUT, file));
      log(`updated ${INCIDENT_ONLY ? 'incident' : 'topology'} screenshots only`);
      return;
    }
    // The README hero is hand-authored and must survive screenshot regeneration.
    const hero = join(OUT, 'hero-pure.svg');
    if (existsSync(hero)) copyFileSync(hero, join(STAGE, 'hero-pure.svg'));
    rmSync(OUT, { recursive: true, force: true });
    renameSync(STAGE, OUT);
    const written = readdirSync(OUT).filter((file) => file.endsWith('.png')).length;
    log(`wrote ${written} screenshots to docs/assets/screenshots`);
  } finally {
    // A failed run must leave nothing behind: staging is untracked, so a leftover half-capture
    // would otherwise be swept into the next `git add -A`.
    rmSync(STAGE, { recursive: true, force: true });
    await browser?.close();
    for (const child of children) child.stop();
    await appDb?.close();
    await adminDb?.close();
    redis?.disconnect();
    await Promise.allSettled([stack.postgres.stop(), stack.valkey.stop()]);
  }
}

await main();

// Testcontainers keeps its reaper socket open after resources are released.
process.exit(0);
