import { describe, expect, test } from 'vitest';

import { SurfaceRegistry } from '@sre/surfaces';

import { fanoutHubMessage } from '../fanout';

import { createFixture } from './fanout.fixture';

const __fixture = createFixture();

// a system `postmortem` line is mirrored to the bound thread with a deep link to the postmortem
// page, not the incident page, so a responder lands on the draft they were asked to review.
describe('fanoutHubMessage postmortem notices', () => {
  test('posts the postmortem line once with the postmortem deep link', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);

    await fanoutHubMessage(
      __fixture.liveDeps(registry, { dashboardBaseUrl: 'https://app.example.com' }),
      __fixture.msg({
        id: 'postmortem-1',
        author: 'system',
        kind: 'postmortem',
        content: 'Postmortem draft ready for review.',
        originMessageId: 'postmortem:job-1',
      }),
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]!.thread).toBe(__fixture.BOUND_THREAD);
    expect(posts[0]!.link).toBe('https://app.example.com/w/incidents/i1/postmortem');
    expect(updates).toHaveLength(0);
  });

  test('a postmortem line does not consume the working post of a live investigation', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const deps = __fixture.liveDeps(registry, { dashboardBaseUrl: 'https://app.example.com' });

    await fanoutHubMessage(deps, __fixture.msg({ id: 'activity', kind: 'tool_step' }));
    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'pm', author: 'system', kind: 'postmortem', content: 'Draft ready.' }),
    );
    await fanoutHubMessage(deps, __fixture.msg({ id: 'finding', kind: 'finding' }));

    // Working post (ts1), then the postmortem line (ts2); the finding updates ts1 in place.
    expect(posts.map((post) => post.msg.id)).toEqual(['activity', 'pm']);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: 'ts1', msg: { id: 'finding' } });
  });
});
