import { describe, expect, test } from 'vitest';
import type { InboundCandidate } from '@sre/connectors';
import { fingerprintFor } from '../classify-consumer/core';

function promotedEdit(overrides: Partial<InboundCandidate> = {}): InboundCandidate {
  return {
    kind: 'root',
    intakeId: 'intake-1',
    externalId: '1788200000.000001',
    channel: 'C_ALERTS',
    author: 'bot',
    producerId: 'bot:B_ALERTS',
    text: '[FIRING:1] checkout errors',
    raw: null,
    signalState: 'firing',
    alertKind: 'firing',
    eventKey: 'slack:C_ALERTS:1788200010.000001:producer:bot:B_ALERTS',
    eventVersion: '1788200010000001',
    eventAt: '2026-09-01T00:00:10.000Z',
    contentHash: 'hash',
    isEdit: false,
    ...overrides,
  };
}

describe('Slack classify fingerprints', () => {
  test('keeps promoted edits for one provider message on one incident identity', () => {
    const first = promotedEdit();
    const later = promotedEdit({
      intakeId: 'intake-2',
      text: '[FIRING:1] checkout errors remain high',
      eventKey: 'slack:C_ALERTS:1788200020.000001:producer:bot:B_ALERTS',
      eventVersion: '1788200020000001',
      eventAt: '2026-09-01T00:00:20.000Z',
      contentHash: 'later-hash',
    });

    expect(fingerprintFor(first)).toBe(fingerprintFor(later));
  });

  test('does not collapse unrelated promoted edits whose raw payload was discarded', () => {
    const first = fingerprintFor(promotedEdit());
    const otherMessage = fingerprintFor(
      promotedEdit({ intakeId: 'intake-2', externalId: '1788200001.000001' }),
    );
    const otherProducer = fingerprintFor(promotedEdit({ producerId: 'bot:B_OTHER' }));

    expect(otherMessage).not.toBe(first);
    expect(otherProducer).not.toBe(first);
  });
});
