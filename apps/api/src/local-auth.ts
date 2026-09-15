import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import {
  localDevelopmentLoginOrigin,
  LOCAL_DEVELOPMENT_LOGIN_FLAG,
} from './local-development-auth';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import {
  attachMembership,
  InactiveIdentityError,
  ensureActiveLocalFounding,
  ensureLocalProvider,
  ensureLocalProvisioningFounding,
  ensureLocalProviderBinding,
  getLocalProviderTenant,
  grantPlatformOperator,
  provisionFounding,
  upsertIdentity,
  type Db,
} from '@sre/db';

// Local sessions share durable provisioning and ephemeral signing keys, never production identity.

/** Fixed in code, not env: an operator-tunable issuer is a drift surface with no upside. */
export const LOCAL_ISSUER = 'urn:sre-platform:local-login';
export const LOCAL_AUDIENCE = 'urn:sre-platform:api';
/** Short-lived by design; the signing key is ephemeral, so tokens die with the process anyway. */
export const LOCAL_TOKEN_TTL_SECONDS = 900;
export const MIN_LOCAL_PASSWORD_LENGTH = 12;
/** The env flag, named in every refusal message and in the loud startup log. */
export const LOCAL_LOGIN_FLAG = 'ALLOW_LOCAL_PASSWORD_LOGIN';
const KID = 'local-login';

export interface LocalLoginCredentials {
  email: string;
  password?: string;
}

/**
 * Fail-closed arming decision, mirroring `shouldEnforceRuntimeRole` (packages/db/src/runtime-role.ts):
 * secure by default, armed only on the exact string 'true', refused outright under
 * NODE_ENV=production, and refused when NODE_ENV is unset (an unknown environment is treated as
 * production). Throws rather than returning undefined for every armed-but-invalid case, so a
 * misconfigured host does not boot half-armed.
 */
export function localLoginCredentials(env: NodeJS.ProcessEnv): LocalLoginCredentials | undefined {
  const automatic = localDevelopmentLoginOrigin(env);
  if (env[LOCAL_LOGIN_FLAG] !== 'true' && !automatic) return undefined;
  if (automatic && env[LOCAL_LOGIN_FLAG] !== 'true') {
    if (!env.LOCAL_LOGIN_EMAIL)
      throw new Error(`${LOCAL_DEVELOPMENT_LOGIN_FLAG} requires LOCAL_LOGIN_EMAIL`);
    return { email: env.LOCAL_LOGIN_EMAIL };
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(`${LOCAL_LOGIN_FLAG} must never be set in production`);
  }
  if (!env.NODE_ENV) {
    throw new Error(
      `${LOCAL_LOGIN_FLAG} requires an explicit non-production NODE_ENV; refusing to arm with NODE_ENV unset`,
    );
  }
  const email = env.LOCAL_LOGIN_EMAIL;
  const password = env.LOCAL_LOGIN_PASSWORD;
  if (!email) throw new Error(`${LOCAL_LOGIN_FLAG} is armed but LOCAL_LOGIN_EMAIL is not set`);
  if (!password)
    throw new Error(`${LOCAL_LOGIN_FLAG} is armed but LOCAL_LOGIN_PASSWORD is not set`);
  if (password.length < MIN_LOCAL_PASSWORD_LENGTH) {
    throw new Error(
      `LOCAL_LOGIN_PASSWORD must be at least ${MIN_LOCAL_PASSWORD_LENGTH} characters`,
    );
  }
  return { email, password };
}

/** The armed local-login capability: a verifier for authMiddleware plus a minter for the endpoint. */
export interface LocalLogin {
  issuer: string;
  audience: string;
  /** jose key resolver over the ephemeral public key — the local half of the pinned verifier table. */
  keys: JWTVerifyGetKey;
  email: string;
  passwordEnabled: boolean;
  /** Constant-time credential check; false for both a wrong email and a wrong password. */
  verify(email: string, password: string): boolean;
  mint(maxLifetimeSec: number): Promise<{ token: string; expiresAt: number }>;
}

export interface ArmLocalLoginOptions {
  /** The API audience; the minted token's `aud` must match what authMiddleware enforces. */
  audience: string;
  /** Signing material, generated per boot when omitted. Injectable so tests can forge tokens. */
  privateKey?: CryptoKey;
  jwks?: JSONWebKeySet;
  /** Loud channel for the arming notice; defaults to console.error (the Logger has no warn level). */
  log?: (message: string) => void;
}

async function generateSigningMaterial(): Promise<{
  privateKey: CryptoKey;
  jwks: JSONWebKeySet;
}> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { privateKey, jwks: { keys: [jwk] } };
}

/**
 * Arm local login. The RS256 keypair is generated in-process and never persisted: there is no
 * private-key env var to leak, and every restart invalidates outstanding tokens (page-reload
 * survival is a sessionStorage concern in the dashboard, not a key-lifetime one).
 */
