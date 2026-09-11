import type { Db } from './client';
import { makeDb } from './client';
import { adminUrl } from './env';
import { fetchPinnedHttps } from '@sre/connectors';
import {
  ensureStaffProvider,
  type StaffProviderMetadata,
  type StaffProviderInput,
  type StaffProviderResult,
} from './identity-provider-staff-repo';
import { grantPlatformOperator, insertAdminInvitation, upsertIdentity } from './identity-repo';
import { makePlatformSecretStore } from './platform-secret-store';
import { identityProviders } from './schema';
import { eq } from 'drizzle-orm';

export type BootstrapAdmin = { subject: string; email?: string } | { email: string };

export interface BootstrapInput {
  staffProvider: StaffProviderInput;
  admins: BootstrapAdmin[];
  credential?: { clientSecret: string; masterKey: string };
}

export type BootstrapAdminReport =
  | {
      kind: 'granted';
      subject: string;
      userId: string;
      operator: 'granted' | 'already granted';
    }
  | {
      kind: 'invited';
      email: string;
      invitation: 'created' | 'already present';
    };

export interface BootstrapReport {
  provider: StaffProviderResult;
  admins: BootstrapAdminReport[];
}

type Discovery = (issuer: string) => Promise<unknown>;

const PROVIDER_KEYS = [
  'displayName',
  'issuer',
  'browserClientId',
  'audience',
  'emailClaim',
  'jwksUri',
  'clientAuthentication',
] as const;
const ADMIN_KEYS = ['subject', 'email'] as const;
const BOOTSTRAP_LOCK_KEY = 'sre:bootstrap';
const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_MAX_BYTES = 64 * 1024;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function parseJson(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${name}: not valid JSON`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Invalid ${location}: unexpected key "${key}"`);
  }
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${location}: expected a non-empty string`);
  }
  if (hasControlCharacter(value)) {
    throw new Error(`Invalid ${location}: control characters are not allowed`);
  }
  return value.trim();
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  location: string,
): string | undefined {
  if (!(key in value)) return undefined;
  return nonEmptyString(value[key], `${location}.${key}`);
}

function isValidHttpsUrl(value: string, options: { allowQuery: boolean }): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (options.allowQuery || !url.search)
    );
  } catch {
    return false;
  }
}

function parseStaffProvider(raw: string): StaffProviderInput {
  const decoded = parseJson(raw, 'BOOTSTRAP_STAFF_PROVIDER');
  if (!isObject(decoded)) {
    throw new Error('Invalid BOOTSTRAP_STAFF_PROVIDER: expected an object');
  }
  rejectUnknownKeys(decoded, PROVIDER_KEYS, 'BOOTSTRAP_STAFF_PROVIDER');
  const jwksUri = optionalString(decoded, 'jwksUri', 'BOOTSTRAP_STAFF_PROVIDER');
  if (jwksUri && !isValidHttpsUrl(jwksUri, { allowQuery: true })) {
    throw new Error(
      'Invalid BOOTSTRAP_STAFF_PROVIDER.jwksUri: expected an HTTPS URL without credentials or fragment',
    );
  }
  const issuer = nonEmptyString(decoded['issuer'], 'BOOTSTRAP_STAFF_PROVIDER.issuer');
  const audience = optionalString(decoded, 'audience', 'BOOTSTRAP_STAFF_PROVIDER');
  const clientAuthentication = decoded['clientAuthentication'];
  if (
    clientAuthentication !== undefined &&
    clientAuthentication !== 'none' &&
    clientAuthentication !== 'client_secret_post' &&
    clientAuthentication !== 'client_secret_basic'
  ) {
    throw new Error(
      'Invalid BOOTSTRAP_STAFF_PROVIDER.clientAuthentication: expected none, client_secret_post or client_secret_basic',
    );
  }
  if (!isValidHttpsUrl(issuer, { allowQuery: false })) {
    throw new Error(
      'Invalid BOOTSTRAP_STAFF_PROVIDER.issuer: expected an HTTPS URL without credentials, query, or fragment',
    );
  }
  return {
    displayName: nonEmptyString(decoded['displayName'], 'BOOTSTRAP_STAFF_PROVIDER.displayName'),
    issuer,
    browserClientId: nonEmptyString(
      decoded['browserClientId'],
      'BOOTSTRAP_STAFF_PROVIDER.browserClientId',
    ),
    ...(audience ? { audience } : {}),
    ...(clientAuthentication ? { clientAuthentication } : {}),
    emailClaim: optionalString(decoded, 'emailClaim', 'BOOTSTRAP_STAFF_PROVIDER') ?? 'email',
    ...(jwksUri ? { jwksUri } : {}),
  };
}

function parseAdmins(raw: string): BootstrapAdmin[] {
  const decoded = parseJson(raw, 'BOOTSTRAP_PLATFORM_ADMINS');
  if (!Array.isArray(decoded)) {
    throw new Error('Invalid BOOTSTRAP_PLATFORM_ADMINS: expected a JSON array');
  }
  if (decoded.length === 0) {
    throw new Error('Invalid BOOTSTRAP_PLATFORM_ADMINS: expected at least one entry');
  }

  const subjects = new Map<string, number>();
  const subjectEmails = new Map<string, number>();
  const invitationEmails = new Map<string, number>();
  return decoded.map((entry, index) => {
    const location = `BOOTSTRAP_PLATFORM_ADMINS[${index}]`;
    if (!isObject(entry)) throw new Error(`Invalid ${location}: expected an object`);
    rejectUnknownKeys(entry, ADMIN_KEYS, location);

    const subject = optionalString(entry, 'subject', location);
    const email = optionalString(entry, 'email', location);
    if (!subject && !email) throw new Error(`Invalid ${location}: expected subject or email`);

    if (subject) {
      const duplicateOf = subjects.get(subject);
      if (duplicateOf !== undefined) {
        throw new Error(`Invalid ${location}: duplicate subject, same as entry ${duplicateOf}`);
      }
      subjects.set(subject, index);
      if (email) {
        const emailKey = email.toLowerCase();
        const invitationOf = invitationEmails.get(emailKey);
        if (invitationOf !== undefined) {
          throw new Error(
            `Invalid ${location}: email conflicts with email-only entry ${invitationOf}`,
          );
        }
        if (!subjectEmails.has(emailKey)) subjectEmails.set(emailKey, index);
      }
      return { subject, ...(email ? { email } : {}) };
    }

    const emailKey = email!.toLowerCase();
    const subjectOf = subjectEmails.get(emailKey);
    if (subjectOf !== undefined) {
      throw new Error(`Invalid ${location}: email conflicts with subject entry ${subjectOf}`);
    }
    const duplicateOf = invitationEmails.get(emailKey);
    if (duplicateOf !== undefined) {
      throw new Error(`Invalid ${location}: duplicate email, same as entry ${duplicateOf}`);
    }
    invitationEmails.set(emailKey, index);
    return { email: email! };
  });
}

/**
 * Parses the immutable staff provider and initial platform-administrator declarations without I/O.
 *
 * @param env - Environment carrying the two bootstrap JSON declarations.
 */
export function parseBootstrapInput(env: Record<string, string | undefined>): BootstrapInput {
  const staffProvider = parseStaffProvider(requiredEnv(env, 'BOOTSTRAP_STAFF_PROVIDER'));
  const admins = parseAdmins(requiredEnv(env, 'BOOTSTRAP_PLATFORM_ADMINS'));
  if (staffProvider.clientAuthentication && staffProvider.clientAuthentication !== 'none') {
    const clientSecret = requiredEnv(env, 'BOOTSTRAP_STAFF_CLIENT_SECRET');
    const masterKey = requiredEnv(env, 'SECRETS_MASTER_KEY');
    if (Buffer.from(masterKey, 'base64').length !== 32) {
      throw new Error('SECRETS_MASTER_KEY must decode to 32 bytes (base64-encoded AES-256 key)');
    }
    return { staffProvider, admins, credential: { clientSecret, masterKey } };
  }
  if (env['BOOTSTRAP_STAFF_CLIENT_SECRET']) {
    throw new Error('BOOTSTRAP_STAFF_CLIENT_SECRET requires confidential client authentication');
  }
  return { staffProvider, admins };
}

function discoveryEndpoint(document: Record<string, unknown>, name: string): string {
  const value = document[name];
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    !isValidHttpsUrl(value.trim(), { allowQuery: true })
  ) {
    throw new Error(
      `Invalid discovery document: ${name} must be a non-empty HTTPS URL without credentials or fragment`,
    );
  }
  return value.trim();
}

function validateDiscoveryDocument(
  document: unknown,
  expectedIssuer: string,
): StaffProviderMetadata {
  if (!isObject(document)) throw new Error('Invalid discovery document: expected an object');
  if (document['issuer'] !== expectedIssuer) {
    throw new Error(
      'Invalid discovery document: issuer does not match BOOTSTRAP_STAFF_PROVIDER.issuer',
    );
  }
  return {
    jwksUri: discoveryEndpoint(document, 'jwks_uri'),
    authorizationEndpoint: discoveryEndpoint(document, 'authorization_endpoint'),
    tokenEndpoint: discoveryEndpoint(document, 'token_endpoint'),
  };
}

async function defaultDiscovery(issuer: string): Promise<unknown> {
  const endpoint = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const response = await fetchPinnedHttps(endpoint, {
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    maxResponseBytes: DISCOVERY_MAX_BYTES,
  });
  if (!response.ok) {
    throw new Error(`OIDC discovery request failed with ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('Invalid discovery document: response is not valid JSON');
  }
}

