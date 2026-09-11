import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { createIncident, withTenant } from '@sre/db';
import { Queue } from '@sre/queue';
import { ProviderRateLimitError, type ResumeInput, type TriageEngine } from '../engine/types';
import { createFixture } from './worker.fixture';

const fixture = createFixture();

beforeEach(async () => {
  const queueId = randomUUID();
  fixture.queue = new Queue(fixture.admin.db, fixture.redis, {
    stream: `sre:jobs:load-test:${queueId}`,
    group: `load-test:${queueId}`,
  });
  await fixture.queue.ensureGroup();
});

/** Drain bounded successors; a missing delivery must not look like completed work. */
async function drain(runner: ReturnType<typeof worker>, incidentId: string) {
  for (let tick = 0; tick < 100; tick++) {
    if ((await runner.tick(`load-${incidentId}`)) !== 0) continue;
    const pending = await fixture.admin.sql`
      SELECT id FROM jobs WHERE tenant_id=${fixture.tenantId}
      AND payload->>'incidentId'=${incidentId} AND status NOT IN ('done', 'dead')`;
    expect(pending).toHaveLength(0);
    return;
  }
  throw new Error('Load-test queue did not drain within 100 ticks');
}

async function incident() {
  return (
    await createIncident(fixture.app.db, fixture.tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'synthetic-chat-load',
      severity: 'sev3',
    })
  ).id;
}

async function deliver(incidentId: string, content: string) {
  const result = await withTenant(fixture.app.db, fixture.tenantId, async (tx) => {
    const message = await fixture.hub.appendTxOnce(tx, fixture.tenantId, incidentId, {
      author: 'human',
      content,
      originSurface: 'slack',
      originMessageId: `load:${randomUUID()}`,
    });
    return fixture.queue.insertResumeTx(tx, fixture.tenantId, incidentId, message.message.id);
  });
  if (result.jobId) await fixture.queue.publishResume(result.jobId);
  return result.jobId;
}

function worker(onResume: (input: ResumeInput) => Promise<void>) {
  const engine: TriageEngine = {
    provider: 'fake',
    async investigate() {
      throw new Error('Unexpected initial investigation');
    },
    verifyRecovery: fixture.verifyRecovery,
    async resume(input) {
      await onResume(input);
      return {
        provider: 'fake',
        sessionId: `load:${input.incident.id}`,
        outcome: 'inconclusive',
        turnBudget: 1,
        summary: 'Synthetic load-test response',
        confidence: 0,
      };
    },
  };
  return fixture.workerWithEngine(engine);
}

describe('Chatty thread simulations with real Postgres and Valkey, simulated model', () => {
  test('a long thread preserves messages in storage but omits older evidence from model context', async () => {
    const id = await incident();
    await deliver(id, 'Synthetic incident opener.');
    await deliver(id, 'Important early evidence: the certificate expired before deployment.');
    await Promise.all(
      Array.from({ length: 550 }, (_, n) => deliver(id, `Chatter ${n}: ${'noted '.repeat(30)}`)),
    );
    await deliver(id, 'What caused this incident?');
    const inputs: ResumeInput[] = [];
    const runner = worker(async (input) => {
      inputs.push(input);
    });
    await drain(runner, id);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.humanMessage).toBe('What caused this incident?');
    expect(inputs[0]!.prior.some((m) => m.content === 'Synthetic incident opener.')).toBe(true);
    expect(inputs[0]!.prior.some((m) => m.content.includes('certificate expired'))).toBe(false);
    expect(inputs[0]!.prior.some((m) => m.content.includes('earlier messages elided'))).toBe(true);
    const rows = await fixture.admin
      .sql`SELECT count(*) AS total FROM incident_messages WHERE incident_id=${id} AND author='human'`;
    expect(Number(rows[0]!.total)).toBe(553);
    console.log(
      JSON.stringify({
        scenario: 'long-thread',
        storedHumanMessages: 553,
        priorMessages: inputs[0]!.prior.length,
        earlyEvidenceInContext: false,
      }),
    );
    // 553 messages is the floor that clears TRANSCRIPT_MAX_ROWS, and each one is its own tenant
    // transaction, so the runtime tracks runner speed rather than anything this test asserts. It
    // runs in about 4s locally and took 25s on a shared CI runner, which left the 30s ceiling too
    // close to spend the whole lane on a flake.
  }, 120_000);

  test('100 concurrent messages persist but create one queued resume and one engine run', async () => {
    const id = await incident();
    const started = performance.now();
    const jobs = await Promise.all(
      Array.from({ length: 100 }, (_, n) => deliver(id, `Evidence ${n}`)),
    );
    expect(jobs.filter(Boolean)).toHaveLength(1);
    const inputs: ResumeInput[] = [];
    const runner = worker(async (input) => {
      inputs.push(input);
    });
    await drain(runner, id);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.prior.filter((m) => m.author === 'human')).toHaveLength(99);
    const history = await fixture.hub.history(fixture.tenantId, id, { limit: 500 });
    expect(history.filter((m) => m.author === 'human')).toHaveLength(100);
    console.log(
      JSON.stringify({
        scenario: 'concurrent-burst',
        messages: 100,
        queuedJobs: 1,
        engineRuns: inputs.length,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  }, 30_000);

  test('ten spaced acknowledgements each trigger an engine run', async () => {
    const id = await incident();
    let calls = 0;
    const runner = worker(async () => {
      calls++;
    });
    for (let n = 0; n < 10; n++) {
      await deliver(id, `Thanks, acknowledged (${n}). No new evidence.`);
      await drain(runner, id);
    }
    expect(calls).toBe(10);
    console.log(JSON.stringify({ scenario: 'spaced-chatter', messages: 10, engineRuns: calls }));
  }, 30_000);

  test('20 messages during an active run become one successor, preserving the final update', async () => {
    const id = await incident();
    const inputs: ResumeInput[] = [];
    const runner = worker(async (input) => {
      inputs.push(input);
      if (inputs.length !== 1) return;
      const successors = await Promise.all(
        Array.from({ length: 20 }, (_, n) => deliver(id, `During run ${n}`)),
      );
      expect(successors.filter(Boolean)).toHaveLength(1);
      expect(
        await deliver(id, 'Critical correction: rollback did not restore service.'),
      ).toBeNull();
    });
    await deliver(id, 'Investigate this synthetic issue.');
    await drain(runner, id);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.humanMessage).toBe('Critical correction: rollback did not restore service.');
    const history = await fixture.hub.history(fixture.tenantId, id, { limit: 500 });
    expect(history.filter((m) => m.author === 'human')).toHaveLength(22);
    console.log(
      JSON.stringify({ scenario: 'during-run', messages: 22, engineRuns: inputs.length }),
    );
  }, 30_000);

  test('new chatter after a rate limit still starts new model attempts', async () => {
    const id = await incident();
    let calls = 0;
    const runner = worker(async () => {
      calls++;
      throw new ProviderRateLimitError();
    });
    for (let n = 0; n < 3; n++) {
      await deliver(id, `Acknowledged ${n}.`);
      await drain(runner, id);
    }
    expect(calls).toBe(3);
    const jobs = await fixture.admin
      .sql`SELECT status, attempts FROM jobs WHERE payload->>'incidentId'=${id}`;
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === 'dead' && j.attempts === 1)).toBe(true);
    console.log(
      JSON.stringify({
        scenario: 'rate-limit-new-messages',
        messages: 3,
        engineRuns: calls,
        automaticRetries: 0,
      }),
    );
  }, 30_000);
});
