import { jobs, type Db, type Executor } from '@sre/db';
import { and, eq } from 'drizzle-orm';
import type { ClassifyEnqueueResult, JobInput } from './contracts';

interface ClassifyIdentity {
  intakeId: string | null;
  eventKey: string | null;
}

function payloadIdentity(payload: unknown): ClassifyIdentity {
  if (typeof payload !== 'object' || payload === null) return { intakeId: null, eventKey: null };
  const value = payload as Record<string, unknown>;
  return {
    intakeId:
      typeof value.intakeId === 'string' && value.intakeId.length > 0 ? value.intakeId : null,
    eventKey:
      typeof value.eventKey === 'string' && value.eventKey.length > 0 ? value.eventKey : null,
  };
}

/** Persists classify work with durable receipt and provider-event idempotency. */
export class ClassifyJobWriter {
  constructor(
    private readonly db: Db,
    private readonly stream: string,
  ) {}

  private async findExisting(
    exec: Executor,
    tenantId: string,
    identity: ClassifyIdentity,
  ): Promise<ClassifyEnqueueResult | null> {
    if (identity.intakeId) {
      const rows = await exec
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.tenantId, tenantId),
            eq(jobs.type, 'classify'),
            eq(jobs.idempotencyKey, identity.intakeId),
          ),
        )
        .limit(1);
      if (rows[0]) return { jobId: rows[0].id, inserted: false, matchedBy: 'intake' };
    }
    if (identity.eventKey) {
      const rows = await exec
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.tenantId, tenantId),
            eq(jobs.type, 'classify'),
            eq(jobs.eventKey, identity.eventKey),
          ),
        )
        .limit(1);
      if (rows[0]) return { jobId: rows[0].id, inserted: false, matchedBy: 'event' };
    }
    return null;
  }

  /**
   * Inserts one classify job or returns the durable job that already owns its receipt or provider event.
   *
   * @param input - Classify job carrying an inbound candidate with intakeId and eventKey identities.
   */
  async insert(input: JobInput): Promise<ClassifyEnqueueResult> {
    return this.db.transaction((tx) => this.insertTx(tx, input));
  }

  /**
   * Inserts classify work on an existing transaction that owns any surrounding admission locks.
   *
   * @param exec - Existing database transaction or executor used for the durable insert.
   * @param input - Classify job carrying an inbound candidate with intakeId and eventKey identities.
   */
  async insertTx(exec: Executor, input: JobInput): Promise<ClassifyEnqueueResult> {
    if (input.type !== 'classify') throw new Error('classify writer only accepts classify jobs');
    const identity = payloadIdentity(input.payload);
    for (let round = 0; round < 2; round++) {
      const inserted = await exec
        .insert(jobs)
        .values({
          tenantId: input.tenantId,
          type: input.type,
          payload: input.payload as object,
          idempotencyKey: identity.intakeId,
          eventKey: identity.eventKey,
          status: 'queued',
          stream: this.stream,
        })
        .onConflictDoNothing()
        .returning({ id: jobs.id });
      const result = inserted[0]
        ? ({
            jobId: inserted[0].id,
            inserted: true,
            matchedBy: null,
          } satisfies ClassifyEnqueueResult)
        : await this.findExisting(exec, input.tenantId, identity);
      if (result) return result;
    }
    throw new Error('classify enqueue conflict disappeared before its durable job could be read');
  }
}
