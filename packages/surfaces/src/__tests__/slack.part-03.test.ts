import { describe, expect, test, vi } from 'vitest';

import {
  makeSlackPoster,
  slackChatGetPermalink,
  slackUsersInfoEmail,
  type FetchLike,
} from '../index';

import type { HubMessage } from '@sre/hub';

import { createFixture } from './slack.fixture';

const __fixture = createFixture();

// Slack parses chat.postMessage `text` as mrkdwn, and the approval path re-renders the same string
// into a { type: 'mrkdwn' } section, so an unescaped body is markup injection into a shared incident
// channel. The live vector is dashboard-authored human text synced to Slack (the author never needs Slack
// access), and a prompt-injected LLM emitting the same shapes.
//
// Escaping is the DEFAULT so a future producer that forgets gets escaped (safe) rather than unescaped
// (vulnerable). The breadcrumb is the ONLY producer that legitimately emits pre-authored mrkdwn and
// opts out explicitly via `preformatted`. That field is not on HubMessage in Phase A (added in Phase B),
// so its fixture casts to HubMessage — same as the authorLabel fixture above.
describe('the rendered body is escaped as mrkdwn', () => {
  test('a body containing <!channel> cannot reach Slack as a live ping', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({ author: 'human', content: 'please look <!channel>' }),
    );
    const text = calls[0]!.body.text as string;
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<!channel>'); // the raw control chars are what Slack acts on
  });

  test('a body containing an mrkdwn link is escaped, not rendered clickable', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({ author: 'human', content: 'see <https://evil.example/|click>' }),
    );
    const text = calls[0]!.body.text as string;
    expect(text).toContain('&lt;https://evil.example/|click&gt;');
    expect(text).not.toContain('<https://evil.example/|click>');
  });

  // Also pins the ORDER: & must be replaced first. Escaping < before & would re-escape the ampersands
  // just emitted, yielding 'a &amp; b &amp;lt; c &amp;gt; d' and failing this.
  test('&, < and > are all escaped in the body', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({ author: 'human', content: 'a & b < c > d' }),
    );
    expect(calls[0]!.body.text as string).toContain('a &amp; b &lt; c &gt; d');
  });

  // render() prefers `summary` over `content`, so a fix that escapes only `content` leaves the agent's
  // summary — the string Slack actually shows for an agent message — injectable.
  test('the summary is escaped too, not just the content', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({ author: 'agent', content: 'harmless', summary: 'pool <!here> exhausted' }),
    );
    const text = calls[0]!.body.text as string;
    expect(text).toContain('&lt;!here&gt;');
    expect(text).not.toContain('<!here>');
  });

  // author is NOT a trust marker, so "escape unless system" closes nothing: the author:'system' producers
  // carry the MOST untrusted text on the platform. classify-consumer.ts appends the human's scrubbed
  // @mention transcript as system, and worker.ts appends the LLM's brief as system.
  test('an author:system body is escaped — author is not a trust marker', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      { token: 'B', channel: 'C' },
      'ROOT',
      __fixture.msg({
        author: 'system',
        content: 'Human-initiated via @mention. Prior thread:\n<!channel> ship it',
      }),
    );
    const text = calls[0]!.body.text as string;
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<!channel>');
  });

  // The opt-out. `<url|text>` IS Slack's link syntax, and the permalink comes from Slack's own
  // chat.getPermalink over Slack-generated ids, never human input — which is exactly what separates it
  // from every other producer. An unconditional escape renders the deep-link as literal text and
  // takes this RED; classify-consumer.correlation.test.ts asserts the same shape end-to-end.
  test('a preformatted breadcrumb keeps its <url|text> link unescaped', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    const permalink =
      'https://acme.slack.com/archives/C07ABC123/p1699999999000100?thread_ts=1699999999.000100&cid=C07ABC123';
    const breadcrumb = {
      ...__fixture.msg({
        author: 'system',
        content: `Consolidated into an existing incident already being tracked in <${permalink}|another thread>.`,
      }),
      preformatted: true,
    } as HubMessage;

    await makeSlackPoster(fetch).post({ token: 'B', channel: 'C' }, 'ROOT', breadcrumb);
    const text = calls[0]!.body.text as string;
    expect(text).toContain(`<${permalink}|another thread>`); // renders clickable, verbatim
    expect(text).not.toContain('&lt;');
    expect(text).not.toContain('&amp;'); // the permalink's own &cid= is part of the URL, not markup
  });

  // regression: the label is escaped today and must stay escaped once the body joins it. A quoted
  // email local-part can carry these characters, so the label is untrusted regardless of the body rule.
  test('the authorLabel stays escaped', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    const human = {
      ...__fixture.msg({ author: 'human', content: 'restart it' }),
      authorLabel: '<!channel>',
    } as HubMessage;

    await makeSlackPoster(fetch).post({ token: 'B', channel: 'C' }, 'ROOT', human);
    const text = calls[0]!.body.text as string;
    expect(text).toContain('&lt;!channel&gt; (via dashboard)');
    expect(text).not.toContain('<!channel>');
  });
});

