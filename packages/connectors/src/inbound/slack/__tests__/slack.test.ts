import { describe, expect, test } from 'vitest';
import { slackInboundConnector } from '../connector';

// Our connected app may own both the incident bot and an Alertmanager incoming webhook.
const ctx = { botUserId: 'U_BOT' };

const normalizedCandidate = (event: unknown, context = ctx) => {
  const evaluation = slackInboundConnector.evaluate(event, context);
  return evaluation?.disposition === 'admit' ? evaluation.candidate : null;
};

describe('slackInboundConnector', () => {
  test('C1 returns candidate for a top-level human message', () => {
    const event = {
      type: 'message',
      channel: 'C123',
      ts: '1783073195.987819',
      user: 'U_HUMAN',
      text: '  checkout is down  ',
    };
    const result = normalizedCandidate(event, ctx);
    expect(result).toMatchObject({
      externalId: '1783073195.987819',
      channel: 'C123',
      author: 'human',
      text: 'checkout is down',
    });
    expect(result!.raw).toBe(event);
  });

  test('C2 returns null for a human thread reply', () => {
    const event = {
      type: 'message',
      channel: 'C123',
      ts: '1783073195.987819',
      user: 'U_HUMAN',
      text: 'checkout is down',
      thread_ts: '1783000000.0001',
    };
    expect(normalizedCandidate(event, ctx)).toBeNull();
  });

  test('keeps an Alertmanager resolution posted inside the original alert thread', () => {
    const event = {
      type: 'message',
      subtype: 'bot_message',
      channel: 'C123',
      ts: '1787404155.534499',
      thread_ts: '1787403855.537859',
      bot_id: 'B_ALERT',
      text: '',
      attachments: [
        {
          fallback:
            '[RESOLVED] monitoring (NodeSystemSaturation node-exporter 192.168.1.203:9100 warning) | <http://alertmanager.example/#/alerts?receiver=default>',
        },
      ],
    };

    expect(normalizedCandidate(event, ctx)).toMatchObject({
      externalId: '1787404155.534499',
      producerId: 'bot:B_ALERT',
      signalState: 'resolved',
      isEdit: false,
    });
  });

  test('drops a non-terminal bot reply so platform thread output cannot become a new alert', () => {
    expect(
      normalizedCandidate(
        {
          type: 'message',
          subtype: 'bot_message',
          channel: 'C123',
          ts: '1787404156.000001',
          thread_ts: '1787403855.537859',
          bot_id: 'B_ALERT',
          text: 'Investigation update: still checking the node.',
        },
        ctx,
      ),
    ).toBeNull();
  });

  test('C3 keeps same-app root posts as bot candidates; thread topology prevents egress loops', () => {
    const byUser = {
      type: 'message',
      channel: 'C123',
      ts: '1.2',
      user: 'U_BOT',
      text: 'i am the assistant',
    };
    expect(normalizedCandidate(byUser, ctx)).toMatchObject({ author: 'bot' });

    // Same app, bot_id-only is the shape used by its incoming webhook.
    const byBotId = {
      type: 'message',
      channel: 'C123',
      ts: '1.3',
      bot_id: 'B_BOT',
      text: 'i am the assistant',
    };
    expect(normalizedCandidate(byBotId, ctx)).toMatchObject({ author: 'bot' });
  });

  test('C4 returns null for a thread_broadcast reply', () => {
    // A thread_broadcast is a reply (dropped by the subtype gate; it also carries thread_ts), so it is
    // the resume path, not a candidate.
    const broadcast = {
      type: 'message',
      subtype: 'thread_broadcast',
      channel: 'C123',
      ts: '1.4',
      thread_ts: '1783000000.0001',
      user: 'U_HUMAN',
      text: 'also posting to the channel',
    };
    expect(normalizedCandidate(broadcast, ctx)).toBeNull();
  });

  test('C4 normalizes a message_changed edit for tracked-signal processing', () => {
    const edit = {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C123',
      ts: '1.2',
      user: 'U_HUMAN',
      text: 'edited text',
    };
    expect(normalizedCandidate(edit, ctx)).toMatchObject({
      externalId: '1.2',
      text: 'edited text',
      isEdit: true,
      signalState: 'unknown',
    });

    const join = {
      type: 'message',
      subtype: 'channel_join',
      channel: 'C123',
      ts: '1.2',
      user: 'U_HUMAN',
      text: 'has joined the channel',
    };
    expect(normalizedCandidate(join, ctx)).toBeNull();
  });

  test('keeps an edited root when Slack sets thread_ts equal to its own ts', () => {
    const ts = '1787401655.958289';
    expect(
      normalizedCandidate(
        {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C123',
          event_ts: '1787402032.000100',
          message: {
            type: 'message',
            subtype: 'bot_message',
            bot_id: 'B_ALERT',
            ts,
            thread_ts: ts,
            text: '[FIRING:1] CheckoutHighErrorRate',
          },
        },
        ctx,
      ),
    ).toMatchObject({
      externalId: ts,
      isEdit: true,
      signalState: 'firing',
      alertKind: 'firing',
    });
  });

  test('uses the nested replacement identity and recognizes Alertmanager resolved titles', () => {
    const candidate = normalizedCandidate(
      {
        type: 'message',
        subtype: 'message_changed',
        channel: 'C123',
        event_ts: '1787280180.000200',
        message: {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'B_ALERT',
          ts: '1787280000.000100',
          edited: { ts: '1787280180.000200' },
          text: '',
          attachments: [
            {
              title: '[RESOLVED] CheckoutHighErrorRate',
              title_link: 'https://alerts.example/1',
            },
          ],
        },
      },
      ctx,
    );

    expect(candidate).toMatchObject({
      externalId: '1787280000.000100',
      signalState: 'resolved',
      isEdit: true,
      eventKey: 'slack:C123:1787280000.000100:edit:1787280180.000200:producer:bot:B_ALERT',
      producerId: 'bot:B_ALERT',
      eventAt: '2026-08-21T02:43:00.000Z',
      eventVersion: '1787280180000200',
    });
    expect(candidate?.text).toContain(
      '<https://alerts.example/1|[RESOLVED] CheckoutHighErrorRate>',
    );
  });

  test('C5 keeps another bot as author=bot', () => {
    const event = {
      type: 'message',
      channel: 'C123',
      ts: '1.2',
      bot_id: 'B_ALERT',
      user: 'U_ALERTBOT',
      text: 'PagerDuty: sev2',
    };
    expect(normalizedCandidate(event, ctx)).toMatchObject({
      author: 'bot',
      text: 'PagerDuty: sev2',
    });
  });

  test('C5 keeps an alerting bot posting with the bot_message subtype (no user)', () => {
    // Classic bots / incoming webhooks post content as subtype=bot_message with no user field.
    const event = {
      type: 'message',
      subtype: 'bot_message',
      channel: 'C123',
      ts: '1.5',
      bot_id: 'B_ALERT',
      text: 'AlertManager: HighErrorRate firing',
    };
    expect(normalizedCandidate(event, ctx)).toMatchObject({
      author: 'bot',
      text: 'AlertManager: HighErrorRate firing',
      alertKind: 'firing',
    });
  });

  test.each([
    ['fallback', { fallback: 'Alertmanager fallback' }, 'Alertmanager fallback'],
    ['pretext', { fallback: ' ', pretext: 'Alertmanager pretext' }, 'Alertmanager pretext'],
    ['title', { pretext: '', title: 'Alertmanager title' }, 'Alertmanager title'],
    ['text', { title: ' ', text: 'Alertmanager attachment text' }, 'Alertmanager attachment text'],
    ['fields', { text: '', fields: [{ title: 'Severity', value: 'critical' }] }, 'critical'],
  ])(
    'C13 derives attachment-only bot_message text from %s and preserves raw',
    (_source, attachment, expected) => {
      const event = {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1.8',
        bot_id: 'B_ALERT',
        text: '   ',
        attachments: [attachment],
      };

      const candidate = normalizedCandidate(event, ctx);

      expect(candidate).not.toBeNull();
      expect(candidate!.text.trim()).not.toBe('');
      expect(candidate!.text).toContain(expected);
      expect(candidate!.raw).toBe(event);
    },
  );

  test('C14 keeps nonempty top-level text authoritative over attachment text', () => {
    const event = {
      type: 'message',
      subtype: 'bot_message',
      channel: 'C123',
      ts: '1.9',
      bot_id: 'B_ALERT',
      text: 'Top-level alert summary',
      attachments: [{ fallback: 'Attachment fallback must not replace the summary' }],
    };

    expect(normalizedCandidate(event, ctx)?.text).toBe('Top-level alert summary');
  });

  test('C14 drops attachments with no usable text and preserves thread and subtype guards', () => {
    const base = {
      type: 'message',
      subtype: 'bot_message',
      channel: 'C123',
      ts: '2.0',
      bot_id: 'B_ALERT',
      text: '',
      attachments: [{ fallback: ' ', pretext: '', title: '', text: '', fields: [] }],
    };
    expect(normalizedCandidate(base, ctx)).toBeNull();
    expect(
      normalizedCandidate(
        { ...base, attachments: [{ fallback: 'thread alert' }], thread_ts: '1.0' },
        ctx,
      ),
    ).toBeNull();
    expect(
      normalizedCandidate(
        {
          ...base,
          subtype: 'message_changed',
          attachments: [{ fallback: 'edited alert' }],
        },
        ctx,
      ),
    ).toMatchObject({ text: 'edited alert', isEdit: true, signalState: 'firing' });
    expect(
      normalizedCandidate(
        { ...base, bot_id: 'B_BOT', attachments: [{ fallback: 'self alert' }] },
        ctx,
      ),
    ).toMatchObject({ author: 'bot', text: 'self alert' });
  });

  test('C3 identifies the connected bot user when botId context is absent', () => {
    const noBotId = { botUserId: 'U_BOT' };
    // A same-app root remains a valid candidate and is classified as automated.
    const ours = { type: 'message', channel: 'C123', ts: '1.6', user: 'U_BOT', text: 'assistant' };
    expect(normalizedCandidate(ours, noBotId)).toMatchObject({ author: 'bot' });
    const botOnly = { type: 'message', channel: 'C123', ts: '1.7', bot_id: 'B_BOT', text: 'alert' };
    expect(normalizedCandidate(botOnly, noBotId)).toMatchObject({ author: 'bot' });
  });

  test('keeps the complete deduplicated Alertmanager attachment context', () => {
    const candidate = normalizedCandidate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1.10',
        bot_id: 'B_BOT',
        text: '',
        attachments: [
          {
            fallback: 'System saturated, load per core is very high.',
            title: 'System saturated, load per core is very high.',
            fields: [
              { title: 'Description', value: 'Load per core is 3.95.' },
              { title: 'Severity', value: 'warning' },
              { title: 'Source', value: 'Prometheus Alertmanager' },
            ],
          },
        ],
      },
      ctx,
    );

    expect(candidate?.text).toBe(
      [
        'System saturated, load per core is very high.',
        'Description: Load per core is 3.95.',
        'Severity: warning',
        'Source: Prometheus Alertmanager',
      ].join('\n'),
    );
    expect(candidate?.alertKind).toBe('firing');
  });

  test.each([
    {
      name: 'StatusCake outage',
      event: {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991000.000080',
        bot_id: 'B_STATUSCAKE',
        text: "Website | Your site '<https://example.com|example.com>' went Down [HTTP 504]",
      },
    },
    {
      name: 'StatusCake certificate reminder',
      event: {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991000.000081',
        bot_id: 'B_STATUSCAKE',
        text: '',
        attachments: [
          {
            title: 'SSL Monitoring: https://example.com - Expiration Reminder',
            text: 'The SSL certificate for this website will expire in 30 days.',
            footer: 'StatusCake SSL Monitoring',
          },
        ],
      },
    },
  ])('recognizes the $name as a firing provider notification', ({ event }) => {
    expect(normalizedCandidate(event, ctx)).toMatchObject({
      author: 'bot',
      alertKind: 'firing',
    });
  });

  // Two shapes per line-anchored alternative in `firingProviderShape`, each with and without
  // indentation. No row carries a `[FIRING]` marker, so the bracket alternative cannot mask a
  // regression in the anchored one. The blank-line row is the case narrowing `\s*` to `[^\S\n]*`
  // could plausibly have broken: the anchor relocates to the last newline of the run.
  test.each([
    ['a marker at the start of a line', 'Monitoring update\n*Alert:* Checkout latency is high.'],
    ['a marker indented on its line', 'Monitoring update\n  *Alert:* Checkout latency is high.'],
    ['a marker after a blank line', 'Monitoring update\n\n  *Alert:* Checkout latency is high.'],
    ['bare firing-alert prose', 'Monitoring update\nfiring alert on checkout'],
    ['indented firing-alert prose', 'Monitoring update\n  firing alert on checkout'],
  ])('reads a provider firing shape from %s', (_shape, text) => {
    const candidate = normalizedCandidate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991000.000084',
        bot_id: 'B_ALERT',
        text,
      },
      ctx,
    );

    expect(candidate?.alertKind).toBe('firing');
  });

  test('does not mark a failed deployment notice as a provider alert', () => {
    const candidate = normalizedCandidate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991000.000082',
        bot_id: 'B_DEPLOY',
        text: 'Deployment failed for checkout-api',
      },
      ctx,
    );

    expect(candidate).toMatchObject({ author: 'bot' });
    expect(candidate?.alertKind).toBeUndefined();
  });

  test('does not infer an alert from generic severity and description fields', () => {
    const candidate = normalizedCandidate(
      {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        ts: '1787991000.000083',
        bot_id: 'B_DEPLOY',
        text: '',
        attachments: [
          {
            title: 'Deployment status',
            fields: [
              { title: 'Description', value: 'checkout-api rollout failed' },
              { title: 'Severity', value: 'warning' },
            ],
          },
        ],
      },
      ctx,
    );

    expect(candidate).toMatchObject({ author: 'bot' });
    expect(candidate?.alertKind).toBeUndefined();
  });

  test('C8 returns null for empty/whitespace text', () => {
    const event = {
      type: 'message',
      channel: 'C123',
      ts: '1.2',
      user: 'U_HUMAN',
      text: '   ',
    };
    expect(normalizedCandidate(event, ctx)).toBeNull();
  });

  test('C8 returns null for a non-message event type', () => {
    const event = {
      type: 'reaction_added',
      channel: 'C123',
      ts: '1.2',
      user: 'U_HUMAN',
      text: 'checkout is down',
    };
    expect(normalizedCandidate(event, ctx)).toBeNull();
  });

  test('C8 returns null for a non-object event', () => {
    expect(normalizedCandidate(null, ctx)).toBeNull();
    expect(normalizedCandidate('x', ctx)).toBeNull();
  });
});

