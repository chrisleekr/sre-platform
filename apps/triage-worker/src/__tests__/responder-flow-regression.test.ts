import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';
import {
  applySignalObservation,
  applyTriageResult,
  createIncident,
  getIncident,
  incidentMessages,
  memberships,
  tenants,
  users,
} from '@sre/db';
import { seedMembership } from '../../../../packages/db/src/test-support';
import { makeFakeEngine } from '../engine/fake';
import { RetryableError } from '@sre/queue';
import { responderGenerator } from './responder-generator.fixture';
import type { TriageEngine, TriageResult } from '../engine/types';
import { createFixture } from './worker.fixture';

const fixture = createFixture();

/** Create a distinct operational case for one responder scenario. */
async function incident() {
  return createIncident(fixture.app.db, fixture.tenantId, {
    fingerprint: randomUUID(),
    service: 'checkout',
    severity: 'sev2',
    alertSource: 'slack',
  });
}

/** Execute a scenario with a real tenant member and clean up its identity.
 * @param run - Assertions performed as the seeded actor.
 */
async function withActor(run: (userId: string) => Promise<void>) {
  const userId = await seedMembership(
    fixture.admin.db,
    {
      issuer: 'https://responder.test',
      subject: randomUUID(),
    },
    fixture.tenantId,
  );
  try {
    await run(userId);
  } finally {
    await fixture.admin.db
      .update(incidentMessages)
      .set({ authorUserId: null })
      .where(eq(incidentMessages.authorUserId, userId));
    await fixture.admin.db.delete(memberships).where(eq(memberships.userId, userId));
    await fixture.admin.db.delete(users).where(eq(users.id, userId));
  }
}

/** Send one durable message through the real resume handler.
 * @param id - Current incident, fixed by the server.
 * @param content - Newly received responder text.
 * @param actor - Trusted persisted actor identity, not extracted from text.
 * @param engine - Inert engine used if investigation is admitted.
 */
async function resume(
  id: string,
  content: string,
  actor: string | null,
  engine = makeFakeEngine(),
) {
  const message = await fixture.hub.append(fixture.tenantId, id, {
    author: 'human',
    content,
    authorUserId: actor,
    originSurface: 'slack',
    originMessageId: randomUUID(),
  });
  await fixture.workerWithEngine(engine).handle(
    {
      id: randomUUID(),
      tenantId: fixture.tenantId,
      type: 'resume',
      attempts: 1,
      payload: { incidentId: id, humanMessageId: message.id },
    },
    { signal: new AbortController().signal },
  );
  return message;
}