async function applyBootstrap(
  db: Db,
  input: BootstrapInput,
  discover: Discovery,
): Promise<BootstrapReport> {
  const provider = await db.transaction(async (tx) => {
    const result = await ensureStaffProvider(tx, input.staffProvider, async (issuer) => {
      const document = await discover(issuer);
      return validateDiscoveryDocument(document, issuer);
    });
    if (input.credential) {
      const [current] = await tx
        .select()
        .from(identityProviders)
        .where(eq(identityProviders.id, result.id));
      if (
        current?.issuer !== input.staffProvider.issuer ||
        current.browserClientId !== input.staffProvider.browserClientId ||
        current.clientAuthentication !== input.staffProvider.clientAuthentication
      ) {
        throw new Error(
          'The existing staff provider differs from this confidential client declaration. Update its registration in platform administration instead.',
        );
      }
      const secrets = makePlatformSecretStore(tx, input.credential.masterKey);
      const name = `oidc-client:${result.id}`;
      if (!(await secrets.has(name))) await secrets.put(name, input.credential.clientSecret);
    }
    return result;
  });
  const admins: BootstrapAdminReport[] = [];
  for (const admin of input.admins) {
    if ('subject' in admin) {
      const userId = await upsertIdentity(db, {
        issuer: provider.issuer,
        subject: admin.subject,
        ...(admin.email ? { email: admin.email } : {}),
      });
      const granted = await grantPlatformOperator(db, userId);
      admins.push({
        kind: 'granted',
        subject: admin.subject,
        userId,
        operator: granted ? 'granted' : 'already granted',
      });
      continue;
    }
    const email = admin.email.toLowerCase();
    const created = await insertAdminInvitation(db, {
      issuer: provider.issuer,
      email,
    });
    admins.push({
      kind: 'invited',
      email,
      invitation: created ? 'created' : 'already present',
    });
  }
  return { provider, admins };
}