describe('uptime lifecycle normalization', () => {
  const notice = (state: 'Up' | 'Down', url = 'https://checkout.example/health?region=west') =>
    `Website | Your site '<${url}|checkout>' went ${state} [HTTP ${state === 'Up' ? 200 : 503}]`;
  const candidate = (text: string, attachments?: unknown[]) =>
    normalizedCandidate({
      type: 'message',
      subtype: 'bot_message',
      channel: 'C_UPTIME',
      ts: '1787991000.000100',
      bot_id: 'B_UPTIME',
      text,
      attachments,
    });

  test.each(['text', 'attachment', 'fallback'] as const)(
    'normalizes %s Up and Down with stable monitor identity',
    (shape) => {
      const read = (state: 'Up' | 'Down') =>
        shape === 'text'
          ? candidate(notice(state))
          : candidate('', [
              {
                fallback: shape === 'fallback' ? 'Monitor notification' : '',
                title: notice(state),
              },
            ]);
      const down = read('Down');
      const up = read('Up');
      expect(down).toMatchObject({ signalState: 'firing', alertKind: 'firing' });
      expect(up).toMatchObject({ signalState: 'resolved' });
      expect(down?.observations).toHaveLength(1);
      expect(up?.observations).toHaveLength(1);
      expect(down?.observations?.[0]?.monitorKey).toEqual(expect.any(String));
      expect(up?.observations?.[0]?.monitorKey).toBe(down?.observations?.[0]?.monitorKey);
      expect(up?.observations?.[0]).toMatchObject({
        state: 'resolved',
        provider: expect.any(String),
      });
    },
  );

  test('full monitored URL distinguishes scheme, port, path and query', () => {
    const urls = [
      'https://checkout.example/health?region=west',
      'http://checkout.example/health?region=west',
      'https://checkout.example:8443/health?region=west',
      'https://checkout.example/other?region=west',
      'https://checkout.example/health?region=east',
    ];
    const keys = urls.map((url) => candidate(notice('Down', url))?.observations?.[0]?.monitorKey);
    expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(urls.length);
  });

  test('human prose matching a provider template is not an authoritative recovery', () => {
    expect(
      normalizedCandidate({
        type: 'message',
        channel: 'C_UPTIME',
        ts: '1787991000.000100',
        user: 'U_HUMAN',
        text: notice('Up'),
      }),
    ).toMatchObject({ author: 'human', signalState: 'unknown' });
  });
});
