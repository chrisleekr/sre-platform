import { describe, expect, test } from 'vitest';
import { POSTMORTEM_TIMELINE_AT_MAX_CHARS } from '@sre/contracts';
import { BLAMELESS_SYSTEM_PROMPT } from '../blameless';
import { createFixture } from './postmortem-consumer.fixture';

const __fixture = createFixture();

// the postmortem-generation consumer. Part 1 covers the happy path, the published no-op (C5)
// and the blameless guard end to end; part 2 covers failure handling.
describe('makePostmortemHandler', () => {
  test('type guard: a non-postmortem job is ignored without any fetch or model call', async () => {
    const { handler, generate, getIncident } = __fixture.setup({});
    await expect(handler(__fixture.makeJob({ type: 'runbook.generate' }))).resolves.toBeUndefined();
    expect(getIncident).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  test('generates under the blameless system prompt, saves the draft and posts a mirrored postmortem line', async () => {
    const { handler, generate, saveGeneratedPostmortem, append, history } = __fixture.setup({
      transcript: [{ author: 'human', kind: 'text', content: 'pool looks saturated' }],
    });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();

    expect(history).toHaveBeenCalledWith('tenant-1', 'inc-1');
    expect(generate).toHaveBeenCalledTimes(1);
    const [prompt, , options] = generate.mock.calls[0]!;
    expect(options?.system).toBe(BLAMELESS_SYSTEM_PROMPT);
    expect(prompt).toContain('slow_resolution');
    expect(prompt).toContain('pool looks saturated');

    expect(saveGeneratedPostmortem).toHaveBeenCalledTimes(1);
    const [tenantId, incidentId, input] = saveGeneratedPostmortem.mock.calls[0]!;
    expect(tenantId).toBe('tenant-1');
    expect(incidentId).toBe('inc-1');
    expect(input).toMatchObject({
      trigger: 'slow_resolution',
      assessmentRunId: 'run-1',
      requestedByUserId: '7b1d9c2e-4a5f-4c6d-8e9f-0a1b2c3d4e5f',
      summary: 'Checkout degraded for 40 minutes.',
      actionItems: [{ type: 'prevent', title: 'Add a pool saturation alert' }],
    });
    // Evidence receipts are filtered to the ids the incident actually holds: a hallucinated id is dropped.
    expect(input.contributingCauses[0]!.evidenceIds).toEqual([
      '0d2f1c3e-6f3a-4b2a-9c1d-1b2c3d4e5f60',
    ]);

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![2]).toMatchObject({
      author: 'system',
      kind: 'postmortem',
      content: 'Postmortem draft ready for review.',
      originMessageId: 'postmortem:job-1',
    });
  });

  test('C5: a published postmortem is a no-op before any model call, with a dashboard-only note', async () => {
    const { handler, generate, saveGeneratedPostmortem, append } = __fixture.setup({
      status: { status: 'published' },
    });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
    expect(saveGeneratedPostmortem).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![2]).toMatchObject({ author: 'system', kind: 'text' });
    expect(append.mock.calls[0]![2].content).toContain('already published');
  });

  test('a publish that raced the generation is honoured: the draft is discarded and no postmortem line is posted', async () => {
    const { handler, append } = __fixture.setup({ saveResult: 'published' });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![2].kind).toBe('text');
  });

  test('blameless guard: member emails, local parts, mentions and handles never reach the draft', async () => {
    const { handler, saveGeneratedPostmortem } = __fixture.setup({
      memberEmails: ['alice@example.com'],
      transcript: [{ author: 'human', kind: 'text', content: '<@U123> and @bob were on call' }],
      draft: __fixture.draft({
        summary: 'Alice (alice@example.com) misconfigured the pool.',
        contributingCauses: [
          { cause: '<@U123> approved the change and @bob missed the alert.', evidenceIds: [] },
        ],
        lessons: { wentWell: [], wentWrong: ['alice did not escalate'], lucky: [] },
        // `at` is the one timeline field the model can put a mention in; it is cleaned like prose.
        timeline: [{ at: '<@U123> 10:00', event: '@bob paged' }],
        actionItems: [{ type: 'process', title: 'Train alice on the runbook' }],
      }),
    });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
    const input = saveGeneratedPostmortem.mock.calls[0]![2];
    const prose = JSON.stringify(input);
    expect(prose).not.toMatch(/alice|U123|@bob/iu);
    expect(input.summary).toBe('a responder (a responder) misconfigured the pool.');
    expect(input.contributingCauses[0]!.cause).toBe(
      'a responder approved the change and a responder missed the alert.',
    );
    expect(input.timeline[0]).toEqual({ at: 'a responder 10:00', event: 'a responder paged' });
    expect(input.actionItems[0]!.title).toBe('Train a responder on the runbook');
  });

  test('a timeline `at` stays within the PATCH cap after the guard lengthens it', async () => {
    // 10 mentions of 6 chars fit the cap; each becomes "a responder", which would not.
    const at = `${'<@U1> '.repeat(10)}x`;
    expect(at.length).toBeLessThanOrEqual(POSTMORTEM_TIMELINE_AT_MAX_CHARS);
    const { handler, saveGeneratedPostmortem } = __fixture.setup({
      draft: __fixture.draft({ timeline: [{ at, event: 'Monitor fired' }] }),
    });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
    const stored = saveGeneratedPostmortem.mock.calls[0]![2].timeline[0]!.at;
    expect(stored).not.toContain('U1');
    expect(stored.length).toBe(POSTMORTEM_TIMELINE_AT_MAX_CHARS);
  });

  test('re-bounding a timeline `at` never leaves a lone high surrogate for jsonb to reject', async () => {
    // Units 64 and 65 (1-based) are one emoji pair; a naive slice at the cap would keep only its high half.
    const at = `${'x'.repeat(POSTMORTEM_TIMELINE_AT_MAX_CHARS - 1)}\u{1F525}`;
    const { handler, saveGeneratedPostmortem } = __fixture.setup({
      draft: __fixture.draft({ timeline: [{ at, event: 'Monitor fired' }] }),
    });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
    const stored = saveGeneratedPostmortem.mock.calls[0]![2].timeline[0]!.at;
    expect(stored).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(stored).toBe('x'.repeat(POSTMORTEM_TIMELINE_AT_MAX_CHARS - 1));
  });

  test('generated action items are trimmed so a verbose model cannot fill the human cap', async () => {
    const actionItems = Array.from({ length: 30 }, (_, i) => ({
      type: 'prevent',
      title: `Item ${i}`,
    }));
    const { handler, saveGeneratedPostmortem } = __fixture.setup({
      draft: __fixture.draft({ actionItems }),
    });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
    const saved = saveGeneratedPostmortem.mock.calls[0]![2].actionItems;
    expect(saved).toHaveLength(25);
    expect(saved[24]!.title).toBe('Item 24');
  });

  test('blank list entries and blank supporting information are dropped, never turned into the fallback sentence', async () => {
    const { handler, saveGeneratedPostmortem } = __fixture.setup({
      draft: __fixture.draft({
        lessons: { wentWell: ['Monitor fired fast', '   '], wentWrong: ['\t'], lucky: [] },
        timeline: [
          { at: '2026-09-01T10:00:00Z', event: '  ' },
          { at: '2026-09-01T10:05:00Z', event: 'Monitor fired' },
        ],
        actionItems: [
          { type: 'prevent', title: ' ' },
          { type: 'prevent', title: 'Add a pool saturation alert' },
        ],
        supportingInformation: '   ',
      }),
    });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
    const input = saveGeneratedPostmortem.mock.calls[0]![2];
    expect(input.lessons).toEqual({ wentWell: ['Monitor fired fast'], wentWrong: [], lucky: [] });
    expect(input.timeline).toEqual([{ at: '2026-09-01T10:05:00Z', event: 'Monitor fired' }]);
    expect(input.actionItems).toEqual([{ type: 'prevent', title: 'Add a pool saturation alert' }]);
    expect(input.supportingInformation).toBeNull();
  });

  test('a deleted or missing incident is rejected before any model or hub work', async () => {
    const gone = __fixture.setup({ incident: __fixture.makeIncident({ archivedAt: new Date() }) });
    await expect(gone.handler(__fixture.makeJob())).resolves.toBeUndefined();
    expect(gone.generate).not.toHaveBeenCalled();
    expect(gone.append).not.toHaveBeenCalled();
    const missing = __fixture.setup({ incident: null });
    await expect(missing.handler(__fixture.makeJob())).resolves.toBeUndefined();
    expect(missing.generate).not.toHaveBeenCalled();
  });
});
