import { describe, expect, test } from 'vitest';

import { makeSlackPoster } from '../index';

import type { HubMessage } from '@sre/hub';

import { createFixture } from './slack.fixture';

const __fixture = createFixture();

// the Slack mirror of a postmortem-ready message links to the postmortem page, not the
// incident workspace. 'postmortem' is not a HubMessage kind at HEAD (Phase B adds it), so the literal
// is widened through string to compile against the current type.
const postmortemKind: string = 'postmortem';
const postmortem = postmortemKind as HubMessage['kind'];

describe('slack postmortem link', () => {
  test('a system postmortem message links to the postmortem page instead of the incident', async () => {
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, ts: '1' });
    await makeSlackPoster(fetch).post(
      __fixture.bound('B', 'C'),
      'ROOT',
      __fixture.msg({
        author: 'system',
        kind: postmortem,
        content: 'Postmortem draft ready for review.',
      }),
      'https://app.example.com/w/incidents/i1/postmortem',
    );
    const text = calls[0]!.body.text as string;
    expect(text).toContain('Postmortem draft ready for review.');
    expect(text).toContain(
      'Postmortem: <https://app.example.com/w/incidents/i1/postmortem|Open postmortem>',
    );
    expect(text).not.toContain('Open incident');
  });
});