export async function armLocalLogin(
  creds: LocalLoginCredentials,
  opts: ArmLocalLoginOptions,
): Promise<LocalLogin> {
  // Injected material is taken only when both halves are present, since they must be one keypair.
  const { privateKey, jwks } =
    opts.privateKey && opts.jwks
      ? { privateKey: opts.privateKey, jwks: opts.jwks }
      : await generateSigningMaterial();
  // The header kid must name a key in the published set, including when the caller injected one.
  const kid = jwks.keys[0]?.kid ?? KID;

  const log = opts.log ?? ((message: string) => console.error(message));
  log(
    `${creds.password ? LOCAL_LOGIN_FLAG : LOCAL_DEVELOPMENT_LOGIN_FLAG}=true: local login is ARMED for ${creds.email}. ` +
      'This account has workspace owner and platform operator access; dev only.',
  );

  const expected = Buffer.from(creds.password ?? '');
  return {
    issuer: LOCAL_ISSUER,
    audience: opts.audience,
    keys: createLocalJWKSet(jwks),
    email: creds.email,
    passwordEnabled: Boolean(creds.password),
    verify(email, password) {
      if (!creds.password) return false;
      // Length-checked first: timingSafeEqual throws on unequal lengths (same guard as the Slack
      // signature check in surfaces/slack-inbound.ts). Both halves are compared so a wrong email and
      // a wrong password cost the same, and neither is distinguishable from the response.
      const candidate = Buffer.from(password);
      const passwordOk =
        candidate.length === expected.length && timingSafeEqual(candidate, expected);
      const emailOk = email === creds.email;
      return passwordOk && emailOk;
    },
    async mint(maxLifetimeSec) {
      const issuedAt = Math.floor(Date.now() / 1000);
      const expiresAtSeconds = issuedAt + Math.min(LOCAL_TOKEN_TTL_SECONDS, maxLifetimeSec);
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(LOCAL_ISSUER)
        .setAudience(opts.audience)
        // The configured email IS the subject: identity is the (issuer, subject) pair, and this
        // deployment has exactly one local account.
        .setSubject(creds.email)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAtSeconds)
        .sign(privateKey);
      return { token, expiresAt: expiresAtSeconds * 1000 };
    },
  };
}

export interface LocalAuthDeps {
  local: LocalLogin;
  /** Administrator connection for tenant provisioning and the dev-only operator grant. */
  db: Db;
  /** Makes the newly persisted provider visible to ordinary verification immediately. */
  invalidateProviderVerifiers(): void;
  /** Reads the same live lifetime ceiling enforced by bearer-token verification. */
  maxTokenLifetimeSec(): Promise<number>;
  /** Uses the actual socket peer, not a proxy-derived client address. */
  allowAutomaticSession?: (c: Context) => boolean;
}

/**
 * The local sign-in route. Mounted ONLY when local login is armed, so a disarmed deployment answers
 * a real 404 and the auto-provisioning below is unreachable there.
 */
export function localAuthRoutes(deps: LocalAuthDeps): Hono {
  const routes = new Hono();
  const sessionResponse = async (c: Context) => {
    try {
      return c.json(await createLocalSession(deps));
    } catch (error) {
      if (error instanceof InactiveIdentityError)
        return c.json({ error: 'invalid credentials' }, 401);
      throw error;
    }
  };

  if (deps.local.passwordEnabled)
    routes.post('/login', async (c) => {
      const body: unknown = await c.req.json().catch(() => null);
      const input = (body ?? {}) as { email?: unknown; password?: unknown };
      const email = typeof input.email === 'string' ? input.email : '';
      const password = typeof input.password === 'string' ? input.password : '';
      // One generic failure for every rejection: the response must not reveal whether the account
      // exists, so the wrong-email and wrong-password bodies are byte-identical.
      if (!deps.local.verify(email, password)) return c.json({ error: 'invalid credentials' }, 401);

      c.header('Cache-Control', 'no-store');
      return sessionResponse(c);
    });

  if (deps.allowAutomaticSession)
    routes.post('/session', async (c) => {
      c.header('Cache-Control', 'no-store');
      if (!deps.allowAutomaticSession?.(c)) return c.json({ error: 'forbidden' }, 403);
      const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
      if (typeof body?.email !== 'string' || !body.email.trim()) {
        return c.json({ error: 'email_required' }, 400);
      }
      if (body.email.trim().toLowerCase() !== deps.local.email.trim().toLowerCase()) {
        return c.json({ matched: false });
      }
      return sessionResponse(c);
    });

  return routes;
}

/** Both development entry paths use the same durable identity and authorization setup. */
async function createLocalSession(deps: LocalAuthDeps) {
  // Nothing else provisions local dev, so provision both its tenant and platform-wide settings
  // access here. Both writes are idempotent and unreachable in production.
  const identity = {
    issuer: LOCAL_ISSUER,
    subject: deps.local.email,
    email: deps.local.email,
  };
  const userId = await upsertIdentity(deps.db, identity);
  const providerId = await ensureLocalProvider(deps.db, {
    issuer: LOCAL_ISSUER,
    audience: deps.local.audience,
  });
  const existingTenantId = await getLocalProviderTenant(deps.db, LOCAL_ISSUER);
  let tenantId: string;
  if (existingTenantId) {
    tenantId = existingTenantId;
    await attachMembership(deps.db, identity, tenantId);
    await ensureActiveLocalFounding(deps.db, {
      providerId,
      founderUserId: userId,
      tenantId,
      requestedName: `Local dev (${deps.local.email})`,
    });
  } else {
    const founding = await ensureLocalProvisioningFounding(deps.db, {
      providerId,
      founderUserId: userId,
      requestedName: `Local dev (${deps.local.email})`,
    });
    tenantId = (await provisionFounding(deps.db, founding.id)).tenantId;
  }
  await ensureLocalProviderBinding(deps.db, {
    issuer: LOCAL_ISSUER,
    audience: deps.local.audience,
    tenantId,
    userId,
  });
  deps.invalidateProviderVerifiers();
  await grantPlatformOperator(deps.db, userId);

  const { token, expiresAt } = await deps.local.mint(await deps.maxTokenLifetimeSec());
  return { token, expiresAt, email: deps.local.email };
}