// users.info now runs on the interactivity ack path (a block_actions tap must be answered within
// Slack's 3s budget), so the lookup must be time-bounded and must degrade to null rather than throw.
describe('slackUsersInfoEmail', () => {
  // The fake WAITS on the signal rather than ignoring it, so a deadline raised past the budget hangs this
  // test until it times out. Dereferencing init.signal directly would not be enough: a dropped signal would
  // throw a TypeError that the function's own catch swallows into the null this asserts, passing a broken
  // deadline. So a missing signal leaves the promise pending (fail by timeout), and `aborted` is asserted
  // after the fact to prove the deadline actually FIRED rather than merely arriving.
  test('a fetch slower than the deadline is aborted and degrades to null', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const fetch: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          seen = init?.signal;
          if (!seen) return; // no deadline: never settles, so this test fails loudly instead of passing
          seen.addEventListener('abort', () => reject(seen!.reason));
        });
      const p = slackUsersInfoEmail(fetch, 'xoxb-BOT', 'U1');
      await vi.advanceTimersByTimeAsync(1_001); // past USERS_INFO_TIMEOUT_MS
      await expect(p).resolves.toBeNull();
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a rejected lookup degrades to null instead of throwing', async () => {
    // Stands in for a rejected fetch. A real expired AbortSignal.timeout() rejects with a TimeoutError
    // DOMException (AbortError is what AbortController.abort() produces); the catch is name-agnostic, so a
    // plain Error exercises the same path.
    const fetch: FetchLike = async () => {
      throw new Error('socket hang up');
    };
    await expect(slackUsersInfoEmail(fetch, 'xoxb-BOT', 'U1')).resolves.toBeNull();
  });

  test('resolves the profile email on a successful lookup, with the token on the header', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, user: { profile: { email: 'jane@x.io' } } }),
      };
    };
    await expect(slackUsersInfoEmail(fetch, 'xoxb-BOT', 'U1')).resolves.toBe('jane@x.io');
    expect(calls[0]!.headers.authorization).toBe('Bearer xoxb-BOT'); // header, never the URL
    expect(calls[0]!.url).toContain('users.info?user=U1');
  });
});

// the cross-thread breadcrumb deep-links the canonical thread, so it needs that thread's permalink.
// Every degradation returns null: the breadcrumb still posts (generically), because a missing hyperlink
// must never cost the human the message telling them where their reply was consolidated.
describe('slackChatGetPermalink', () => {
  const okBody = (permalink: string) => ({ ok: true, channel: 'C07ABC123', permalink });
  // Just "a permalink Slack returned" — the name says nothing about WHICH documented form a thread-root ts
  // comes back as, because Slack does not specify that (see slackChatGetPermalink). The function returns
  // the string verbatim, so this fixture only has to be a realistic one.
  const SOME_PERMALINK =
    'https://acme.slack.com/archives/C07ABC123/p1699999999000100?thread_ts=1699999999.000100&cid=C07ABC123';

  test('resolves the permalink verbatim, with the token on the header and both args on the query', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return { ok: true, status: 200, json: async () => okBody(SOME_PERMALINK) };
    };

    await expect(
      slackChatGetPermalink(fetch, 'xoxb-BOT', 'C07ABC123', '1699999999.000100'),
    ).resolves.toBe(SOME_PERMALINK);
    expect(calls[0]!.headers.authorization).toBe('Bearer xoxb-BOT'); // header, never the URL
    expect(calls[0]!.url).toContain('chat.getPermalink?');
    // Slack names the second arg `message_ts`, not `ts`; a wrong name is a 200 with ok:false, which this
    // function would silently degrade to null. Pin the wire names.
    expect(calls[0]!.url).toContain('channel=C07ABC123');
    expect(calls[0]!.url).toContain('message_ts=1699999999.000100');
  });

  test('ok:false (Slack answers logical failures with HTTP 200) degrades to null', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    });
    await expect(slackChatGetPermalink(fetch, 'xoxb-BOT', 'C_GONE', '1.0')).resolves.toBeNull();
  });

  test('a 200 carrying no permalink degrades to null', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    await expect(slackChatGetPermalink(fetch, 'xoxb-BOT', 'C1', '1.0')).resolves.toBeNull();
  });

  test('a non-2xx degrades to null', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await expect(slackChatGetPermalink(fetch, 'xoxb-BOT', 'C1', '1.0')).resolves.toBeNull();
  });

  test('a rejected lookup degrades to null instead of throwing', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('socket hang up');
    };
    await expect(slackChatGetPermalink(fetch, 'xoxb-BOT', 'C1', '1.0')).resolves.toBeNull();
  });

  // Same construction as the users.info deadline test: the fake WAITS on the signal, so a dropped or
  // raised deadline leaves the promise pending and fails this by timeout rather than passing on the
  // function's own catch. `aborted` is asserted after the fact to prove the deadline FIRED.
  test('a fetch slower than the deadline is aborted and degrades to null', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const fetch: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          seen = init?.signal;
          if (!seen) return; // no deadline: never settles, so this test fails loudly instead of passing
          seen.addEventListener('abort', () => reject(seen!.reason));
        });
      const p = slackChatGetPermalink(fetch, 'xoxb-BOT', 'C1', '1.0');
      await vi.advanceTimersByTimeAsync(3_001); // past GET_PERMALINK_TIMEOUT_MS
      await expect(p).resolves.toBeNull();
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
