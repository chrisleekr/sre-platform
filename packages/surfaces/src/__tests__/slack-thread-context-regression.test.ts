import { describe, expect, test } from 'vitest';
import { makeSlackThreadReader, renderThread } from '../slack-reader';

describe('Slack thread source identity', () => {
  test('overlapping pages preserve one copy per source timestamp, not per text', async () => {
    const root = { user: 'U1', text: 'Check deployment health', ts: '100.1' };
    const reply = { user: 'U2', text: 'Still failing', ts: '100.2' };
    const repeated = { ...reply, ts: '100.3' };
    const pages = [
      { ok: true, messages: [root, reply], response_metadata: { next_cursor: 'next' } },
      { ok: true, messages: [reply, repeated], response_metadata: { next_cursor: '' } },
    ];
    let page = 0;
    const reader = makeSlackThreadReader({
      getToken: async () => 'fixture-token',
      fetch: async () => ({ ok: true, status: 200, json: async () => pages[page++] }),
    });
    expect(await reader.readThread('tenant-a', 'channel-a', root.ts)).toEqual([
      root,
      reply,
      repeated,
    ]);
  });

  test('empty artifacts do not produce empty author wrappers', () => {
    const rendered = renderThread([
      { user: '', text: '', ts: '100.1' },
      { user: 'U1', text: 'Can you investigate?', ts: '100.2' },
      { user: '', text: 'A provider supplied useful evidence.', ts: '100.3' },
    ]);
    expect(rendered).not.toContain('[]:');
    expect(rendered).toContain('A provider supplied useful evidence.');
    expect(rendered.match(/Can you investigate\?/g)).toHaveLength(1);
  });

  test('legitimate equal-text messages at distinct timestamps remain', () => {
    const rendered = renderThread([
      { user: 'U1', text: 'Still failing', ts: '100.1' },
      { user: 'U1', text: 'Still failing', ts: '100.2' },
    ]);
    expect(rendered.match(/Still failing/g)).toHaveLength(2);
  });
});
