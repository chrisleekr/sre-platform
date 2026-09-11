import { describe, expect, test, vi } from 'vitest';

import { SlackApiError, makeSlackPoster, type FetchLike } from '../index';

import type { HubMessage } from '@sre/hub';

import { createFixture } from './slack.fixture';

const __fixture = createFixture();

describe('makeSlackPoster', () => {
  test.each(['post', 'update', 'delete'] as const)(
    'aborts a hung chat.%s request at the shared deadline',
    async (operation) => {
      const controller = new AbortController();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
      try {
        let seen: AbortSignal | undefined;
        const fetch: FetchLike = (_url, init) =>
          new Promise((_resolve, reject) => {
            seen = init?.signal;
            if (!seen) return;
            seen.addEventListener('abort', () => reject(seen!.reason));
          });
        const poster = makeSlackPoster(fetch);
        const request =
          operation === 'post'
            ? poster.post(__fixture.bound('B', 'C'), 'ROOT', __fixture.msg())
            : operation === 'update'
              ? poster.update(__fixture.bound('B', 'C'), '1.1', __fixture.msg())
              : poster.delete(__fixture.bound('B', 'C'), '1.1');

        expect(timeout).toHaveBeenCalledWith(10_000);
        controller.abort(new DOMException('timed out', 'TimeoutError'));
        await expect(request).rejects.toMatchObject({
          name: 'SlackApiError',
          certainty: 'uncertain',
          code: 'transport_failure',
        });
        expect(seen?.aborted).toBe(true);
      } finally {
        timeout.mockRestore();
      }
    },
  );

  test('every message replies in the bound thread and returns its own ts', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1699.0009' });
    const ts = await makeSlackPoster(fetch).post(
      { token: 'xoxb-BOT', channel: 'C9' },
      '1699.0001',
      __fixture.msg({ author: 'human', content: 'restart it' }),
    );

    expect(ts).toBe('1699.0009'); // the reply's own ts, threaded under the root
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0]!.headers.authorization).toBe('Bearer xoxb-BOT'); // token in the header, not the URL
    expect(calls[0]!.body).toMatchObject({ channel: 'C9', thread_ts: '1699.0001' });
    expect(calls[0]!.body.text as string).toContain('👤');
  });

  // a dashboard human reply carries a transient authorLabel (email local-part). render must
  // attribute it as "👤 <label> (via dashboard): <body>", keeping the human glyph. authorLabel is not
  // on HubMessage in Phase A (added in Phase B), so cast the fixture to compile against the current type.
  test('a human reply with authorLabel renders "<label> (via dashboard)" and keeps the 👤 glyph', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    const human = {
      ...__fixture.msg({ author: 'human', content: 'restart it' }),
      authorLabel: 'jane.doe',
    } as HubMessage;
    await makeSlackPoster(fetch).post({ token: 'B', channel: 'C' }, 'ROOT', human);
    const text = calls[0]!.body.text as string;
    expect(text).toContain('👤');
    expect(text).toContain('jane.doe (via dashboard)');
  });

  // Fallback guard (stays GREEN through Phase B): no authorLabel → the bare glyph, no attribution.
  test('a human reply without authorLabel keeps the bare 👤 (no attribution)', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({ author: 'human', content: 'restart it' }),
    );
    const text = calls[0]!.body.text as string;
    expect(text).toContain('👤');
    expect(text).not.toContain('(via dashboard)');
  });

  // The thread id is opaque to the adapter: it is passed to Slack verbatim, never parsed. A surface
  // whose thread ids contain ':' (a Teams `19:…@thread.v2` conversation id) must survive unmangled.
  test('passes the thread id through verbatim, even when it contains a colon', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      __fixture.bound('B', 'C9'),
      '19:meeting_xyz@thread.v2',
      __fixture.msg(),
    );
    expect(calls[0]!.body.thread_ts).toBe('19:meeting_xyz@thread.v2');
  });

  test('render prefers summary over content and appends the dashboard link', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({ content: 'a very long root-cause paragraph', summary: 'DB pool exhausted' }),
      'https://app.example.com/incidents/i1',
    );
    const text = calls[0]!.body.text as string;
    expect(text).toContain('DB pool exhausted'); // summary, not the full content
    expect(text).not.toContain('root-cause paragraph');
    expect(text).toContain('Incident: <https://app.example.com/incidents/i1|Open incident>');
  });

  test('bounds an agent takeaway while the full detail remains in the dashboard record', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1699.9' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C9' },
      '1699.0001',
      __fixture.msg({
        author: 'agent',
        kind: 'reply',
        content: 'full detail',
        summary: 'x'.repeat(2_000),
      }),
    );

    const text = calls[0]!.body.text as string;
    expect(text).toContain('Open it for the full answer and evidence.');
    expect(text.length).toBeLessThan(650);
  });

  test('render omits the link when none is supplied', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post({ token: 'B', channel: 'C' }, 'ROOT', __fixture.msg());
    expect(calls[0]!.body.text as string).not.toContain('Incident:');
  });

  test('renders the initial lifecycle post as only the incident link', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({
        author: 'system',
        kind: 'lifecycle',
        content: 'Incident open: alert accepted for investigation.',
        lifecycleFrom: null,
        lifecycleTo: 'open',
        lifecycleVersion: 0,
      }),
      'https://app.example.com/incidents/i1',
    );

    expect(calls[0]!.body.text).toBe(
      'Incident: <https://app.example.com/incidents/i1|Open incident>',
    );
    expect(calls[0]!.body).not.toHaveProperty('blocks');
  });

  test('keeps Slack link delimiters out of the incident URL', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg(),
      'https://app.example.com/incidents/i1?left=a&right=<b>|c',
    );

    expect(calls[0]!.body.text).toContain(
      'Incident: <https://app.example.com/incidents/i1?left=a&amp;right=%3Cb%3E%7Cc|Open incident>',
    );
  });

  test('renders a recovery result as a native before/now table with the incident link', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({
        kind: 'finding',
        summary: 'etcd latency and node disk IO returned to baseline.',
        content:
          'RECOVERED\netcd latency and node disk IO returned to baseline.\n\nChecks\n• etcd commit p99: >1 s → 1.9 ms',
        recovery: {
          recovered: true,
          checks: [
            { name: 'etcd commit p99', before: '>1 s', now: '1.9 ms' },
            { name: 'Disk IO queue', before: '~37', now: '0.043' },
          ],
          unknowns: [],
          nextStep: null,
        },
      }),
      'https://app.example.com/incidents/i1',
    );

    const blocks = calls[0]!.body.blocks as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({
      type: 'header',
      text: { type: 'plain_text', text: '✅ Recovered' },
    });
    expect(blocks.find((block) => block.type === 'table')).toMatchObject({
      rows: [
        [
          { type: 'raw_text', text: 'Check' },
          { type: 'raw_text', text: 'During incident' },
          { type: 'raw_text', text: 'Now' },
        ],
        [
          { type: 'raw_text', text: 'etcd commit p99' },
          { type: 'raw_text', text: '>1 s' },
          { type: 'raw_text', text: '1.9 ms' },
        ],
        [
          { type: 'raw_text', text: 'Disk IO queue' },
          { type: 'raw_text', text: '~37' },
          { type: 'raw_text', text: '0.043' },
        ],
      ],
    });
    expect(blocks.at(-1)).toMatchObject({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Incident: <https://app.example.com/incidents/i1|Open incident>',
        },
      ],
    });
  });

  test('renders a bounded conclusion from structured finding provenance', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({
        kind: 'finding',
        content: 'Full investigation detail that remains in the dashboard.',
        summary: `Pool saturation explains the errors. ${'x'.repeat(500)}`,
        finding: {
          runId: 'run-1',
          outcome: 'conclusive',
          promotion: 'trusted_assessment',
          promotionReason: 'conclusive_assessment',
          evidenceIds: [],
          currentState: null,
          impact: null,
          nextStep: null,
        },
      }),
      'https://app.example.com/incidents/i1',
    );

    const text = calls[0]!.body.text as string;
    expect(text).toContain('Conclusion: Pool saturation explains the errors.');
    expect(text).not.toContain('Full investigation detail');
    expect(text).toContain('Full response in the incident.');
    expect(text).toContain('<https://app.example.com/incidents/i1|Open incident>');
  });

  test('renders an unverified recovery with missing baseline, unknowns, and no link', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({
        kind: 'finding',
        summary: 'Recovery evidence is incomplete.',
        content: 'Recovery evidence is incomplete.',
        recovery: {
          recovered: false,
          checks: [{ name: 'Error rate', before: null, now: 'unknown' }],
          unknowns: ['Whether <checkout> is healthy'],
          nextStep: 'Query logs & metrics.',
        },
      }),
    );

    const blocks = calls[0]!.body.blocks as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({
      type: 'header',
      text: { type: 'plain_text', text: '⚠️ Human review needed' },
    });
    expect(blocks.find((block) => block.type === 'table')).toMatchObject({
      rows: expect.arrayContaining([
        [
          { type: 'raw_text', text: 'Error rate' },
          { type: 'raw_text', text: 'Not recorded' },
          { type: 'raw_text', text: 'unknown' },
        ],
      ]),
    });
    expect(JSON.stringify(blocks)).toContain('Whether &lt;checkout&gt; is healthy');
    expect(JSON.stringify(blocks)).toContain('Query logs &amp; metrics.');
    expect(blocks.some((block) => block.type === 'context')).toBe(false);
  });

  test('truncates text over the limit with an ellipsis', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({ content: 'x'.repeat(50000) }),
    );
    const text = calls[0]!.body.text as string;
    expect(text).toHaveLength(39000);
    expect(text.endsWith('…')).toBe(true);
  });

  test('update edits the message in place via chat.update', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1699.0001' });
    await makeSlackPoster(fetch).update(
      { token: 'B', channel: 'C9' },
      '1699.0001',
      __fixture.msg({ summary: 'reading logs' }),
    );
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.update');
    expect(calls[0]!.body).toMatchObject({ channel: 'C9', ts: '1699.0001' });
    expect(calls[0]!.body.text as string).toContain('reading logs');
  });

  test('delete removes the message via chat.delete', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true });
    await makeSlackPoster(fetch).delete({ token: 'B', channel: 'C9' }, '1699.0001');
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.delete');
    expect(calls[0]!.body).toMatchObject({ channel: 'C9', ts: '1699.0001' });
  });

  test('delete tolerates message_not_found as success (idempotent redelivery)', async () => {
    const { fetch } = __fixture.fakeFetch({ ok: false, error: 'message_not_found' });
    await expect(
      makeSlackPoster(fetch).delete({ token: 'B', channel: 'C9' }, '1699.0001'),
    ).resolves.toBeUndefined();
  });

  test('delete rethrows a real error code', async () => {
    const { fetch } = __fixture.fakeFetch({ ok: false, error: 'not_in_channel' });
    await expect(
      makeSlackPoster(fetch).delete({ token: 'B', channel: 'C9' }, '1699.0001'),
    ).rejects.toThrow('not_in_channel');
  });

  test('a non-ok HTTP response throws', async () => {
    const { fetch } = __fixture.fakeFetch({}, false, 500);
    const error = await makeSlackPoster(fetch)
      .post({ token: 'B', channel: 'C' }, 'ROOT', __fixture.msg())
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ certainty: 'uncertain', code: 'http_failure' });
  });

  test('HTTP 429 carries a bounded retry delay and is not marked ambiguous', async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '12' : null) },
      json: async () => ({}),
    });
    const error = await makeSlackPoster(fetch)
      .post({ token: 'B', channel: 'C' }, 'ROOT', __fixture.msg())
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({
      certainty: 'retryable',
      code: 'rate_limited',
      retryAfterMs: 12_000,
    });
  });

  test.each([
    [undefined, 1_000],
    ['not-a-number', 1_000],
    ['0', 1_000],
    ['7200', 3_600_000],
  ])('HTTP 429 bounds Retry-After %s to %i ms', async (retryAfter, expected) => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 429,
      ...(retryAfter === undefined
        ? {}
        : {
            headers: {
              get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null),
            },
          }),
      json: async () => ({}),
    });
    const error = await makeSlackPoster(fetch)
      .post({ token: 'B', channel: 'C' }, 'ROOT', __fixture.msg())
      .catch((caught) => caught);

    expect(error).toMatchObject({ certainty: 'retryable', retryAfterMs: expected });
  });

  test('an ok:false Slack body is a definitive rejection with its error code', async () => {
    const { fetch } = __fixture.fakeFetch({ ok: false, error: 'invalid_auth' });
    const error = await makeSlackPoster(fetch)
      .post({ token: 'B', channel: 'C' }, 'ROOT', __fixture.msg())
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ certainty: 'rejected', code: 'invalid_auth' });
  });

  test('a fetch rejection is normalized to a clean error', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED slack.com');
    };
    const error = await makeSlackPoster(fetch)
      .post({ token: 'B', channel: 'C' }, 'ROOT', __fixture.msg())
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ certainty: 'uncertain', code: 'transport_failure' });
    expect(error.message).toBe('slack chat.postMessage request failed');
  });

  test('invalid JSON is an uncertain response, not a definitive rejection', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('invalid JSON');
      },
    });
    const error = await makeSlackPoster(fetch)
      .post({ token: 'B', channel: 'C' }, 'ROOT', __fixture.msg())
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ certainty: 'uncertain', code: 'invalid_response' });
  });

  // --- channel comes from the binding, never from a configured fan-out target. --------------
  // Slack's thread_ts is only meaningful inside the channel that owns the root message, so the channel
  // and the ts must come from the SAME source: the incident's surface binding.

  test('post targets the channel carried by the binding, not a configured one', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1783760625.999999' });
    await makeSlackPoster(fetch).post(
      __fixture.bound('xoxb-BOT', 'C_NEW'),
      '1783760625.776459',
      __fixture.msg(),
    );
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0]!.body).toMatchObject({
      channel: 'C_NEW',
      thread_ts: '1783760625.776459', // the root ts of THAT channel's thread
    });
  });

  test('update targets the channel carried by the binding, not a configured one', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1783760625.776459' });
    await makeSlackPoster(fetch).update(
      __fixture.bound('B', 'C_NEW'),
      '1783760625.776459',
      __fixture.msg({ summary: 'reading logs' }),
    );
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.update');
    expect(calls[0]!.body).toMatchObject({ channel: 'C_NEW', ts: '1783760625.776459' });
  });

  test('delete targets the channel carried by the binding, not a configured one', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true });
    await makeSlackPoster(fetch).delete(__fixture.bound('B', 'C_NEW'), '1783760625.776459');
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.delete');
    expect(calls[0]!.body).toMatchObject({ channel: 'C_NEW', ts: '1783760625.776459' });
  });

  test('an approval message renders a Block Kit actions block with button values', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1699.9' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C9' },
      '1699.0001',
      __fixture.msg({
        kind: 'approval',
        content: 'Restart the service?',
        approval: {
          id: 'appr-1',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      }),
    );

    const blocks = calls[0]!.body.blocks as {
      type: string;
      block_id?: string;
      elements?: { action_id: string; value: string; text: { text: string } }[];
    }[];
    expect(blocks[0]!.type).toBe('section');
    expect(blocks[1]!.block_id).toBe('appr-1');
    expect(blocks[1]!.elements![0]).toMatchObject({ value: 'appr-1:yes', action_id: 'opt:yes' });
    expect(blocks[1]!.elements![1]).toMatchObject({ value: 'appr-1:no' });
    expect(calls[0]!.body.text as string).toContain('Restart the service?'); // notification fallback kept
  });

  test('a long escaped approval stays within each section limit and keeps its buttons', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1699.9' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C9' },
      '1699.0001',
      __fixture.msg({
        kind: 'approval',
        content: '&<>'.repeat(2000),
        approval: {
          id: 'appr-long',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny' },
          ],
        },
      }),
    );

    const blocks = calls[0]!.body.blocks as {
      type: string;
      block_id?: string;
      text?: { text: string };
      elements?: unknown[];
    }[];
    const sections = blocks.slice(0, -1);
    const incompleteEntity = /(?:&|&a|&am|&amp|&l|&lt|&g|&gt)$/;
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.text!.text.length).toBeGreaterThan(0);
      expect(section.text!.text.length).toBeLessThanOrEqual(3000);
      expect(section.text!.text).not.toMatch(incompleteEntity);
    }
    expect(sections.map((block) => block.text!.text).join('')).toBe(calls[0]!.body.text);
    expect(blocks.at(-1)).toMatchObject({
      type: 'actions',
      block_id: 'appr-long',
      elements: [{ value: 'appr-long:approve' }, { value: 'appr-long:deny' }],
    });
  });

  test('an open lifecycle post has no platform acknowledgement action', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1699.9' });
    const incidentId = '8aa742fc-ae97-4fac-8639-d7f528cd1af9';
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C9' },
      '1699.0001',
      __fixture.msg({
        incidentId,
        kind: 'lifecycle',
        author: 'system',
        content: 'Incident open.',
        lifecycleTo: 'open',
        lifecycleVersion: 4,
      }),
    );

    expect(calls[0]!.body).not.toHaveProperty('blocks');
  });

  test('a lifecycle update replaces its actions for the newly projected version', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1699.9' });
    const incidentId = '8aa742fc-ae97-4fac-8639-d7f528cd1af9';
    await makeSlackPoster(fetch).update(
      { token: 'B', channel: 'C9' },
      '1699.9',
      __fixture.msg({
        incidentId,
        kind: 'lifecycle',
        author: 'system',
        content: 'Incident mitigated.',
        lifecycleTo: 'mitigated',
        lifecycleVersion: 5,
      }),
    );

    const blocks = calls[0]!.body.blocks as {
      block_id?: string;
      elements?: Array<{ action_id: string; value: string }>;
    }[];
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.update');
    expect(blocks.at(-1)!.block_id).toBe(`incident-lifecycle:${incidentId}:5`);
    expect(blocks.at(-1)!.elements!.map((element) => element.action_id)).toEqual([
      'incident_lifecycle:open',
      'incident_lifecycle:resolved',
    ]);
    expect(JSON.parse(blocks.at(-1)!.elements![1]!.value)).toMatchObject({
      to: 'resolved',
      expectedVersion: 5,
    });
  });
});
