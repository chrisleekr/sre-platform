import { expect, test } from 'vitest';
import { makeSlackPoster } from '../index';
import { createFixture } from './slack.fixture';
const __fixture = createFixture();
test('renders structured recovery blockers and follow-up actions with safe evidence deep links', async () => {
  const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
  const id = '11111111-1111-4111-8111-111111111111';
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    __fixture.msg({
      kind: 'finding',
      summary: 'Current health requires one check.',
      recovery: {
        recovered: false,
        checks: [],
        unknowns: ['Stale legacy copy'],
        nextStep: null,
        questions: [
          {
            question: 'Is <checkout> healthy?',
            category: 'missing_capability',
            evidenceKind: 'runtime_state',
            resolutionRelevance: 'blocking',
            nextAction: 'Restore access & check readiness.',
            attemptedEvidenceIds: [id],
          },
          {
            question: 'What caused the original failure?',
            category: 'historical_gap',
            evidenceKind: null,
            resolutionRelevance: 'follow_up',
            nextAction: 'Review retained events.',
            attemptedEvidenceIds: [],
          },
        ],
      },
    }),
    'https://app.example.com/w/incidents/i1',
  );
  const blocks = JSON.stringify(calls[0]!.body.blocks);
  expect(blocks).toContain('Blocks resolution');
  expect(blocks).toContain('Follow-up work');
  expect(blocks).toContain('Is &lt;checkout&gt; healthy?');
  expect(blocks).toContain('Restore access &amp; check readiness.');
  expect(blocks).toContain(`https://app.example.com/w/incidents/i1#evidence-${id}|Attempted check`);
  expect(blocks).not.toContain('Stale legacy copy');
});

test('keeps all attempted links intact and escapes deep links within Slack context limits', async () => {
  const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
  const ids = Array.from(
    { length: 20 },
    (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
  );
  const url = `https://app.example.com/${'resource'.repeat(40)}?scope=a&label=<unsafe|link>`;
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    __fixture.msg({
      kind: 'finding',
      recovery: {
        recovered: false,
        checks: [],
        unknowns: [],
        nextStep: null,
        questions: [
          {
            question: 'What check establishes current health?',
            category: 'partial_evidence',
            evidenceKind: 'metrics',
            resolutionRelevance: 'blocking',
            nextAction: 'Inspect the configured service-health query.',
            attemptedEvidenceIds: ids,
          },
        ],
      },
    }),
    url,
  );
  const blocks = calls[0]!.body.blocks as Array<{
    type: string;
    elements?: Array<{ text: string }>;
  }>;
  const contexts = blocks.filter((block) => block.type === 'context');
  expect(contexts.every((block) => block.elements!.length <= 10)).toBe(true);
  for (const id of ids)
    expect(
      contexts.some((block) =>
        block.elements?.some((element) =>
          element.text.endsWith(`#evidence-${id}|Attempted check>`),
        ),
      ),
    ).toBe(true);
  expect(JSON.stringify(contexts)).not.toContain('<unsafe|link>');
  expect(JSON.stringify(contexts)).toContain('&amp;label=%3Cunsafe%7Clink%3E');
});
