import { describe, expect, test } from 'vitest';

import { SlackApiError, slackChatPostAlertRoot } from '../index';

import { createFixture } from './slack.fixture';

const __fixture = createFixture();

describe('slackChatPostAlertRoot', () => {
  test('creates a plain platform-owned root and returns its timestamp', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1788000000.000001' });
    const timestamp = await slackChatPostAlertRoot(
      fetch,
      'xoxb-alert-root',
      'C07ALERTS',
      'x'.repeat(40_000),
    );

    expect(timestamp).toBe('1788000000.000001');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://slack.com/api/chat.postMessage',
      headers: { authorization: 'Bearer xoxb-alert-root' },
      body: {
        channel: 'C07ALERTS',
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
      },
    });
    expect(calls[0]!.body).not.toHaveProperty('thread_ts');
    expect(calls[0]!.body.text).toHaveLength(39_000);
  });

  test('treats Slack ok:false as a definitive rejection', async () => {
    const { fetch } = __fixture.fakeFetch({ ok: false, error: 'not_in_channel' });
    const error = await slackChatPostAlertRoot(
      fetch,
      'xoxb-alert-root',
      'C07ALERTS',
      'alert',
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ certainty: 'rejected', code: 'not_in_channel' });
  });

  test('treats Slack success without a timestamp as an uncertain outcome', async () => {
    const { fetch } = __fixture.fakeFetch({ ok: true });
    const error = await slackChatPostAlertRoot(
      fetch,
      'xoxb-alert-root',
      'C07ALERTS',
      'alert',
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ certainty: 'uncertain', code: 'invalid_response' });
  });
});
