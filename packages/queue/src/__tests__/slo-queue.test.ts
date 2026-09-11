import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '@sre/db';
import { Queue } from '../queue';
import { makeSloQueue, SLO_STREAM, SLO_GROUP, SLO_DEAD_STREAM } from '../slo-queue';
import { createFixture } from './queue.fixture';

const __fixture = createFixture();

// Per-run suffixed stream for all Valkey I/O; the pinned production consts are asserted as pure
// equality only, so a test never touches the real sre:jobs:slo on the shared Valkey (the
// classify-queue.test.ts / runbook-queue.test.ts convention).
const sloStream = `test:slo:${__fixture.SUFFIX}`;
const sloGroup = `slo-workers-${__fixture.SUFFIX}`;
const sloDead = `${sloStream}:dead`;

let sloQueue: Queue;

beforeAll(async () => {
  sloQueue = new Queue(__fixture.db.db, __fixture.redis, {
    stream: sloStream,
    group: sloGroup,
    deadStream: sloDead,
  });
  await sloQueue.ensureGroup();
}, 30_000);

// Registered after the fixture's own afterAll, so stack-ordered hooks run this first, while the
// fixture's Valkey connection is still open.
afterAll(async () => {
  await __fixture.redis.del(sloStream, sloDead);
});

describe('slo queue isolation', () => {
  // Pinning the three consts by equality makes a rename a deliberate act: pointing SLO_STREAM at the
  // triage stream would silently deliver error-budget jobs into the triage consumer group.
  test('makeSloQueue binds sre:jobs:slo / slo-workers / sre:jobs:slo:dead and stamps stream on enqueue', async () => {
    expect(SLO_STREAM).toBe('sre:jobs:slo');
    expect(SLO_GROUP).toBe('slo-workers');
    expect(SLO_DEAD_STREAM).toBe('sre:jobs:slo:dead');
    expect(makeSloQueue(__fixture.db.db, __fixture.redis)).toBeInstanceOf(Queue);

    const id = await sloQueue.enqueue({
      tenantId: __fixture.tenant,
      type: __fixture.TYPE,
      payload: { objectiveId: 'obj-1' },
    });
    const row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    // The stream column is what scopes Queue.reconcile(), so a wrong stamp is a cross-stream
    // re-dispatch waiting to happen.
    expect(row.stream).toBe(sloStream);
    expect(row.status).toBe('queued');
    expect(row.tenantId).toBe(__fixture.tenant);
  });
});
