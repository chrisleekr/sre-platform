import { randomUUID } from 'node:crypto';
import {
  createIncident,
  incidentMessages,
  incidents,
  lockIncidentWorkTx,
  lockResponseGroupWorkTx,
  makeDb,
  tenants,
  withTenant,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { incidentAcceptsReplyTx } from '../slack-inbound/support';

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let hub: ConversationHub;
const tenantId = randomUUID();

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform');
  app = makeDb(
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform',
  );
  redis = new Redis(process.env.VALKEY_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  hub = new ConversationHub(app.db, redis);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'slack-reply-lock-order' });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
  redis?.disconnect();
});

test('a Slack reply takes response-group work locks before its archive-check row lock', async () => {
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: `slack-reply-lock-order-${randomUUID()}`,
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
  });
  let releaseHolder!: () => void;
  const holderMayFinish = new Promise<void>((resolve) => (releaseHolder = resolve));
  let holderLocked!: () => void;
  const holderHasGroupLock = new Promise<void>((resolve) => (holderLocked = resolve));

  // Mirrors a signal writer: group work locks first, then the incident row.
  const holder: Promise<unknown> = admin.db.transaction(async (tx) => {
    await lockResponseGroupWorkTx(tx, tenantId, incident.id);
    holderLocked();
    await holderMayFinish;
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.id, incident.id))
      .for('update');
  });
  await holderHasGroupLock;

  // Mirrors the Slack thread reply, mention and tag-command transactions: archive check, human
  // append, then the resume enqueue's incident-work fence.
  const content = `slack reply ${randomUUID()}`;
  const replied = withTenant(app.db, tenantId, async (tx) => {
    expect(await incidentAcceptsReplyTx(tx, tenantId, incident.id)).toBe(true);
    const appended = await hub.appendTxOnce(tx, tenantId, incident.id, {
      author: 'human',
      content,
      originSurface: 'slack',
      originMessageId: `slack:C-LOCK:${randomUUID()}`,
    });
    await lockIncidentWorkTx(tx, tenantId, [incident.id]);
    return appended.message;
  });

  // Without an observed advisory wait the holder never contended, so the outcome proves nothing.
  try {
    await vi.waitFor(
      async () => {
        const waiting = await admin.db.execute(
          sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory'`,
        );
        if (waiting.length === 0) throw new Error('reply is not waiting on an advisory lock');
      },
      { timeout: 5_000, interval: 50 },
    );
  } finally {
    releaseHolder();
  }

  // An inverted order deadlocks here and Postgres aborts one side with 40P01.
  const [holderOutcome, replyOutcome] = await Promise.allSettled([holder, replied]);
  expect(holderOutcome.status === 'rejected' ? holderOutcome.reason : 'ok').toBe('ok');
  expect(replyOutcome.status === 'rejected' ? replyOutcome.reason : 'ok').toBe('ok');
  const rows = await admin.db
    .select({ id: incidentMessages.id })
    .from(incidentMessages)
    .where(eq(incidentMessages.content, content));
  expect(rows).toHaveLength(1);
}, 20_000);
