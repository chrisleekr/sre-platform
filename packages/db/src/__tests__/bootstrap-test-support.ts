import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { runBootstrap } from '../bootstrap';
import type { DbHandle } from '../client';
import type { BootstrapCommandResult, BootstrapMarkerCounts } from './bootstrap-invalid-cases';

export const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
export const RUN_MARKER = `bootstrap-${randomUUID()}`;

export interface StaffProviderSeed {
  displayName: string;
  issuer: string;
  browserClientId: string;
  audience: string;
  emailClaim?: string;
  jwksUri?: string;
}

export type DiscoveryDocument = {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
};
export type Discovery = (issuer: string) => Promise<DiscoveryDocument>;

export interface BootstrapFixture {
  marker: string;
  provider: StaffProviderSeed;
  subjectAdmin: { subject: string; email: string };
  emailAdmin: { email: string };
}

export function fixture(label: string, withJwks = true): BootstrapFixture {
  const marker = `${RUN_MARKER}-${label}`;
  const issuer = `https://${marker}.example.invalid/`;
  return {
    marker,
    provider: {
      displayName: `Staff ${marker}`,
      issuer,
      browserClientId: `browser-${marker}`,
      audience: `https://api.${marker}.example.invalid`,
      emailClaim: `https://claims.example.invalid/${marker}/email`,
      ...(withJwks ? { jwksUri: `https://${marker}.example.invalid/jwks` } : {}),
    },
    subjectAdmin: {
      subject: `${marker}|subject-admin`,
      email: `${marker}-subject@example.invalid`,
    },
    emailAdmin: { email: `${marker}-invited@example.invalid` },
  };
}

export function bootstrapEnv(
  value: BootstrapFixture,
  admins: readonly unknown[] = [value.subjectAdmin, value.emailAdmin],
): Record<string, string | undefined> {
  return {
    BOOTSTRAP_STAFF_PROVIDER: JSON.stringify(value.provider),
    BOOTSTRAP_PLATFORM_ADMINS: JSON.stringify(admins),
  };
}

export function discovery(value: BootstrapFixture): Discovery {
  return vi.fn(async () => ({
    issuer: value.provider.issuer,
    jwks_uri: `https://${value.marker}.example.invalid/discovered-jwks`,
    authorization_endpoint: `https://${value.marker}.example.invalid/authorize`,
    token_endpoint: `https://${value.marker}.example.invalid/token`,
  }));
}

export function grantedUserId(report: Awaited<ReturnType<typeof runBootstrap>>): string {
  const adminResult = report.admins[0];
  if (adminResult?.kind !== 'granted') throw new Error('expected the first admin to be granted');
  return adminResult.userId;
}

export async function rejectionMessage(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected bootstrap to reject');
}

export function runBootstrapCli(env: Record<string, string>): Promise<BootstrapCommandResult> {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', 'db:bootstrap'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: ADMIN_URL, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

export async function markerCounts(
  admin: DbHandle,
  marker: string,
): Promise<BootstrapMarkerCounts> {
  const pattern = `%${marker}%`;
  const [counts] = await admin.sql<BootstrapMarkerCounts[]>`
    with marked_users as (
      select id from users
      where issuer like ${pattern} or subject like ${pattern} or coalesce(email, '') like ${pattern}
    )
    select
      (select count(*)::int from identity_providers
       where issuer like ${pattern} or display_name like ${pattern}) as providers,
      (select count(*)::int from marked_users) as users,
      (select count(*)::int from platform_operators
       where user_id in (select id from marked_users)) as operators,
      (select count(*)::int from platform_admin_invitations
       where issuer like ${pattern} or email like ${pattern}) as invitations,
      (select count(*)::int from memberships
       where user_id in (select id from marked_users)) as memberships
  `;
  if (!counts) throw new Error('bootstrap fixture count query returned no row');
  return counts;
}

export async function cleanupBootstrapFixtures(admin: DbHandle): Promise<void> {
  const pattern = `%${RUN_MARKER}%`;
  await admin.sql`
    delete from platform_operators where user_id in (
      select id from users
      where issuer like ${pattern} or subject like ${pattern} or coalesce(email, '') like ${pattern}
    )
  `;
  await admin.sql`
    delete from platform_admin_invitations
    where issuer like ${pattern} or email like ${pattern}
  `;
  await admin.sql`
    delete from memberships where user_id in (
      select id from users
      where issuer like ${pattern} or subject like ${pattern} or coalesce(email, '') like ${pattern}
    )
  `;
  await admin.sql`
    delete from users
    where issuer like ${pattern} or subject like ${pattern} or coalesce(email, '') like ${pattern}
  `;
  await admin.sql`
    delete from identity_providers where issuer like ${pattern} or display_name like ${pattern}
  `;
  await admin.sql`delete from tenants where name like ${pattern}`;
}

export interface BootstrapRowVersion {
  entity: string;
  id: string;
  xmin: string;
  ctid: string;
}

export function bootstrapRowVersions(
  admin: DbHandle,
  marker: string,
): Promise<BootstrapRowVersion[]> {
  const pattern = `%${marker}%`;
  return admin.sql<BootstrapRowVersion[]>`
    select 'provider' as entity, id::text, xmin::text, ctid::text
      from identity_providers where issuer like ${pattern}
    union all
    select 'user' as entity, id::text, xmin::text, ctid::text
      from users where issuer like ${pattern}
    union all
    select 'operator' as entity, user_id::text, xmin::text, ctid::text
      from platform_operators where user_id in (select id from users where issuer like ${pattern})
    union all
    select 'invitation' as entity, id::text, xmin::text, ctid::text
      from platform_admin_invitations where issuer like ${pattern}
    order by entity, id
  `;
}

export async function insertIdentityProviderFixture(
  admin: DbHandle,
  input: {
    issuer: string;
    scope?: 'installation' | 'tenant';
    supportsSignup?: boolean;
    tenantClaim?: string;
    createdAt?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await admin.sql`
    insert into identity_providers (
      id, display_name, issuer, jwks_uri, audience, kind, scope, supports_signup, tenant_claim,
      browser_client_id, status, created_at, updated_at
    ) values (
      ${id}, ${`Staff ${RUN_MARKER}`}, ${input.issuer}, ${`${input.issuer}/jwks`},
      ${'https://api.example.invalid/'}, 'oidc', ${input.scope ?? 'installation'},
      ${input.supportsSignup ?? false}, ${input.tenantClaim ?? null}, 'bootstrap-browser', 'active',
      ${input.createdAt ?? '2026-09-04T00:00:00.000Z'},
      ${input.createdAt ?? '2026-09-04T00:00:00.000Z'}
    )
  `;
  return id;
}