/**
 * Ensures the installation staff provider and initial platform administrators under one global lock.
 *
 * @param env - Environment carrying the two bootstrap JSON declarations.
 * @param discover - OIDC discovery loader, injectable for isolated verification.
 */
export async function runBootstrap(
  env: Record<string, string | undefined> = process.env,
  discover: Discovery = defaultDiscovery,
): Promise<BootstrapReport> {
  const input = parseBootstrapInput(env);
  const admin = makeDb(adminUrl());
  try {
    const reserved = await admin.sql.reserve();
    try {
      console.error('bootstrap: acquiring the run lock');
      await reserved`select pg_advisory_lock(hashtextextended(${BOOTSTRAP_LOCK_KEY}, 0))`;
      return await applyBootstrap(admin.db, input, discover);
    } finally {
      try {
        const [row] = await reserved<
          { released: boolean }[]
        >`select pg_advisory_unlock(hashtextextended(${BOOTSTRAP_LOCK_KEY}, 0)) as released`;
        if (row?.released === false) {
          console.error(
            'bootstrap: the run lock was lost mid-run, so this run was not serialized against other runs. Re-run to confirm the result.',
          );
        }
      } catch (error) {
        console.error(
          `bootstrap: releasing the run lock failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        reserved.release();
      }
    }
  } finally {
    await admin.close();
  }
}

/**
 * Renders one provider line followed by administrator results in declaration order.
 *
 * @param report - Result of a bootstrap run.
 */
export function formatBootstrapReport(report: BootstrapReport): string {
  const lines = [
    `Staff provider ${report.provider.issuer} (${report.provider.id}): ${report.provider.created ? 'created' : 'already present'}`,
  ];
  for (const admin of report.admins) {
    lines.push(
      admin.kind === 'granted'
        ? `Platform administrator ${admin.subject} (${admin.userId}): ${admin.operator}`
        : `Platform administrator ${admin.email}: invitation ${admin.invitation}`,
    );
  }
  return lines.join('\n');
}

if (import.meta.main) {
  runBootstrap()
    .then((report) => {
      console.log(formatBootstrapReport(report));
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
