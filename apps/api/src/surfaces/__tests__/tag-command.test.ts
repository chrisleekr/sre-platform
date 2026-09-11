import { describe, expect, test } from 'vitest';
import { parseIncidentTagCommand } from '../slack-inbound/tag-command';

describe('Slack incident tag commands', () => {
  test.each([
    ['tag cause:network', { kind: 'add', tag: 'cause:network' }],
    ['UNTAG bogus', { kind: 'remove', tag: 'bogus' }],
    ['tags', { kind: 'list' }],
    ['Tags.', { kind: 'list' }],
  ])('parses the explicit command %s', (text, expected) => {
    expect(parseIncidentTagCommand(text)).toEqual(expected);
  });

  test.each(['show tags', 'tagged cause:network', 'please untag bogus', 'tags are useful'])(
    'does not intercept free-form responder text %s',
    (text) => {
      expect(parseIncidentTagCommand(text)).toBeNull();
    },
  );
});
