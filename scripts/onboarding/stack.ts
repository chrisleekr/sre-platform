import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { eq } from 'drizzle-orm';
import {
  makeDb,
  makeSecretStore,
  makePlatformSecretStore,
  identityProviderDomains,
  type DbHandle,
} from '../../packages/db/src/index';
import { makeFoundingQueue, makeSnapshotCache } from '../../packages/queue/src/index';
import { PlatformSettings } from '../../packages/platform-settings/src/index';
import { makeNotifier } from '../../packages/notifications/src/index';
import { makeApp } from '../../apps/api/src/app';
import { makeProviderVerifiers } from '../../apps/api/src/auth/providers';
import { makeRevokePublisher } from '../../apps/api/src/auth/revoke';
import type { AuthDeps } from '../../apps/api/src/auth';
import { makeBrowserOidc } from '../../apps/api/src/onboarding/browser-oidc';
import { makeBrowserSessionRuntime } from '../../apps/api/src/onboarding/browser-session-runtime';
import { makeOidcRuntime } from '../../apps/api/src/onboarding/oidc-runtime';
import { makePublicRateLimiter } from '../../apps/api/src/onboarding/rate-limit';
import {
  makeDomainLifecycleCheck,
  makeFoundingDomainLifecycleCheck,
} from '../../apps/api/src/onboarding/domain-notifications';
import { makeDomainVerificationJobHandler } from '../../apps/api/src/onboarding/domain-worker';
import {
  makeFoundingDispatchHandler,
  makeFoundingJobHandler,
  makeTenantPurgeJobHandler,
  startFoundingWorker,
} from '../../apps/api/src/onboarding/founding-worker';
import {
  freePort,
  spawnChild,
  startInfrastructure,
  waitForHttp,
  type Child,
} from '../docs/screenshots/harness';

/** Starts real application infrastructure with only the external directory, DNS and mailbox simulated.
 * @param longValues - Uses valid long directory and mailbox values for responsive acceptance.
 */
