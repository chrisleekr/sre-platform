import { expect, test, vi } from 'vitest';
import { classifyLifecycleIntent } from '../lifecycle-intent';
import { makeFakeGenerator } from '../engine/fake';

test('structured interpretation receives only the current request, never an actor or target ID', async () => {
  const script = vi.fn((_prompt: string) => ({
    kind: 'action',
    target: 'current',
    to: 'closed',
    reason: 'Responder asked to close this case.',
  }));
  const result = await classifyLifecycleIntent(
    makeFakeGenerator(script),
    'Can you close this incident?',
    new AbortController().signal,
  );
  expect(result).toMatchObject({ kind: 'action', to: 'closed' });
  expect(JSON.parse(script.mock.calls[0]![0]!)).toEqual({
    currentResponderMessage: 'Can you close this incident?',
  });
});

test.each([
  { kind: 'action', target: 'other', to: 'closed', reason: 'Wrong target' },
  {
    kind: 'action',
    target: 'current',
    to: 'closed',
    reason: 'Spoofed actor',
    actorUserId: 'admin',
  },
  { kind: 'action', target: 'current', to: null, reason: 'Missing transition' },
  { kind: 'investigate', target: 'current', to: 'closed', reason: 'Hidden action' },
])('invalid or expanded model authority is rejected', async (value) => {
  await expect(
    classifyLifecycleIntent(
      makeFakeGenerator(() => value),
      'Should we close?',
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

test('accepts a capture-only alternative offer without granting external-write authority', async () => {
  const result = await classifyLifecycleIntent(
    makeFakeGenerator(() => ({
      kind: 'offer_capture_knowledge',
      target: 'current',
      to: null,
      reason:
        'GitLab issue creation is unavailable; offer to save a diagnostic guide in the platform.',
    })),
    'Create a GitLab issue from these recommendations.',
    new AbortController().signal,
  );
  expect(result).toMatchObject({ kind: 'offer_capture_knowledge', target: 'current', to: null });
});
