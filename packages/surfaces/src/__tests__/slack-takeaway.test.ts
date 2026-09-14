import { expect, test } from 'vitest';
import { makeSlackPoster } from '../index';
import { createFixture } from './slack.fixture';

// Sentence-boundary truncation of an agent takeaway. The accumulate path and the generic fallback
// are covered in slack.part-02; these pin the boundary rule itself.
const fixture = createFixture();

test('keeps a decimal inside a sentence instead of truncating at it', async () => {
  // The previous `[^.!?]+[.!?](?:\s|$)` scan required whitespace after the terminator, so it
  // skipped past `2.` and began the takeaway mid-number. The boundary split has no such anchor.
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1699.9' });
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C9' },
    '1699.0001',
    fixture.msg({
      author: 'agent',
      kind: 'reply',
      content: 'full detail',
      summary: `Checkout p99 rose to 2.5s at 14:03. ${'x'.repeat(500)}`,
    }),
  );

  const text = calls[0]!.body.text as string;
  expect(text).toContain('Checkout p99 rose to 2.5s at 14:03.');
  expect(text).toContain('Full response in the incident.');
});

test('falls back when the first sentence alone exceeds the takeaway budget', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1699.9' });
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C9' },
    '1699.0001',
    fixture.msg({
      author: 'agent',
      kind: 'reply',
      content: 'full detail',
      summary: `${'word '.repeat(120)}ends here. And a second sentence.`,
    }),
  );

  const text = calls[0]!.body.text as string;
  expect(text).toContain('Open it for the full answer and evidence.');
});
