import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { scrubSecrets } from '@sre/agent-tools';
import {
  applySignalObservation,
  applyTriageResult,
  createIncident,
  getIncident,
  investigationRuns,
  serializeSignalFence,
  withTenant,
} from '@sre/db';
import { reviewedEngine } from '../engine/evidence-review';
import { makeFakeEngine, makeFakeGenerator } from '../engine/fake';
import type { StructuredGenerator, TriageResult } from '../engine/types';
import { createFixture } from './worker.fixture';

const fixture = createFixture();
test('unsupported final review preserves the full scrubbed summary durably and records a fixed blocker when it names no gap', async () => {
  const rawSummary = `password=synthetic-secret ${'Current observations are incomplete. '.repeat(6)}The configured recovery criterion remains unverified.`;
  const summary = scrubSecrets(rawSummary);
  expect(rawSummary.length).toBeLessThanOrEqual(360);
  expect(summary.indexOf('configured recovery criterion')).toBeGreaterThan(240);
  // A gapless rejection must not turn the facts-only summary into a question.
  const blocker =
    'Evidence review found the conclusion unsupported but named no specific missing proof.';
  const { id } = await createIncident(fixture.app.db, fixture.tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev2',
  });
  await applyTriageResult(fixture.app.db, fixture.tenantId, id, {
    provider: 'fake',
    sessionId: 'trusted',
    summary: 'Previously trusted cause.',
    confidence: 70,
  });
  const cleared = await applySignalObservation(fixture.app.db, fixture.tenantId, {
    incidentId: id,
    surface: 'slack',
    channel: 'C-FINAL-REVIEW',
    externalMessageId: randomUUID(),
    state: 'resolved',
    summary: 'Provider episode cleared.',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: new Date(),
  });
  let current = '';
  const engine = reviewedEngine(
    {
      ...makeFakeEngine(),
      async verifyRecovery(_input, runtime): Promise<TriageResult> {
        current = await runtime.ctx.audit.record({
          tenantId: fixture.tenantId,
          incidentId: id,
          tool: 'query_metrics',
          input: { query: 'current_health' },
          latencyMs: 1,
          outcome: 'data',
          output: { latencyMs: 40 },
        });
        return {
          provider: 'fake',
          sessionId: 'final-summary',
          outcome: 'conclusive',
          disposition: 'recovery',
          turnBudget: 1,
          summary: 'Current service health reviewed.',
          confidence: 0,
          evidenceReceipts: [{ evidenceId: current, tool: 'query_metrics', outcome: 'complete' }],
          recovery: {
            outcome: 'recovered',
            recovered: true,
            evidence: [{ name: 'Latency', before: null, now: '40 ms' }],
            evidenceIds: [current],
            unknowns: [],
            questions: [],
            nextStep: null,
          },
        };
      },
    },
    makeFakeGenerator(() => ({
      supported: false,
      summary: rawSummary,
      rejection: 'insufficient_evidence',
      evidenceIds: [current],
    })),
  );
  await fixture.workerWithEngine(engine).handle(
    {
      id: randomUUID(),
      tenantId: fixture.tenantId,
      type: 'recovery.verify',
      attempts: 1,
      payload: {
        incidentId: id,
        lifecycleVersion: 0,
        signalFence: serializeSignalFence([cleared.signal]),
      },
    },
    { signal: new AbortController().signal },
  );
  expect(current).not.toBe('');
  const incident = await getIncident(fixture.app.db, fixture.tenantId, id);
  expect(incident).toMatchObject({
    status: 'open',
    rcaSummary: 'Previously trusted cause.',
    recoveryState: 'not_verified',
    recoverySummary: summary,
    recoveryUnknowns: [blocker],
    recoveryQuestions: [
      { question: blocker, attemptedEvidenceIds: [current], resolutionRelevance: 'blocking' },
    ],
  });
  const [run] = await withTenant(fixture.app.db, fixture.tenantId, (tx) =>
    tx.select().from(investigationRuns).where(eq(investigationRuns.incidentId, id)),
  );
  expect(run?.result).toMatchObject({
    summary,
    recovery: { unknowns: [blocker], questions: [{ question: blocker }] },
  });
  const history = await fixture.hub.history(fixture.tenantId, id);
  const finding = history.find((message) => message.finding?.runId === run!.id);
  expect(finding?.summary).toBe(summary);
  expect(finding?.finding).toMatchObject({
    outcome: 'inconclusive',
    promotion: 'not_promoted',
  });
  expect(finding?.recovery).toMatchObject({
    unknowns: [blocker],
    questions: [{ question: blocker }],
  });
  expect(JSON.stringify([incident, run?.result, finding])).not.toContain('synthetic-secret');
  expect(history.some((message) => message.kind === 'lifecycle')).toBe(false);
});

