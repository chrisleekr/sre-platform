import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  alertEpisodeIntakes,
  connectorConfigs,
  getAlertEpisodeIntake,
  surfaceBindings,
} from '@sre/db';
import { handleSlackEvent, type SlackEnvelope } from '../slack-inbound';
import { createFixture } from './slack-inbound.fixture';
import { nativeBlocks, seedNativeOpener } from './slack-native-opener.fixture';

const fixture = createFixture();
const connectorIds: string[] = [];
async function seed(state: Parameters<typeof seedNativeOpener>[2], tenantId = fixture.tenantB) {
  const root = state === 'accepted' ? fixture.ROOT_C3 : fixture.nextTs();
  const binding =
    state === 'accepted'
      ? (
          await fixture.admin.db
            .select()
            .from(surfaceBindings)
            .where(eq(surfaceBindings.incidentId, fixture.mentionIncidentId))
        )[0]
      : undefined;
  const row = await seedNativeOpener(
    fixture.app.db,
    tenantId,
    state,
    fixture.CLS_SUB,
    root,
    binding ? { incidentId: fixture.mentionIncidentId, bindingId: binding.id } : undefined,
  );
  connectorIds.push(row.dataSourceId);
  return { row, root };
}
afterEach(async () => {
  if (!connectorIds.length) return;
  await fixture.admin.db
    .delete(alertEpisodeIntakes)
    .where(inArray(alertEpisodeIntakes.dataSourceId, connectorIds));
  await fixture.admin.db
    .delete(connectorConfigs)
    .where(inArray(connectorConfigs.id, connectorIds.splice(0)));
});

const event = (id: string, ts: string, extra: Record<string, unknown> = {}) =>
  fixture.rootEvent({
    subtype: 'bot_message',
    user: undefined,
    bot_id: fixture.SELF_BOT_ID,
    text: '[FIRING:1] Checkout errors are high',
    ts,
    blocks: nativeBlocks(id),
    ...extra,
  });

test.each(['posting', 'posted', 'accepted', 'uncertain'] as const)(
  'suppresses concurrent verified %s echoes without changing native intake',
  async (state) => {
    const { row, root } = await seed(state);
    const before = await getAlertEpisodeIntake(fixture.app.db, fixture.tenantB, row.id);
    const results = await Promise.all([
      fixture.processClassifyEvent(event(row.id, root)),
      fixture.processClassifyEvent(event(row.id, root)),
    ]);
    expect(results).toEqual(['suppressed_native_alert_opener', 'suppressed_native_alert_opener']);
    expect(fixture.classifyEnqueued).toEqual([]);
    expect(fixture.enqueued).toEqual([]);
    expect(await getAlertEpisodeIntake(fixture.app.db, fixture.tenantB, row.id)).toEqual(before);
  },
);

test.each([null, 'same'] as const)('treats thread_ts=%s as an owned root', async (thread) => {
  const { row, root } = await seed('posted');
  expect(
    await fixture.processClassifyEvent(
      event(row.id, root, { thread_ts: thread === 'same' ? root : null }),
    ),
  ).toBe('suppressed_native_alert_opener');
  expect(fixture.classifyEnqueued).toEqual([]);
});

test('reads an edited root from its replacement message and the outer channel', async () => {
  const { row, root } = await seed('posted');
  const replacement = event(row.id, root, {
    channel: undefined,
    edited: { ts: '1900.0002' },
  }).event;
  expect(
    await fixture.processClassifyEvent(
      fixture.rootEvent({
        subtype: 'message_changed',
        bot_id: 'B_OUTER',
        blocks: [],
        event_ts: '1900.0003',
        message: replacement,
      }),
    ),
  ).toBe('suppressed_native_alert_opener');
  expect(fixture.classifyEnqueued).toEqual([]);
});

test.each([
  'pending',
  'rejected',
  'wrong bot',
  'foreign tenant',
  'wrong channel',
  'wrong root',
  'missing intake',
  'malformed marker',
  'missing marker',
  'duplicate marker',
] as const)('does not trust %s ownership', async (variant) => {
  const { row, root } = await seed(
    variant === 'pending' || variant === 'rejected' ? variant : 'posted',
    variant === 'foreign tenant' ? fixture.tenantId : fixture.tenantB,
  );
  const extra: Record<string, unknown> = {};
  if (variant === 'wrong bot') extra.bot_id = 'B_OTHER';
  if (variant === 'wrong channel')
    await fixture.admin.db
      .update(alertEpisodeIntakes)
      .set({ channel: 'C_OTHER' })
      .where(eq(alertEpisodeIntakes.id, row.id));
  if (variant === 'malformed marker') extra.blocks = nativeBlocks('not-a-uuid');
  if (variant === 'missing marker') extra.blocks = [];
  // A valid marker repeated must still fail: exactly one root marker identifies the opener.
  if (variant === 'duplicate marker')
    extra.blocks = [...nativeBlocks(row.id), ...nativeBlocks(row.id)];
  const outcome = await fixture.processClassifyEvent(
    event(
      variant === 'missing intake' ? randomUUID() : row.id,
      variant === 'wrong root' ? fixture.nextTs() : root,
      extra,
    ),
  );
  expect(outcome).toBe('classify_enqueued');
  expect(fixture.classifyEnqueued).toHaveLength(1);
});

test('requires the routed bot identity even when the durable marker matches', async () => {
  const { row, root } = await seed('posted');
  const config = { ...fixture.tenantBConfig(), botId: undefined };
  expect(
    await handleSlackEvent(
      fixture.classifyDeps,
      fixture.classifyConfigId,
      config,
      event(row.id, root) as SlackEnvelope,
    ),
  ).toBe('classify_enqueued');
});

test('ignores previous-message markers when an edited provider root has none', async () => {
  const { row, root } = await seed('posted');
  expect(
    await fixture.processClassifyEvent(
      fixture.rootEvent({
        subtype: 'message_changed',
        previous_message: event(row.id, root).event,
        message: {
          type: 'message',
          subtype: 'bot_message',
          bot_id: fixture.SELF_BOT_ID,
          ts: root,
          text: '[FIRING:1] Checkout errors are high',
        },
      }),
    ),
  ).toBe('edit_enqueued');
  expect(fixture.classifyEnqueued).toHaveLength(1);
});

test('keeps same-app provider roots and human replies with copied markers on ordinary paths', async () => {
  const { row } = await seed('accepted');
  expect(await fixture.processClassifyEvent(event(row.id, fixture.nextTs(), { blocks: [] }))).toBe(
    'classify_enqueued',
  );
  expect(
    await fixture.processClassifyEvent(
      fixture.rootEvent({
        user: 'U_HUMAN',
        thread_ts: fixture.ROOT_C3,
        blocks: nativeBlocks(row.id),
        parent: { blocks: nativeBlocks(row.id) },
      }),
    ),
  ).toBe('resume_enqueued');
  expect(fixture.enqueued).toHaveLength(1);
});

test('never suppresses a bot thread reply using its copied parent marker', async () => {
  const { row, root } = await seed('posted');
  expect(
    await fixture.processClassifyEvent(event(row.id, fixture.nextTs(), { thread_ts: root })),
  ).toBe('dropped_no_candidate');
});
