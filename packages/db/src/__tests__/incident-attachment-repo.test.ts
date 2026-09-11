// two-tenant LIVE-Postgres RLS proof for incident_attachments. Mirrors
// tool-call-repo.test.ts: admin (superuser) seeds/cleans the control-plane tenants; the repo runs
// as app_user so FORCE ROW LEVEL SECURITY binds and cross-tenant reads return zero rows.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  makeDb,
  createIncident,
  withTenant,
  recordAttachment,
  attachmentByFileId,
  attachmentsForIncident,
  uninterpretedImages,
  setInterpretation,
  type DbHandle,
} from '../index';
import { tenants, incidents, incidentAttachments } from '../schema';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let incidentA: string;
let incidentB: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
  incidentA = (
    await createIncident(app.db, tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  incidentB = (
    await createIncident(app.db, tenantB, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentAttachments).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('incident_attachments RLS', () => {
  test('insert under tenant A is readable back under A', async () => {
    const id = await recordAttachment(app.db, tenantA, {
      incidentId: incidentA,
      fileId: `F${randomUUID().slice(0, 8)}`,
      name: 'trace.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/a',
    });
    const rows = await withTenant(app.db, tenantA, (tx) =>
      tx.select().from(incidentAttachments).where(eq(incidentAttachments.id, id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('trace.png');
  });

  test('tenant B cannot read tenant A attachments (RLS returns 0 rows)', async () => {
    const fileId = `F${randomUUID().slice(0, 8)}`;
    await recordAttachment(app.db, tenantA, {
      incidentId: incidentA,
      fileId,
      name: 'secret.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/secret',
    });
    // Under B's RLS context, A's rows are invisible.
    const asB = await withTenant(app.db, tenantB, (tx) =>
      tx.select().from(incidentAttachments).where(eq(incidentAttachments.incidentId, incidentA)),
    );
    expect(asB).toHaveLength(0);
    // The by-fileId lookup is tenant-scoped: B never resolves A's file.
    expect(await attachmentByFileId(app.db, tenantB, fileId)).toBeNull();
    // A resolves its own.
    expect((await attachmentByFileId(app.db, tenantA, fileId))?.name).toBe('secret.png');
  });

  test('attachmentByFileId is scoped to the querying tenant', async () => {
    const fileId = `F${randomUUID().slice(0, 8)}`;
    await recordAttachment(app.db, tenantB, {
      incidentId: incidentB,
      fileId,
      name: 'b-only.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/b',
    });
    expect((await attachmentByFileId(app.db, tenantB, fileId))?.name).toBe('b-only.png');
    expect(await attachmentByFileId(app.db, tenantA, fileId)).toBeNull();
  });

  test('recordAttachment is idempotent on (tenant, incident, file): re-record is a no-op', async () => {
    const fileId = `F${randomUUID().slice(0, 8)}`;
    const first = await recordAttachment(app.db, tenantA, {
      incidentId: incidentA,
      fileId,
      name: 'dup.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/dup',
    });
    // A redelivered message re-records the same file: same row id back, no duplicate created.
    const second = await recordAttachment(app.db, tenantA, {
      incidentId: incidentA,
      fileId,
      name: 'dup.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/dup',
    });
    expect(second).toBe(first);
    const rows = await withTenant(app.db, tenantA, (tx) =>
      tx.select().from(incidentAttachments).where(eq(incidentAttachments.fileId, fileId)),
    );
    expect(rows).toHaveLength(1);
  });

  test('attachmentsForIncident lists a tenant’s rows and never another tenant’s', async () => {
    const fileId = `F${randomUUID().slice(0, 8)}`;
    await recordAttachment(app.db, tenantA, {
      incidentId: incidentA,
      fileId,
      name: 'listed.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/listed',
      permalink: 'https://slack.com/p/listed',
    });
    const listA = await attachmentsForIncident(app.db, tenantA, incidentA);
    expect(listA.some((a) => a.fileId === fileId && a.name === 'listed.png')).toBe(true);
    // B lists its own incident: A's row is invisible under B's RLS.
    const listB = await attachmentsForIncident(app.db, tenantB, incidentA);
    expect(listB).toHaveLength(0);
  });

  test('uninterpretedImages returns only image/* rows with a null interpretation, scoped', async () => {
    const imgFile = `F${randomUUID().slice(0, 8)}`;
    const pdfFile = `F${randomUUID().slice(0, 8)}`;
    await recordAttachment(app.db, tenantA, {
      incidentId: incidentA,
      fileId: imgFile,
      name: 'graph.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/graph',
    });
    // A non-image is metadata-only: never returned for interpretation.
    await recordAttachment(app.db, tenantA, {
      incidentId: incidentA,
      fileId: pdfFile,
      name: 'notes.pdf',
      mimetype: 'application/pdf',
      urlPrivate: 'https://files.slack.com/notes',
    });
    const pending = await uninterpretedImages(app.db, tenantA, incidentA);
    expect(pending.some((p) => p.fileId === imgFile)).toBe(true);
    expect(pending.some((p) => p.fileId === pdfFile)).toBe(false);

    // Set the interpretation, then it drops out of the pending set (idempotency anchor).
    await setInterpretation(
      app.db,
      tenantA,
      incidentA,
      imgFile,
      'a latency graph spiking at 10:02',
    );
    const after = await uninterpretedImages(app.db, tenantA, incidentA);
    expect(after.some((p) => p.fileId === imgFile)).toBe(false);
    expect((await attachmentByFileId(app.db, tenantA, imgFile))?.interpretation).toBe(
      'a latency graph spiking at 10:02',
    );

    // setInterpretation under B never touches A's row (RLS): A's interpretation stands.
    await setInterpretation(app.db, tenantB, incidentA, imgFile, 'HACKED');
    expect((await attachmentByFileId(app.db, tenantA, imgFile))?.interpretation).toBe(
      'a latency graph spiking at 10:02',
    );
  });
});
