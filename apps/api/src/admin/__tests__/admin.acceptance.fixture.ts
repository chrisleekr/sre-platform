import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { count, eq } from 'drizzle-orm';
import { adminActions, type Db } from '@sre/db';
import { expect } from 'vitest';
import type { Redis } from 'ioredis';
import type { AuthDeps } from '../../auth';
import { TicketStore, ticketRoutes, type TicketContext } from '../../surfaces/ticket';

export type TestKeySet = ReturnType<typeof createLocalJWKSet>;

/** Creates distinct identifiers for one isolated administration acceptance fixture. */
export function makeAdminIds() {
  return {
    staffProvider: crypto.randomUUID(),
    tenantProvider: crypto.randomUUID(),
    tenant: crypto.randomUUID(),
    supportTenant: crypto.randomUUID(),
    actor: crypto.randomUUID(),
    target: crypto.randomUUID(),
    rogue: crypto.randomUUID(),
    pendingFounding: crypto.randomUUID(),
    rejectedFounding: crypto.randomUUID(),
    failedFounding: crypto.randomUUID(),
  };
}

/** Counts one administrator's audit rows in the isolated acceptance database. */
export async function adminAuditCount(db: Db, actorUserId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(adminActions)
    .where(eq(adminActions.actorUserId, actorUserId));
  return row?.count ?? 0;
}

/** Creates one local signing key and matching verifier for administration acceptance tests. */
export async function makeTestKeys(kid: string) {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  return {
    privateKey: pair.privateKey,
    keys: createLocalJWKSet({ keys: [jwk] }),
  };
}

/** Signs one short-lived identity token with the supplied acceptance-test claims. */
export function signTestIdentity(input: {
  subject: string;
  issuer: string;
  audience: string;
  privateKey: CryptoKey;
  kid: string;
  issuedAt: number;
  email: string;
  organisation: string;
}) {
  return new SignJWT({
    sub: input.subject,
    email: input.email,
    email_verified: true,
    alternate_email: `alternate-${input.subject}@example.test`,
    organisation: input.organisation,
  })
    .setProtectedHeader({ alg: 'RS256', kid: input.kid })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.issuedAt + 300)
    .sign(input.privateKey);
}

/** Creates the short-lived staff and tenant token signer used by the route tests. */
export function makeIdentitySigner(input: {
  audience: string;
  staffIssuer: string;
  tenantIssuer: string;
  staffPrivateKey: CryptoKey;
  tenantPrivateKey: CryptoKey;
}) {
  return (
    subject: string,
    options: { issuer?: string; issuedAt?: number; email?: string; organisation?: string } = {},
  ) => {
    const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1_000);
    const issuer = options.issuer ?? input.staffIssuer;
    return signTestIdentity({
      subject,
      issuer,
      audience: input.audience,
      privateKey: issuer === input.staffIssuer ? input.staffPrivateKey : input.tenantPrivateKey,
      kid: issuer === input.staffIssuer ? 'staff' : 'tenant',
      issuedAt,
      email: options.email ?? `${subject}@example.test`,
      organisation: options.organisation ?? 'primary',
    });
  };
}

/** Wraps each administrator mutation with the exactly-one-audit-row assertion. */
export function makeAuditedAdminMutation(input: {
  request(path: string, init: RequestInit): Promise<Response>;
  auditCount(): Promise<number>;
  getToken(): Promise<string>;
}) {
  return async (path: string, init: RequestInit) => {
    const before = await input.auditCount();
    const response = await input.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${await input.getToken()}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    expect(await input.auditCount()).toBe(before + (response.ok ? 1 : 0));
    return response;
  };
}

/** Mints and redeems the WebSocket ticket produced under an impersonated HTTP request. */
export async function redeemImpersonationTicket(input: {
  auth: AuthDeps;
  redis: Redis;
  token: string;
  sessionId: string;
}): Promise<TicketContext | null> {
  const tickets = new TicketStore(input.redis, 30, Buffer.alloc(32, 9).toString('base64'));
  const api = ticketRoutes({ auth: input.auth, tickets });
  const response = await api.request('/ticket', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.token}`,
      'x-impersonation-session': input.sessionId,
    },
  });
  expect(response.status).toBe(200);
  const { ticket } = (await response.json()) as { ticket: string };
  return tickets.redeem(ticket);
}
