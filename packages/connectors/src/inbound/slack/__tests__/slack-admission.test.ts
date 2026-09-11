import { describe, expect, test } from 'vitest';
import { slackInboundConnector } from '../connector';

const ctx = { botUserId: 'U_BOT' };

describe('Slack provider admission', () => {
  test('suppresses an explicit provider null-receiver notification', () => {
    const event = {
      type: 'message',
      subtype: 'bot_message',
      channel: 'C123',
      ts: '1787991001.000100',
      bot_id: 'B_ALERT',
      text: '',
      attachments: [
        {
          fallback: '[FIRING:1] internal control notification',
          fields: [
            { title: 'Description', value: 'This is an internal alert.' },
            { title: 'Severity', value: 'none' },
            { title: 'Routing', value: 'It should be routed to a null receiver.' },
          ],
        },
      ],
    };

    expect(slackInboundConnector.evaluate(event, ctx)).toMatchObject({
      disposition: 'suppress',
      reason: 'provider_control_notification',
      candidate: { channel: 'C123', externalId: '1787991001.000100' },
    });
  });

  test('preserves Alertmanager control semantics when descriptive prose changes', () => {
    expect(
      slackInboundConnector.evaluate(
        {
          type: 'message',
          subtype: 'bot_message',
          channel: 'C123',
          ts: '1787991001.000200',
          bot_id: 'B_ALERT',
          text: '',
          attachments: [
            {
              fallback:
                '[FIRING:1] InfoInhibitor monitoring | <https://alerts.example/#/alerts?receiver=default>',
              text: [
                '*Alert:* Informational alert inhibition.',
                '*Description:* Provider-maintained inhibition state; wording may evolve.',
                '*Severity:* `none`',
                '*Source:* Prometheus Alertmanager',
              ].join(' '),
            },
          ],
        },
        ctx,
      ),
    ).toMatchObject({
      disposition: 'suppress',
      reason: 'provider_control_notification',
      candidate: { channel: 'C123', externalId: '1787991001.000200' },
    });
  });

  test('uses structured attachment severity when alert-title text omits it', () => {
    const evaluation = slackInboundConnector.evaluate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991001.000250',
        bot_id: 'B_ALERT',
        text: '*Alert:* InfoInhibitor',
        attachments: [
          {
            fallback: 'Provider control notification',
            fields: [
              { title: 'Severity', value: 'none' },
              { title: 'Receiver', value: 'null' },
            ],
          },
        ],
      },
      ctx,
    );

    expect(evaluation).toMatchObject({
      disposition: 'suppress',
      reason: 'provider_control_notification',
    });
  });

  test('admits a mixed control shape when any explicit severity is actionable', () => {
    const evaluation = slackInboundConnector.evaluate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991001.000260',
        bot_id: 'B_ALERT',
        text: '*Alert:* InfoInhibitor *Severity:* critical',
        attachments: [
          {
            fallback: 'Provider control notification',
            fields: [
              { title: 'Severity', value: 'none' },
              { title: 'Receiver', value: 'null' },
            ],
          },
        ],
      },
      ctx,
    );

    expect(evaluation?.disposition).toBe('admit');
  });

  test('admits when block severity is none but a structured severity is actionable', () => {
    const evaluation = slackInboundConnector.evaluate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991001.000270',
        bot_id: 'B_ALERT',
        text: '*Alert:* InfoInhibitor *Severity:* none',
        attachments: [
          {
            fields: [
              { title: 'Severity', value: 'critical' },
              { title: 'Receiver', value: 'null' },
            ],
          },
        ],
      },
      ctx,
    );

    expect(evaluation?.disposition).toBe('admit');
  });

  test('admits when duplicate structured severity fields include an actionable value', () => {
    const evaluation = slackInboundConnector.evaluate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991001.000280',
        bot_id: 'B_ALERT',
        text: '[FIRING:1] provider notification',
        attachments: [
          {
            fields: [
              { title: 'Severity', value: 'critical' },
              { title: 'Severity', value: 'none' },
              { title: 'Receiver', value: 'null' },
            ],
          },
        ],
      },
      ctx,
    );

    expect(evaluation?.disposition).toBe('admit');
  });

  test.each([
    'This alert should not be routed to a null receiver.',
    'Do not route this alert to a null receiver.',
    'This alert must never route to a null receiver.',
    'Route this alert to a non-null receiver.',
    "This alert shouldn't route to a null receiver.",
    "This alert don't route to a null receiver.",
    'Avoid routing this alert to a null receiver.',
  ])('admits negated null-receiver wording: %s', (description) => {
    const evaluation = slackInboundConnector.evaluate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991001.000300',
        bot_id: 'B_ALERT',
        text: '',
        attachments: [
          {
            fallback: '[FIRING:1] application notification',
            fields: [
              { title: 'Description', value: description },
              { title: 'Severity', value: 'none' },
            ],
          },
        ],
      },
      ctx,
    );
    expect(evaluation?.disposition).toBe('admit');
  });
});