export async function startOnboardingStack(longValues = false) {
  const stack = await startInfrastructure();
  const children: Child[] = [];
  const servers: ReturnType<typeof Bun.serve>[] = [];
  let admin: DbHandle | undefined;
  let appDb: DbHandle | undefined;
  let redis: Redis | undefined;
  let settings: PlatformSettings | undefined;
  let worker: Awaited<ReturnType<typeof startFoundingWorker>> | undefined;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    async function settle(operations: Promise<unknown>[]) {
      for (const result of await Promise.allSettled(operations)) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    }
    await settle([Promise.resolve().then(() => worker?.stop())]);
    await settle([
      ...servers.map((server) => Promise.resolve().then(() => server.stop(true))),
      ...children.map((child) => Promise.resolve().then(() => child.stop())),
    ]);
    await settle(children.map((child) => child.process.exited));
    await settle([
      Promise.resolve().then(() => settings?.close()),
      Promise.resolve().then(() => redis?.disconnect()),
      Promise.resolve().then(() => admin?.close()),
      Promise.resolve().then(() => appDb?.close()),
    ]);
    await settle([stack.postgres.stop(), stack.valkey.stop()]);
    if (failures.length) throw new AggregateError(failures, 'Isolated onboarding cleanup failed');
  }
  try {
    admin = makeDb(stack.adminUrl);
    appDb = makeDb(stack.appDbUrl);
    redis = new Redis(stack.valkeyUrl, { maxRetriesPerRequest: null });
    const dashboardUrl = `http://127.0.0.1:${await freePort()}`;
    const apiUrl = `http://127.0.0.1:${await freePort()}`;
    const directoryUrl = `http://127.0.0.1:${await freePort()}`;
    const domain = longValues
      ? `${'engineering'.repeat(5)}.${'operations'.repeat(5)}.example.test`
      : 'team.example.test';
    const issuer = longValues ? `https://directory.${domain}` : 'https://directory.example.test';
    const clientId = 'onboarding-browser';
    const clientSecret = 'isolated-client-secret';
    const keys = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'onboarding', alg: 'RS256' };
    const grants = new Map<string, { nonce: string; challenge: string }>();
    let mailboxCode: string | undefined;
    let verifyEmail = false;
    let dnsPublished = false;
    const directory = Bun.serve({
      hostname: '127.0.0.1',
      port: Number(new URL(directoryUrl).port),
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/mailbox')
          return new Response(
            `Simulated test mailbox: ${mailboxCode ?? 'No verification email received yet.'}`,
          );
        if (url.pathname === '/dns' && request.method === 'POST') {
          dnsPublished = true;
          return Response.json({ published: true });
        }
        if (url.pathname === '/authorize') {
          if (
            url.searchParams.get('client_id') !== clientId ||
            url.searchParams.get('redirect_uri') !== `${dashboardUrl}/auth/callback`
          )
            return new Response('Unexpected client or callback', { status: 400 });
          const code = randomUUID();
          grants.set(code, {
            nonce: url.searchParams.get('nonce')!,
            challenge: url.searchParams.get('code_challenge')!,
          });
          const callback = new URL(`${dashboardUrl}/auth/callback`);
          callback.searchParams.set('state', url.searchParams.get('state')!);
          callback.searchParams.set('code', code);
          return new Response(
            `<html><body><h1>Simulated company sign-in</h1><p>This is an isolated test directory, not a real SSO vendor.</p><a href="${callback.toString().replaceAll('&', '&amp;')}">Sign in as owner@${domain}</a></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        }
        return new Response('Isolated directory controls: GET /mailbox, POST /dns', {
          status: 200,
        });
      },
    });
    servers.push(directory);
    settings = new PlatformSettings(admin.db, redis, {
      env: {
        NODE_ENV: 'test',
        REGISTRATION_MODE: 'open',
        LLM_PROVIDER: 'fake',
      } as NodeJS.ProcessEnv,
    });
    const platformSecrets = makePlatformSecretStore(admin.db, randomBytes(32).toString('base64'));
    const secretStore = makeSecretStore(appDb.db, randomBytes(32).toString('base64'));
    const notifier = makeNotifier({
      db: admin.db,
      appUrl: dashboardUrl,
      email: async () => null,
      log: { error() {} },
    });
    const auth: AuthDeps = {
      db: appDb.db,
      adminDb: admin.db,
      settings,
      verifiers: makeProviderVerifiers(appDb.db),
      revoke: makeRevokePublisher(redis),
    };
    const browserSessions = makeBrowserSessionRuntime({
      db: admin.db,
      auth,
      secrets: platformSecrets,
      dashboardUrl,
      production: false,
      setting: (key) => settings!.get(key),
      email: async () => ({
        send: async ({ text }) => {
          mailboxCode = text.match(/\b\d{8}\b/)?.[0];
        },
      }),
      exchange: makeBrowserOidc(platformSecrets, {
        fetchJson: async () => ({ keys: [jwk] }),
        postForm: async (_url, form) => {
          const grant = grants.get(form.code!);
          if (
            !grant ||
            form.client_id !== clientId ||
            form.client_secret !== clientSecret ||
            createHash('sha256').update(form.code_verifier!).digest('base64url') !== grant.challenge
          )
            throw new Error('Simulated directory rejected the grant');
          grants.delete(form.code!);
          return {
            access_token: 'opaque-upstream-token-not-for-sre-api',
            id_token: await new SignJWT({
              nonce: grant.nonce,
              email: `owner@${domain}`,
              email_verified: verifyEmail,
              sid: 'simulated-session',
            })
              .setProtectedHeader({ alg: 'RS256', kid: 'onboarding' })
              .setSubject('owner-subject')
              .setIssuer(issuer)
              .setAudience(clientId)
              .setIssuedAt()
              .setExpirationTime('5m')
              .sign(keys.privateKey),
          };
        },
      }),
    });
    auth.browserSession = browserSessions.resolve;
    const resolveTxt = async (host: string): Promise<string[][]> => {
      if (!dnsPublished || host !== `_sre-platform.${domain}`) return [];
      const [proof] = await admin!.db
        .select()
        .from(identityProviderDomains)
        .where(eq(identityProviderDomains.domain, domain));
      return proof?.challenge ? [[proof.challenge]] : [];
    };
    const checkDomain = makeDomainLifecycleCheck(admin.db, notifier, resolveTxt);
    const queue = makeFoundingQueue(admin.db, redis);
    worker = await startFoundingWorker(
      queue,
      makeFoundingDispatchHandler(
        makeFoundingJobHandler(admin.db),
        makeDomainVerificationJobHandler({ check: checkDomain }),
        makeTenantPurgeJobHandler(admin.db),
      ),
      {
        db: admin.db,
        pollMs: 50,
        reconcileMs: 500,
        onError: (error) =>
          console.error('onboarding worker:', error instanceof Error ? error.message : 'failed'),
      },
    );
    const oidc = makeOidcRuntime();
    oidc.discover = async (value) => {
      if (value !== issuer) throw new Error('Unknown isolated directory');
      return {
        issuer,
        authorizationEndpoint: `${directoryUrl}/authorize`,
        tokenEndpoint: `${issuer}/token`,
        jwksUri: `${issuer}/jwks`,
      };
    };
    const application = makeApp({
      auth,
      adminDb: admin.db,
      appDb: appDb.db,
      readinessDb: appDb.db,
      secrets: secretStore,
      platformSecrets,
      cache: makeSnapshotCache(redis),
      settings,
      notifier,
      notificationAppUrl: dashboardUrl,
      foundingQueue: queue,
      browserSessions,
      oidc,
      corsOrigins: [dashboardUrl],
      publicRateLimiter: makePublicRateLimiter(redis),
      publicSourceAddress: () => '127.0.0.1',
      registrationMode: () => settings!.get('REGISTRATION_MODE'),
      checkFoundingDomain: makeFoundingDomainLifecycleCheck(admin.db, notifier, resolveTxt),
      checkWorkspaceDomain: checkDomain,
    });
    servers.push(
      Bun.serve({
        hostname: '127.0.0.1',
        port: Number(new URL(apiUrl).port),
        fetch: application.fetch,
      }),
    );
    const dashboard = spawnChild(
      ['bun', 'run', 'apps/dashboard/src/server.ts'],
      {
        PORT: new URL(dashboardUrl).port,
        DASHBOARD_API_BASE_URL: apiUrl,
      },
      'isolated onboarding dashboard',
    );
    children.push(dashboard);
    await waitForHttp(`${dashboardUrl}/healthz`, 'onboarding dashboard', dashboard);
    return {
      dashboardUrl,
      apiUrl,
      directoryUrl,
      issuer,
      domain,
      clientId,
      clientSecret,
      close,
      mailboxCode: () => mailboxCode,
      publishDns: () => {
        dnsPublished = true;
      },
      directoryVerifiesEmail: () => {
        verifyEmail = true;
      },
      db: admin.db,
      platformSecrets,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
