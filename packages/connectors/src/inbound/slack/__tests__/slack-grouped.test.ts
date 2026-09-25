import { describe, expect, test } from 'vitest';
import { slackInboundConnector } from '../connector';
const ctx = { botUserId: 'U_BOT' };
const normalizedCandidate = (event: unknown, context = ctx) => {
  const evaluation = slackInboundConnector.evaluate(event, context);
  return evaluation?.disposition === 'admit' ? evaluation.candidate : null;
};
describe('grouped Slack provider notifications', () => {
  test('normalizes every alert block in one grouped provider notification', () => {
    const candidate = normalizedCandidate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991000.000100',
        bot_id: 'B_ALERT',
        text: '',
        attachments: [
          {
            fallback:
              '[FIRING:2] monitoring (warning) | <https://alerts.example/#/alerts?receiver=default>',
            text: [
              '*Alert:* Checkout latency is high.',
              '*Description:* p99 exceeded the service objective.',
              '*Severity:* `warning`',
              '*Source:* Prometheus Alertmanager',
              '*Alert:* Checkout error rate is high.',
              '*Description:* 5xx responses exceeded the service objective.',
              '*Severity:* `critical`',
              '*Source:* Prometheus Alertmanager',
            ].join(' '),
          },
        ],
      },
      ctx,
    );

    // The exact summary, not a substring: it is the only assertion that pins `blockFieldValue`
    // trimming its segment and stripping the provider's backticks. `summary` is hashed into
    // `contentHash` and read by a responder, so an untrimmed `Severity:  \`warning\`` is a defect.
    expect(candidate?.observations?.[0]?.summary).toBe(
      [
        'Checkout latency is high.',
        'p99 exceeded the service objective.',
        'Severity: warning',
        'Source: Prometheus Alertmanager',
      ].join('\n'),
    );
    expect(candidate?.observations).toEqual([
      expect.objectContaining({
        alertName: 'Checkout latency is high.',
        state: 'firing',
        summary: expect.stringContaining('p99 exceeded'),
        providerGroupKey: 'alertmanager:https://alerts.example/|monitoring (warning)',
      }),
      expect.objectContaining({
        alertName: 'Checkout error rate is high.',
        state: 'firing',
        summary: expect.stringContaining('5xx responses'),
      }),
    ]);
    expect(candidate?.observations?.[0]?.externalMessageId).not.toBe(
      candidate?.observations?.[1]?.externalMessageId,
    );
    expect(
      candidate?.observations?.every((item) => item.eventKey.endsWith(':producer:bot:B_ALERT')),
    ).toBe(true);
  });

  test('keeps repeated instances of one alert rule as distinct group members', () => {
    const candidate = normalizedCandidate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991000.000101',
        bot_id: 'B_ALERT',
        text: [
          '*Alert:* Target is down.',
          '*Description:* instance api-1 is unreachable.',
          '*Severity:* `critical`',
          '*Source:* Prometheus Alertmanager',
          '*Alert:* Target is down.',
          '*Description:* instance api-2 is unreachable.',
          '*Severity:* `critical`',
          '*Source:* Prometheus Alertmanager',
        ].join(' '),
      },
      ctx,
    );

    expect(candidate?.observations).toHaveLength(2);
    expect(new Set(candidate?.observations?.map((item) => item.externalMessageId)).size).toBe(2);
    expect(candidate?.observations?.map((item) => item.alertName)).toEqual([
      'Target is down.',
      'Target is down.',
    ]);
  });
});