test.each(['complete', 'incomplete'] as const)(
  'large current recovery evidence with %s slice coverage follows the canonical lifecycle',
  async (coverage) => {
    const { id } = await createIncident(fixture.app.db, fixture.tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    await applyTriageResult(fixture.app.db, fixture.tenantId, id, {
      provider: 'fake',
      sessionId: 'trusted',
      summary: 'Previously trusted cause.',
      confidence: 70,
    });
    const cleared = await applySignalObservation(fixture.app.db, fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-reliability',
      externalMessageId: randomUUID(),
      state: 'resolved',
      summary: 'Checkout errors cleared.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    let current = '';
    let slices = 0;
    let syntheses = 0;
    const recovery = () => ({
      outcome: 'recovered' as const,
      recovered: true,
      summary: 'Current checkout health is recovered.',
      evidence: [{ name: 'Checkout health', before: null, now: 'All configured checks pass.' }],
      evidenceIds: [current],
      unknowns: [],
      questions: [],
      nextStep: null,
      recheckAfterMinutes: null,
      scheduleReason: null,
    });
    const generator: StructuredGenerator = {
      async generate(prompt, schema) {
        const input = JSON.parse(prompt);
        const full = {
          supported: true,
          summary: 'Current health verified.',
          reason: 'Current recorded checks pass.',
          evidenceIds: [current],
        };
        if (input.evidenceSlices) {
          slices++;
          const compact = {
            complete: coverage === 'complete',
            notes: [
              {
                kind: 'observation',
                text: 'Current configured health checks pass.',
                evidenceIds: [current],
              },
            ],
          };
          return schema.parse(
            schema.safeParse(compact).success ? compact : { ...full, detail: 'd'.repeat(5_000) },
          );
        }
        syntheses++;
        return schema.parse({ ...full, correctedRecovery: recovery() });
      },
    };
    const engine = reviewedEngine(
      {
        ...makeFakeEngine(),
        async verifyRecovery(_input, runtime): Promise<TriageResult> {
          current = await runtime.ctx.audit.record({
            tenantId: fixture.tenantId,
            incidentId: id,
            tool: 'query_metrics',
            input: { query: 'current_health' },
            latencyMs: 1,
            outcome: 'data',
            output: { health: 'passing', inventory: 'x'.repeat(240_000) },
          });
          return {
            provider: 'fake',
            sessionId: 'large-recovery',
            outcome: 'conclusive',
            turnBudget: 1,
            disposition: 'recovery',
            confidence: 0,
            summary: 'Current health verified.',
            recovery: recovery(),
            evidenceReceipts: [{ evidenceId: current, tool: 'query_metrics', outcome: 'complete' }],
          };
        },
      },
      generator,
    );
    await fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: fixture.tenantId,
        type: 'recovery.verify',
        attempts: 1,
        payload: {
          incidentId: id,
          lifecycleVersion: 0,
          signalFence: serializeSignalFence([cleared.signal]),
        },
      },
      { signal: new AbortController().signal },
    );
    expect(current).not.toBe('');
    expect(slices).toBeGreaterThan(0);
    const incident = await getIncident(fixture.app.db, fixture.tenantId, id);
    expect(incident?.rcaSummary).toBe('Previously trusted cause.');
    const history = await fixture.hub.history(fixture.tenantId, id);
    if (coverage === 'complete') {
      expect(slices).toBeGreaterThan(1);
      expect(syntheses).toBe(1);
      expect(incident).toMatchObject({
        status: 'resolved',
        recoveryState: 'verified',
        recoveryEvidenceIds: [current],
      });
      expect(history.some((message) => message.kind === 'lifecycle')).toBe(true);
    } else {
      expect(slices).toBe(1);
      expect(syntheses).toBe(0);
      expect(incident).toMatchObject({
        status: 'open',
        recoveryState: 'not_verified',
        recoveryEvidenceIds: [],
        recoveryQuestions: [{ attemptedEvidenceIds: [current], resolutionRelevance: 'blocking' }],
      });
      expect(incident?.recoveryQuestions?.[0]?.question).toMatch(
        /slice.*incomplete|incomplete.*slice/i,
      );
      expect(history.some((message) => message.kind === 'lifecycle')).toBe(false);
    }
  },
);
