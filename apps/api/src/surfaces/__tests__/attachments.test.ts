import { seedMembership } from '@sre/db/test-support';
// incident attachment routes. Live-PG + a fake JWKS, mirroring
// incidents.test.ts. Proves RLS cross-tenant 404, the image allowlist / SVG-never-inline rule, the
// security headers, and the download-forces-attachment behavior.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import {
  makeDb,
  makeSecretStore,
  createIncident,
  recordAttachment,
  tenants,
  incidents,
  incidentAttachments,
  memberships,
  tenantIdentityBindings,
  users,
  type DbHandle,
} from '@sre/db';
import { makeApp } from '../../app';
import { makeTestAuth } from '../../__tests__/auth-test-support';
import type { AttachmentFetcher } from '../attachments';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';
const ISSUER = 'https://test.auth0.local/';
const AUDIENCE = 'sre-api';
const KID = 'att-key';
const KEY = Buffer.alloc(32, 7).toString('base64');

let admin: DbHandle;
let app: DbHandle;
let api: ReturnType<typeof makeApp>;
let redis: Redis;
let privateKey: CryptoKey;
let orgA: string;
let tenantA: string;
let orgB: string;
let tenantB: string;
let incidentA: string;
let incidentA2: string;
let pngFile: string;
let svgFile: string;

const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
const fetchAttachment = vi.fn<AttachmentFetcher>(async () => ({ bytes, contentType: 'image/png' }));

function sign(org: string): Promise<string> {
  // The old `org` argument is now the token subject; the fixture creates its provider binding.
  return new SignJWT({ sub: org })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}
const authHdr = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
  orgA = `org_${randomUUID().slice(0, 8)}`;
  tenantA = randomUUID();
  orgB = `org_${randomUUID().slice(0, 8)}`;
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
  await seedMembership(admin.db, { issuer: ISSUER, subject: orgA }, tenantA);
  await seedMembership(admin.db, { issuer: ISSUER, subject: orgB }, tenantB);
  api = makeApp({
    auth: await makeTestAuth({
      adminDb: admin.db,
      appDb: app.db,
      issuer: ISSUER,
      audience: AUDIENCE,
      keys,
      bindings: [
        { tenantId: tenantA, subject: orgA },
        { tenantId: tenantB, subject: orgB },
      ],
    }),
    readinessDb: app.db,
    appDb: app.db,
    secrets: makeSecretStore(app.db, KEY),
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
    fetchAttachment,
  } as Parameters<typeof makeApp>[0]);
  incidentA = (
    await createIncident(app.db, tenantA, {
      fingerprint: `a1-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  incidentA2 = (
    await createIncident(app.db, tenantA, {
      fingerprint: `a2-${randomUUID()}`,
      alertSource: 'slack',
      service: 'api',
      severity: 'sev2',
    })
  ).id;
  pngFile = `F${randomUUID().slice(0, 8)}`;
  svgFile = `F${randomUUID().slice(0, 8)}`;
  await recordAttachment(app.db, tenantA, {
    incidentId: incidentA,
    fileId: pngFile,
    name: 'graph.png',
    mimetype: 'image/png',
    urlPrivate: 'https://files.slack.com/graph.png',
    permalink: 'https://slack.com/p/graph',
    interpretation: 'a latency graph',
  });
  await recordAttachment(app.db, tenantA, {
    incidentId: incidentA,
    fileId: svgFile,
    name: 'diagram.svg',
    mimetype: 'image/svg+xml',
    urlPrivate: 'https://files.slack.com/diagram.svg',
  });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentAttachments).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenantIdentityBindings).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(users).where(sql`issuer = ${ISSUER} and subject in (${orgA}, ${orgB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
  if (redis) await redis.quit();
});

describe('GET /incidents/:id/attachments', () => {
  test('lists the incident’s attachment metadata (no bytes)', async () => {
    const res = await api.request(`/incidents/${incidentA}/attachments`, authHdr(await sign(orgA)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachments: { fileId: string; interpretation: string | null; urlPrivate?: string }[];
    };
    expect(body.attachments).toHaveLength(2);
    const png = body.attachments.find((a) => a.fileId === pngFile)!;
    expect(png.interpretation).toBe('a latency graph');
    // The private Slack url is never exposed to the client.
    expect(png).not.toHaveProperty('urlPrivate');
  });

  test('requires authentication', async () => {
    expect((await api.request(`/incidents/${incidentA}/attachments`)).status).toBe(401);
  });

  test('another tenant sees not found (RLS)', async () => {
    const res = await api.request(`/incidents/${incidentA}/attachments`, authHdr(await sign(orgB)));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'incident not found' });
  });

  test('an archived incident exposes neither metadata nor file bytes', async () => {
    const deletedIncident = (
      await createIncident(app.db, tenantA, {
        fingerprint: `deleted-attachment-${randomUUID()}`,
        alertSource: 'slack',
        service: 'deleted-attachment',
        severity: 'sev3',
      })
    ).id;
    const deletedFile = `F${randomUUID().slice(0, 8)}`;
    await recordAttachment(app.db, tenantA, {
      incidentId: deletedIncident,
      fileId: deletedFile,
      name: 'deleted.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/deleted.png',
      permalink: 'https://slack.com/p/deleted',
    });
    await admin.db
      .update(incidents)
      .set({ status: 'closed', archivedAt: new Date() })
      .where(sql`id = ${deletedIncident}`);
    const headers = authHdr(await sign(orgA));

    expect((await api.request(`/incidents/${deletedIncident}/attachments`, headers)).status).toBe(
      404,
    );
    expect(
      (await api.request(`/incidents/${deletedIncident}/attachments/${deletedFile}`, headers))
        .status,
    ).toBe(404);
  });
});

describe('GET /incidents/:id/attachments/:fileId', () => {
  test('serves an allowlisted image inline with security headers', async () => {
    const res = await api.request(
      `/incidents/${incidentA}/attachments/${pngFile}`,
      authHdr(await sign(orgA)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(res.headers.get('etag')).toBeTruthy();
    expect((await res.arrayBuffer()).byteLength).toBe(5);
  });

  test('SVG is never inline: forced to a download with a non-executable content type', async () => {
    const res = await api.request(
      `/incidents/${incidentA}/attachments/${svgFile}`,
      authHdr(await sign(orgA)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-type')).not.toContain('svg');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('?download=1 forces an attachment disposition even for an allowlisted image', async () => {
    const res = await api.request(
      `/incidents/${incidentA}/attachments/${pngFile}?download=1`,
      authHdr(await sign(orgA)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  test('a cross-tenant fetch is 404 (RLS), never a leak', async () => {
    const res = await api.request(
      `/incidents/${incidentA}/attachments/${pngFile}`,
      authHdr(await sign(orgB)),
    );
    expect(res.status).toBe(404);
  });

  test('a file that belongs to a different incident of the same tenant is 404', async () => {
    const res = await api.request(
      `/incidents/${incidentA2}/attachments/${pngFile}`,
      authHdr(await sign(orgA)),
    );
    expect(res.status).toBe(404);
  });

  test('a matching If-None-Match revalidates 304 without hitting the upstream', async () => {
    const token = await sign(orgA);
    const first = await api.request(
      `/incidents/${incidentA}/attachments/${pngFile}`,
      authHdr(token),
    );
    const etag = first.headers.get('etag')!;
    const callsBefore = fetchAttachment.mock.calls.length;
    const second = await api.request(`/incidents/${incidentA}/attachments/${pngFile}`, {
      headers: { authorization: `Bearer ${token}`, 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
    expect(fetchAttachment.mock.calls.length).toBe(callsBefore);
  });
});
