import { seedMembership } from '../test-support';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { SIGNAL_DISPOSITION_CORPUS_SIZE } from '@sre/contracts';
import {
  approveSignalDispositionEnforcement,
  claimSignalDispositionEvaluation,
  completeSignalDispositionEvaluation,
  effectiveSignalClassificationMode,
  failSignalDispositionEvaluation,
  getTenantSignalPolicy,
  jobs,
  latestSignalDispositionEvaluation,
  makeDb,
  memberships,
  requestSignalDispositionEvaluation,
  returnSignalDispositionToShadow,
  setTenantSignalPolicy,
  signalDispositionEvaluations,
  tenantSignalPolicies,
  tenants,
  users,
  type DbHandle,
  type InsertEvaluationJobTx,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;
const tenantA = randomUUID();
const tenantB = randomUUID();
const runtimeFingerprint = 'runtime-fingerprint-a';
let admin: DbHandle;
let app: DbHandle;
let userA: string;
let userB: string;
const scenarioResults = Array.from({ length: SIGNAL_DISPOSITION_CORPUS_SIZE }, (_value, index) => ({
  id: `scenario-${index}`,
  expected: index === 0 ? 'ticket' : 'log',
  expectedTicket:
    index === 0
      ? {
          action: 'Review capacity.',
          safeDeferralReason: 'No current impact.',
          riskIfIgnored: 'Capacity may be exhausted.',
          reviewHorizonMinutes: 60,
        }
      : null,
  prediction: { disposition: index === 0 ? 'ticket' : 'log' },
}));
const reviewedTicketScenarioIds = ['scenario-0'];

const insertEvaluationJobTx: InsertEvaluationJobTx = async (tx, input) => {
  const rows = await tx
    .insert(jobs)
    .values({ ...input, stream: 'test:signal-evaluation' })
    .returning({ id: jobs.id });
  return rows[0]!.id;
};

const requestEvaluation = (
  tenantId: string,
  requestedByUserId: string,
  fingerprint = runtimeFingerprint,
) =>
  requestSignalDispositionEvaluation(app.db, tenantId, {
    requestedByUserId,
    runtimeFingerprint: fingerprint,
    insertJobTx: insertEvaluationJobTx,
  });

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'signal-evaluation-a' },
    { id: tenantB, name: 'signal-evaluation-b' },
  ]);
  userA = await seedMembership(
    admin.db,
    { issuer: 'https://evaluation.test/', subject: `evaluation-a-${randomUUID()}` },
    tenantA,
  );
  userB = await seedMembership(
    admin.db,
    { issuer: 'https://evaluation.test/', subject: `evaluation-b-${randomUUID()}` },
    tenantB,
  );
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(tenantSignalPolicies).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db
      .delete(signalDispositionEvaluations)
      .where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(jobs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(users).where(sql`id in (${userA}, ${userB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('signal disposition evaluation repository', () => {
  test('isolates evaluations and coalesces concurrent active requests per tenant', async () => {
    const first = await requestEvaluation(tenantA, userA);
    const duplicate = await requestEvaluation(tenantA, userA);
    await requestEvaluation(tenantB, userB, 'runtime-fingerprint-b');

    expect(first.inserted).toBe(true);
    expect(first.evaluation.jobId).toEqual(expect.any(String));
    expect(duplicate).toMatchObject({ inserted: false, evaluation: { id: first.evaluation.id } });
    await expect(
      claimSignalDispositionEvaluation(app.db, tenantA, first.evaluation.id, randomUUID()),
    ).resolves.toBeNull();
    await expect(
      claimSignalDispositionEvaluation(
        app.db,
        tenantA,
        first.evaluation.id,
        first.evaluation.jobId!,
      ),
    ).resolves.toMatchObject({ status: 'running' });
    await expect(
      claimSignalDispositionEvaluation(
        app.db,
        tenantA,
        first.evaluation.id,
        first.evaluation.jobId!,
      ),
    ).resolves.toMatchObject({ status: 'running' });
    await expect(latestSignalDispositionEvaluation(app.db, tenantA)).resolves.toMatchObject({
      id: first.evaluation.id,
      tenantId: tenantA,
    });
    await expect(latestSignalDispositionEvaluation(app.db, tenantB)).resolves.toMatchObject({
      tenantId: tenantB,
    });
  });

  test('requires perfect current-corpus accuracy and explicit tenant operator approval', async () => {
    const active = await latestSignalDispositionEvaluation(app.db, tenantA);
    expect(active).not.toBeNull();
    await claimSignalDispositionEvaluation(app.db, tenantA, active!.id, active!.jobId!);
    await completeSignalDispositionEvaluation(app.db, tenantA, active!.id, {
      total: SIGNAL_DISPOSITION_CORPUS_SIZE,
      correct: SIGNAL_DISPOSITION_CORPUS_SIZE - 1,
      criticalSafetyMisses: 1,
      classMetrics: { investigate: { recall: 0.9 } },
      scenarioResults,
    });
    await expect(
      approveSignalDispositionEnforcement(app.db, tenantA, {
        evaluationId: active!.id,
        userId: userA,
        runtimeFingerprint,
        reviewedTicketScenarioIds,
      }),
    ).rejects.toThrow('zero safety misses');

    const inaccurate = await requestEvaluation(tenantA, userA);
    await claimSignalDispositionEvaluation(
      app.db,
      tenantA,
      inaccurate.evaluation.id,
      inaccurate.evaluation.jobId!,
    );
    await completeSignalDispositionEvaluation(app.db, tenantA, inaccurate.evaluation.id, {
      total: SIGNAL_DISPOSITION_CORPUS_SIZE,
      correct: SIGNAL_DISPOSITION_CORPUS_SIZE - 1,
      criticalSafetyMisses: 0,
      classMetrics: { log: { recall: 0.9 } },
      scenarioResults,
    });
    await expect(
      approveSignalDispositionEnforcement(app.db, tenantA, {
        evaluationId: inaccurate.evaluation.id,
        userId: userA,
        runtimeFingerprint,
        reviewedTicketScenarioIds,
      }),
    ).rejects.toThrow('perfect current-corpus accuracy');

    const requested = await requestEvaluation(tenantA, userA);
    await claimSignalDispositionEvaluation(
      app.db,
      tenantA,
      requested.evaluation.id,
      requested.evaluation.jobId!,
    );
    await completeSignalDispositionEvaluation(app.db, tenantA, requested.evaluation.id, {
      total: SIGNAL_DISPOSITION_CORPUS_SIZE,
      correct: SIGNAL_DISPOSITION_CORPUS_SIZE,
      criticalSafetyMisses: 0,
      classMetrics: { investigate: { recall: 1 } },
      scenarioResults,
    });
    const policy = await approveSignalDispositionEnforcement(app.db, tenantA, {
      evaluationId: requested.evaluation.id,
      userId: userA,
      runtimeFingerprint,
      reviewedTicketScenarioIds,
    });
    expect(effectiveSignalClassificationMode(policy, runtimeFingerprint)).toBe('enforce');
    expect(effectiveSignalClassificationMode(policy, 'changed-runtime')).toBe('shadow');

    const shadow = await returnSignalDispositionToShadow(app.db, tenantA);
    expect(effectiveSignalClassificationMode(shadow, runtimeFingerprint)).toBe('shadow');
  });

  test('rolls back the durable job when evaluation creation fails', async () => {
    const failedJobId = randomUUID();
    await expect(
      requestSignalDispositionEvaluation(app.db, tenantA, {
        requestedByUserId: userA,
        runtimeFingerprint,
        insertJobTx: async (tx, input) => {
          await tx
            .insert(jobs)
            .values({ id: failedJobId, ...input, stream: 'test:signal-evaluation' });
          throw new Error('evaluation insert failed');
        },
      }),
    ).rejects.toThrow('evaluation insert failed');
    const rows = await admin.db
      .select()
      .from(jobs)
      .where(sql`id = ${failedJobId}`);
    expect(rows).toEqual([]);
  });

  test('revokes enforcement while a newer evaluation is queued and rejects the older pass', async () => {
    const passing = await requestEvaluation(tenantA, userA);
    await claimSignalDispositionEvaluation(
      app.db,
      tenantA,
      passing.evaluation.id,
      passing.evaluation.jobId!,
    );
    await completeSignalDispositionEvaluation(app.db, tenantA, passing.evaluation.id, {
      total: SIGNAL_DISPOSITION_CORPUS_SIZE,
      correct: SIGNAL_DISPOSITION_CORPUS_SIZE,
      criticalSafetyMisses: 0,
      classMetrics: {},
      scenarioResults,
    });
    await approveSignalDispositionEnforcement(app.db, tenantA, {
      evaluationId: passing.evaluation.id,
      userId: userA,
      runtimeFingerprint,
      reviewedTicketScenarioIds,
    });

    const newer = await requestEvaluation(tenantA, userA);
    await setTenantSignalPolicy(app.db, tenantA, {
      retentionDays: 14,
      unsolvedAfterMinutes: 30,
      secondTeamEnabled: false,
      customerVisibleEnabled: true,
    });
    await expect(getTenantSignalPolicy(app.db, tenantA)).resolves.toMatchObject({
      classificationMode: 'shadow',
      retentionDays: 14,
    });
    await failSignalDispositionEvaluation(
      app.db,
      tenantA,
      newer.evaluation.id,
      'classifier_evaluation_failed',
    );
    await expect(
      approveSignalDispositionEnforcement(app.db, tenantA, {
        evaluationId: passing.evaluation.id,
        userId: userA,
        runtimeFingerprint,
        reviewedTicketScenarioIds,
      }),
    ).rejects.toThrow('newest evaluation');
    await expect(getTenantSignalPolicy(app.db, tenantA)).resolves.toMatchObject({
      classificationMode: 'shadow',
    });
  });
});
