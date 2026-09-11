import { seedMembership } from '@sre/db/test-support';
import { beforeAll, describe, expect, test } from 'vitest';
import { listIncidentTags, persistSurfaceIdentity } from '@sre/db';
import { createFixture } from './slack-inbound.fixture';

const __fixture = createFixture();
const TAG_USER = 'U_TAG_COMMAND';

beforeAll(async () => {
  const userId = await seedMembership(
    __fixture.admin.db,
    {
      issuer: __fixture.ATTR_ISSUER,
      subject: __fixture.ATTR_SUBJECT,
      email: __fixture.ATTR_EMAIL,
    },
    __fixture.tenantB,
  );
  await persistSurfaceIdentity(__fixture.app.db, __fixture.tenantB, {
    surface: 'slack',
    surfaceUserId: TAG_USER,
    authorUserId: userId,
    source: 'test',
  });
});

describe('Slack incident tag commands', () => {
  test('adds, lists, and removes tags on a bound incident without a resume job', async () => {
    const command = (text: string) =>
      __fixture.processClassifyEvent(
        __fixture.mentionEvent({
          channel: __fixture.CLS_SUB,
          thread_ts: __fixture.ROOT_C3,
          ts: __fixture.nextTs(),
          user: TAG_USER,
          text: `<@${__fixture.SELF_BOT}> ${text}`,
        }),
      );

    await expect(command('tag cause:network')).resolves.toBe('tag_command_handled');
    await expect(
      listIncidentTags(__fixture.app.db, __fixture.tenantB, __fixture.mentionIncidentId),
    ).resolves.toEqual([expect.objectContaining({ tag: 'cause:network', source: 'slack' })]);

    await expect(command('tags')).resolves.toBe('tag_command_handled');
    expect(
      (await __fixture.hub.history(__fixture.tenantB, __fixture.mentionIncidentId)).some(
        (message) => message.author === 'system' && message.content === 'Tags: cause:network',
      ),
    ).toBe(true);

    await expect(command('untag cause:network')).resolves.toBe('tag_command_handled');
    await expect(
      listIncidentTags(__fixture.app.db, __fixture.tenantB, __fixture.mentionIncidentId),
    ).resolves.toEqual([]);
    expect(__fixture.enqueued).toEqual([]);
  });
});
