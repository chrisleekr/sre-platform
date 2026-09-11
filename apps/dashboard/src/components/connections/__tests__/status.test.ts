import { describe, expect, test } from 'vitest';
import type { ConnectorSummary } from '../../../lib/connectors';
import { accessEvidence, activityEvidence, slackEvidence } from '../status';

const base: ConnectorSummary = {
  id: 'metrics',
  name: 'Metrics',
  type: 'prometheus',
  settings: { eventTransport: 'direct' },
  enabled: true,
  credentialConfigured: true,
  verification: {
    lastAttemptAt: '2026-09-08T10:00:00Z',
    lastSuccessAt: '2026-09-08T09:00:00Z',
    failureCategory: null,
  },
};
describe('connection evidence', () => {
  test.each(['datadog', 'grafana'])('keeps unfinished %s verification actionable', (type) => {
    const saved = {
      ...base,
      type,
      enabled: false,
      verification: { lastAttemptAt: null, lastSuccessAt: null, failureCategory: null },
    };
    expect(accessEvidence(saved)).toMatchObject({ label: 'Not verified', attention: true });
    expect(activityEvidence(saved)).toMatchObject({ label: 'On demand', attention: false });
    expect(accessEvidence({ ...saved, verification: base.verification })).toMatchObject({
      label: 'Disabled',
      attention: false,
    });
  });
  test('does not let an old verification success hide the latest failure', () => {
    expect(
      accessEvidence({
        ...base,
        verification: { ...base.verification!, failureCategory: 'permission_denied' },
      }),
    ).toMatchObject({ label: 'Verification failed', attention: true });
  });
  test('distinguishes optional delivery from unconfirmed and failed delivery', () => {
    expect(activityEvidence({ ...base, settings: { eventTransport: 'none' } })).toMatchObject({
      label: 'Events not configured',
      attention: false,
    });
    expect(activityEvidence(base)).toMatchObject({
      label: 'Awaiting first event',
      attention: true,
    });
    expect(
      activityEvidence({
        ...base,
        events: {
          lastAttemptAt: null,
          lastSuccessAt: null,
          count: 0,
          failureCategory: 'invalid_payload',
        },
      }),
    ).toMatchObject({ label: 'Event delivery failed', attention: true });
  });
  test('reports polling failures even after a successful verification', () => {
    const c = {
      ...base,
      type: 'argocd',
      polling: {
        lastAttemptAt: null,
        lastSuccessAt: null,
        snapshotCount: 0,
        errorCount: 1,
        failureCategory: 'unreachable',
      },
    };
    expect(accessEvidence(c).label).toBe('Verified');
    expect(activityEvidence(c)).toMatchObject({ label: 'Polling failed', attention: true });
  });
  test('does not infer continuously healthy access from enabled alone', () => {
    expect(accessEvidence({ ...base, verification: undefined }).label).toBe('Not verified');
  });
  test('a successful event cannot hide a failed poll on a dual-capability connection', () => {
    expect(
      activityEvidence({
        ...base,
        events: {
          lastAttemptAt: null,
          lastSuccessAt: '2026-09-08T10:00:00Z',
          count: 1,
          failureCategory: null,
        },
        polling: {
          lastAttemptAt: null,
          lastSuccessAt: null,
          snapshotCount: 0,
          errorCount: 1,
          failureCategory: 'unreachable',
        },
      }),
    ).toMatchObject({ label: 'Polling failed', attention: true });
  });
  test('does not call a configured Slack socket connected without runtime evidence', () => {
    expect(
      slackEvidence({
        id: 'slack',
        surface: 'slack',
        botUserId: null,
        hasAppToken: true,
        hasBotToken: true,
      }).access,
    ).toMatchObject({ label: 'Configured', attention: true });
  });
});
