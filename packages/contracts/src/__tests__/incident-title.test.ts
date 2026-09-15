import { expect, test } from 'vitest';
import { meaningfulIncidentTitle, openingIncidentTitle } from '../incident-title';

test('normalizes provider addressing without converting uncertainty to a diagnosis', () => {
  expect(meaningfulIncidentTitle('<@U123|Name> <@U456> Could checkout be overloaded?')).toBe(
    'Could checkout be overloaded?',
  );
  expect(meaningfulIncidentTitle('<@U123>')).toBeNull();
  expect(meaningfulIncidentTitle('Investigation requested in Slack')).toBeNull();
  expect(meaningfulIncidentTitle('Possible database saturation')).toBe(
    'Possible database saturation',
  );
});
test('uses the root excerpt rather than choosing convenient later conversation', () => {
  expect(
    openingIncidentTitle(
      '<@U123>',
      '[UROOT]: Check cluster health?\n[ULATER]: Everything has failed',
    ),
  ).toEqual({ displayTitle: 'Check cluster health?', titleSource: 'opening_context' });
  expect(
    openingIncidentTitle('<@U123>', '[UROOT]: <@U456>\n[ULATER]: Everything has failed')
      .titleSource,
  ).toBe('missing');
});
test('bounds untrusted text and scrubs recognized credentials', () => {
  expect(meaningfulIncidentTitle('Bearer abcdefghijklmnop request failed')).not.toContain(
    'abcdefghijklmnop',
  );
  expect([...(meaningfulIncidentTitle('😀check '.repeat(100)) ?? '')]).toHaveLength(160);
  expect(meaningfulIncidentTitle('<img src=x onerror=bad>Check latency')).toBe('Check latency');
});

test.each([
  [
    '[UROOT]: <@U123>\nCheckout is timing out\n[ULATER]: Unrelated deployment failed',
    'Checkout is timing out',
  ],
  [
    '[UROOT]: Hello team\nCan we check cluster health?\n[ULATER]: Roll back payments',
    'Can we check cluster health?',
  ],
  ['[UROOT]: Hello team!\n[ULATER]: Unrelated deployment failed', 'Issue not described'],
])(
  'uses the complete first attributed message without borrowing later chatter',
  (thread, expected) => {
    expect(openingIncidentTitle('<@U123>', thread).displayTitle).toBe(expected);
  },
);

test.each(['<script<script>>Check latency', '<img src=x onerror=bad', 'Check < latency > now'])(
  'does not retain markup delimiters in a title: %s',
  (value) => {
    expect(meaningfulIncidentTitle(value)).not.toMatch(/[<>]/);
  },
);
