import { describe, expect, test } from 'vitest';

import { SURFACE_MIRRORED_KINDS, shouldMirrorToSurfaces, type MessageKind } from '../hub';

// a "postmortem draft ready" system message must reach the incident's Slack thread, unlike
// ordinary system narration. 'postmortem' is not a MessageKind at HEAD, so the literal is widened
// through string to keep the file compiling until the hub contract grows the kind.
const postmortemKind: string = 'postmortem';
const postmortem = postmortemKind as MessageKind;

describe('postmortem hub kind policy', () => {
  test('postmortem is a surface-mirrored kind', () => {
    expect(SURFACE_MIRRORED_KINDS.has('postmortem')).toBe(true);
  });

  test('a system postmortem message mirrors to surfaces', () => {
    expect(shouldMirrorToSurfaces({ author: 'system', kind: postmortem })).toBe(true);
  });

  test('plain system text still stays in the hub', () => {
    expect(shouldMirrorToSurfaces({ author: 'system', kind: 'text' })).toBe(false);
  });
});
