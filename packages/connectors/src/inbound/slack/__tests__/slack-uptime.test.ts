import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { slackInboundConnector } from '../connector';
import { uptimeNotification } from '../uptime';

const channel = 'C_UPTIME';
const candidate = (text: string) => {
  const evaluation = slackInboundConnector.evaluate(
    {
      type: 'message',
      subtype: 'bot_message',
      channel,
      ts: '1787991000.000200',
      bot_id: 'B_STATUSCAKE',
      text,
    },
    { botUserId: 'U_BOT' },
  );
  return evaluation?.disposition === 'admit' ? evaluation.candidate : null;
};
// Pinned formula: changing it would split one monitor's history across two identities.
const expectedKey = (url: string) =>
  `slack:${createHash('sha256').update(`${channel}\nstatuscake:uptime:${url}`).digest('hex')}`;

describe('StatusCake Slack uptime template', () => {
  test('reads a timeout outage whose reason is not an HTTP status', () => {
    const text =
      "Website | Your site '<http://chrislee.kr|chrislee.kr>' (<https://chrislee.kr>) went Down [Timeout / Connection Refused]\n<http://chrislee.kr|chrislee.kr> - <https://chrislee.kr>\nYour site went down!";
    expect(uptimeNotification(text)).toEqual({ state: 'firing', url: 'https://chrislee.kr/' });
    expect(candidate(text)?.alertKind).toBe('firing');
    expect(candidate(text)?.observations?.[0]).toMatchObject({
      state: 'firing',
      provider: 'statuscake',
      providerGroupKey: 'statuscake:uptime:https://chrislee.kr/',
      monitorKey: expectedKey('https://chrislee.kr/'),
    });
  });

  test.each([
    ['went Down [HTTP 522] [Unexpected Status Code]', 'firing'],
    ['went Up [HTTP 200] [Successful Connection]\nYour site went back up!', 'resolved'],
    ['went Down', 'firing'],
  ] as const)('reads any bracketed reasons after the state: %s', (suffix, state) => {
    expect(
      uptimeNotification(`Website | Your site '<https://checkout.example|checkout>' ${suffix}`),
    ).toEqual({ state, url: 'https://checkout.example/' });
  });

  test('a word that merely starts with Up or Down is not a state', () => {
    expect(
      uptimeNotification("Website | Your site '<https://checkout.example|checkout>' went Downtown"),
    ).toBeNull();
  });

  test('the monitor key of an HTTP status notice is unchanged by the widened template', () => {
    const down = candidate(
      "Website | Your site '<https://checkout.example/health|checkout>' went Down [HTTP 504]",
    );
    const timeout = candidate(
      "Website | Your site '<https://checkout.example/health|checkout>' went Down [Timeout / Connection Refused]",
    );
    expect(down?.observations?.[0]?.monitorKey).toBe(
      expectedKey('https://checkout.example/health'),
    );
    expect(timeout?.observations?.[0]?.monitorKey).toBe(down?.observations?.[0]?.monitorKey);
  });
});