describe('responder intent and lifecycle', () => {
  test('a nonmaterial acknowledgement during a run does not suppress the supported answer', async () => {
    await withActor(async (actor) => {
      const row = await incident();
      const engine = {
        ...makeFakeEngine(),
        resume: async () => {
          await fixture.hub.append(fixture.tenantId, row.id, {
            author: 'human',
            authorUserId: actor,
            content: 'Thanks.',
          });
          return {
            provider: 'fake',
            sessionId: randomUUID(),
            outcome: 'conclusive' as const,
            disposition: 'rca' as const,
            turnBudget: 1,
            summary: 'Current evidence supports the assessment.',
            confidence: 80,
          };
        },
      };
      await resume(row.id, 'Investigate the current evidence.', actor, engine);
      expect((await getIncident(fixture.app.db, fixture.tenantId, row.id))?.rcaSummary).toBe(
        'Current evidence supports the assessment.',
      );
    });
  });
  test('a cancellation received during interpretation fences the pending lifecycle action', async () => {
    await withActor(async (actor) => {
      const row = await incident();
      const request = await fixture.hub.append(fixture.tenantId, row.id, {
        author: 'human',
        authorUserId: actor,
        content: 'Please close this case.',
      });
      const generator = {
        generate: async <T>(_prompt: string, schema: import('zod').ZodType<T>) => {
          await fixture.hub.append(fixture.tenantId, row.id, {
            author: 'human',
            authorUserId: actor,
            content: 'Do not close it. New failures appeared.',
          });
          return schema.parse({
            kind: 'action',
            target: 'current',
            to: 'closed',
            reason: 'Original closure request.',
          });
        },
      };
      await expect(
        fixture.workerWithEngine(makeFakeEngine(), { generator }).handle(
          {
            id: randomUUID(),
            tenantId: fixture.tenantId,
            type: 'resume',
            attempts: 1,
            payload: { incidentId: row.id, humanMessageId: request.id },
          },
          { signal: new AbortController().signal },
        ),
      ).rejects.toBeInstanceOf(RetryableError);
      expect(await getIncident(fixture.app.db, fixture.tenantId, row.id)).toMatchObject({
        status: 'open',
        lifecycleVersion: 0,
      });
      expect(
        (await fixture.hub.history(fixture.tenantId, row.id)).filter(
          (message) => message.kind === 'lifecycle',
        ),
      ).toHaveLength(0);
    });
  });

  test.each(['rca', 'reply', 'approval'] as const)(
    'a second correction during reconciliation fences %s publication',
    async (disposition) => {
      await withActor(async (actor) => {
        const row = await incident();
        const first = await fixture.hub.append(fixture.tenantId, row.id, {
          author: 'human',
          authorUserId: actor,
          content: 'Investigate the deployment.',
        });
        const basic = responderGenerator();
        const generator = {
          generate: async <T>(
            prompt: string,
            schema: import('zod').ZodType<T>,
            options?: import('../engine/types').StructuredGenerationOptions,
          ) => {
            if (JSON.parse(prompt).newer) {
              await fixture.hub.append(fixture.tenantId, row.id, {
                author: 'human',
                authorUserId: actor,
                content: 'Stop: that is the GitHub mirror, production uses GitLab.',
              });
              return schema.parse({
                material: false,
                reason: 'The first new message was an acknowledgement.',
              });
            }
            return basic.generate(prompt, schema, options);
          },
        };
        const engine: TriageEngine = {
          ...makeFakeEngine(),
          resume: async () => {
            await fixture.hub.append(fixture.tenantId, row.id, {
              author: 'human',
              authorUserId: actor,
              content: 'Thanks.',
            });
            return {
              provider: 'fake',
              sessionId: randomUUID(),
              outcome: 'conclusive',
              disposition,
              turnBudget: 1,
              summary: 'Unsafe stale answer',
              detail: 'Unsafe stale answer',
              confidence: 90,
              approval: {
                prompt: 'Unsafe stale action',
                options: [{ id: 'yes', label: 'Proceed' }],
              },
            };
          },
        };
        await fixture.workerWithEngine(engine, { generator }).handle(
          {
            id: randomUUID(),
            tenantId: fixture.tenantId,
            type: 'resume',
            attempts: 1,
            payload: { incidentId: row.id, humanMessageId: first.id },
          },
          { signal: new AbortController().signal },
        );
        expect((await getIncident(fixture.app.db, fixture.tenantId, row.id))?.rcaSummary).not.toBe(
          'Unsafe stale answer',
        );
        expect(
          (await fixture.hub.history(fixture.tenantId, row.id)).filter(
            (message) =>
              ['reply', 'approval'].includes(message.kind) &&
              message.content.startsWith('Unsafe stale'),
          ),
        ).toHaveLength(0);
      });
    },
  );
  test.each(['Let’s close the incident.', 'Please close this incident; this was not an outage.'])(
    'commits a polite closure without a diagnostic sweep: %s',
    async (content) => {
      await withActor(async (actor) => {
        const row = await incident();
        const engine = makeFakeEngine();
        const diagnostic = vi.spyOn(engine, 'resume');
        await resume(row.id, content, actor, engine);
        expect(await getIncident(fixture.app.db, fixture.tenantId, row.id)).toMatchObject({
          status: 'closed',
          lifecycleVersion: 1,
        });
        expect(diagnostic).not.toHaveBeenCalled();
        expect(
          (await fixture.hub.history(fixture.tenantId, row.id)).filter(
            (m) => m.kind === 'lifecycle',
          ),
        ).toEqual([expect.objectContaining({ lifecycleTo: 'closed', authorUserId: actor })]);
      });
    },
  );

  test.each(['unmapped', 'removed', 'disabled'])(
    'refuses a lifecycle command from an %s actor',
    async (state) => {
      await withActor(async (actor) => {
        const row = await incident();
        if (state === 'removed')
          await fixture.admin.db.delete(memberships).where(eq(memberships.userId, actor));
        if (state === 'disabled')
          await fixture.admin.db
            .update(users)
            .set({ status: 'disabled' })
            .where(eq(users.id, actor));
        await resume(
          row.id,
          'Close incident because the check is complete.',
          state === 'unmapped' ? null : actor,
        );
        expect(await getIncident(fixture.app.db, fixture.tenantId, row.id)).toMatchObject({
          status: 'open',
          lifecycleVersion: 0,
        });
      });
    },
  );

  test('a member of another tenant cannot close this tenant’s incident', async () => {
    const foreignTenant = randomUUID();
    await fixture.admin.db.insert(tenants).values({ id: foreignTenant, name: 'Foreign responder' });
    const actor = await seedMembership(
      fixture.admin.db,
      { issuer: 'https://foreign.test', subject: randomUUID() },
      foreignTenant,
    );
    try {
      const row = await incident();
      await resume(row.id, 'Close incident.', actor);
      expect(await getIncident(fixture.app.db, fixture.tenantId, row.id)).toMatchObject({
        status: 'open',
      });
    } finally {
      await fixture.admin.db
        .update(incidentMessages)
        .set({ authorUserId: null })
        .where(eq(incidentMessages.authorUserId, actor));
      await fixture.admin.db.delete(memberships).where(eq(memberships.userId, actor));
      await fixture.admin.db.delete(users).where(eq(users.id, actor));
      await fixture.admin.db.delete(tenants).where(eq(tenants.id, foreignTenant));
    }
  });

  test.each([
    'Should we close this incident?',
    'Do not close this incident.',
    'The runbook says "close incident".',
    'Close incident once recovery is verified.',
    'Close incident in the other workspace.',
  ])('discussion is not lifecycle authority: %s', async (content) => {
    await withActor(async (actor) => {
      const row = await incident();
      await resume(row.id, content, actor);
      expect(await getIncident(fixture.app.db, fixture.tenantId, row.id)).toMatchObject({
        status: 'open',
        lifecycleVersion: 0,
      });
    });
  });

  test('manual closure leaves a firing monitor and recovery state unchanged; follow-up does not reopen', async () => {
    await withActor(async (actor) => {
      const row = await incident();
      await applySignalObservation(fixture.app.db, fixture.tenantId, {
        incidentId: row.id,
        surface: 'slack',
        channel: 'C-health',
        externalMessageId: randomUUID(),
        state: 'firing',
        summary: 'A monitor is still firing',
        contentHash: randomUUID(),
        eventKey: randomUUID(),
        eventAt: new Date(),
      });
      const before = await getIncident(fixture.app.db, fixture.tenantId, row.id);
      await resume(row.id, 'Close incident because this is a planned test.', actor);
      await resume(row.id, 'Explain the evidence we collected.', actor);
      expect(await getIncident(fixture.app.db, fixture.tenantId, row.id)).toMatchObject({
        status: 'closed',
        resolvedAt: null,
        recoveryState: before!.recoveryState,
      });
    });
  });

  test('a material human correction received during a run prevents outdated promotion', async () => {
    await withActor(async (actor) => {
      const row = await incident();
      await applyTriageResult(fixture.app.db, fixture.tenantId, row.id, {
        provider: 'fake',
        sessionId: randomUUID(),
        summary: 'Previous supported assessment.',
        confidence: 70,
      });
      const engine: TriageEngine = {
        ...makeFakeEngine(),
        async resume() {
          await fixture.hub.append(fixture.tenantId, row.id, {
            author: 'human',
            authorUserId: actor,
            content: 'This deployment uses GitLab, not the GitHub mirror.',
          });
          return {
            provider: 'fake',
            sessionId: randomUUID(),
            disposition: 'rca',
            outcome: 'conclusive',
            turnBudget: 1,
            summary: 'The GitHub PR caused the deployment.',
            confidence: 95,
          } satisfies TriageResult;
        },
      };
      await resume(row.id, 'Which change caused this?', actor, engine);
      const stored = await getIncident(fixture.app.db, fixture.tenantId, row.id);
      expect(stored!.rcaSummary).not.toBe('The GitHub PR caused the deployment.');
      expect(
        (await fixture.hub.history(fixture.tenantId, row.id)).some((m) =>
          m.content.includes('GitLab, not the GitHub mirror'),
        ),
      ).toBe(true);
    });
  });

  test('a closure committed while investigation runs is not undone by its final result', async () => {
    await withActor(async (actor) => {
      const row = await incident();
      const engine: TriageEngine = {
        ...makeFakeEngine(),
        async resume() {
          await fixture.hub.transitionIncident(fixture.tenantId, row.id, {
            to: 'closed',
            reason: 'Responder completed this case.',
            transitionKey: randomUUID(),
            author: 'human',
            authorUserId: actor,
            expectedVersion: 0,
          });
          return {
            provider: 'fake',
            sessionId: randomUUID(),
            disposition: 'rca',
            outcome: 'conclusive',
            turnBudget: 1,
            summary: 'A stale active-incident assessment.',
            confidence: 90,
          };
        },
      };
      await resume(row.id, 'Check the latest evidence.', actor, engine);
      expect(await getIncident(fixture.app.db, fixture.tenantId, row.id)).toMatchObject({
        status: 'closed',
        lifecycleVersion: 1,
      });
    });
  });

  test('creation preserves an explicit health-check purpose', async () => {
    const request = {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
      purpose: 'health_check' as const,
    };
    const row = await createIncident(fixture.app.db, fixture.tenantId, request);
    expect(await getIncident(fixture.app.db, fixture.tenantId, row.id)).toMatchObject({
      purpose: 'health_check',
    });
  });

  test('operational paths survive persisted progress and later model context', async () => {
    await withActor(async (actor) => {
      const row = await incident();
      const instruction = 'Restore packages/db/migrations/0042_accounting.sql before retrying.';
      let modelContext = '';
      let invocation = 0;
      const engine: TriageEngine = {
        ...makeFakeEngine(),
        async resume(input, runtime) {
          invocation += 1;
          if (invocation === 1) await runtime.onStep('text', instruction);
          else modelContext = input.prior.map((message) => message.content).join('\n');
          return {
            provider: 'fake',
            sessionId: randomUUID(),
            disposition: 'reply',
            outcome: 'inconclusive',
            turnBudget: 1,
            summary: 'Recorded the requested explanation.',
            confidence: 0,
          };
        },
      };
      await resume(row.id, 'What is the safe next step?', actor, engine);
      await resume(row.id, 'Explain the earlier instruction.', actor, engine);
      expect(
        (await fixture.hub.history(fixture.tenantId, row.id)).some(
          (message) => message.content === instruction,
        ),
      ).toBe(true);
      expect(modelContext).toContain(instruction);
    });
  });
});
