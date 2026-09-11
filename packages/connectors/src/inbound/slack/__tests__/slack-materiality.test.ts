import { describe, expect, test } from 'vitest';
import { slackInboundConnector } from '../connector';

const ctx = { botUserId: 'U_BOT' };

const normalizedCandidate = (event: unknown, context = ctx) => {
  const evaluation = slackInboundConnector.evaluate(event, context);
  return evaluation?.disposition === 'admit' ? evaluation.candidate : null;
};

function alertEvent(input: {
  ts: string;
  description: string;
  severity?: string;
  alertName?: string;
}) {
  return {
    type: 'message',
    subtype: 'bot_message',
    channel: 'C123',
    ts: input.ts,
    bot_id: 'B_ALERT',
    text: '',
    attachments: [
      {
        fallback:
          '[FIRING:1] monitoring (checkout) | <https://alerts.example/#/alerts?receiver=default>',
        text: [
          `*Alert:* ${input.alertName ?? 'Checkout latency is high.'}`,
          `*Description:* ${input.description}`,
          `*Severity:* \`${input.severity ?? 'warning'}\``,
          '*Source:* Prometheus Alertmanager',
        ].join(' '),
      },
    ],
  };
}

describe('Slack provider materiality', () => {
  test('normalizes a single provider alert with stable monitor and material identities', () => {
    const candidate = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000200',
        description: 'p99 is 412.5ms on 192.0.2.10:9090 at 2026-08-31T01:00:00Z.',
      }),
      ctx,
    );

    expect(candidate?.observations).toHaveLength(1);
    expect(candidate?.observations?.[0]).toMatchObject({
      state: 'firing',
      alertName: 'Checkout latency is high.',
      provider: 'prometheus-alertmanager',
      providerGroupKey: 'alertmanager:https://alerts.example/|monitoring (checkout)',
      monitorKey: expect.stringMatching(/^slack:[0-9a-f]{64}$/),
      materialHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test('ignores volatile measurements but preserves entities and severity', () => {
    const first = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000201',
        description: 'p99 is 412.5ms on 192.0.2.10:9090 at 2026-08-31T01:00:00Z.',
      }),
      ctx,
    )!;
    const volatileUpdate = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000202',
        description: 'p99 is 901.2ms on 192.0.2.10:9090 at 2026-08-31T01:05:00Z.',
      }),
      ctx,
    )!;
    const entityUpdate = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000203',
        description: 'p99 is 901.2ms on 192.0.2.11:9090 at 2026-08-31T01:05:00Z.',
      }),
      ctx,
    )!;
    const severityUpdate = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000204',
        description: 'p99 is 901.2ms on 192.0.2.10:9090 at 2026-08-31T01:05:00Z.',
        severity: 'critical',
      }),
      ctx,
    )!;

    expect(volatileUpdate.observations?.[0]?.monitorKey).toBe(first.observations?.[0]?.monitorKey);
    expect(volatileUpdate.observations?.[0]?.materialHash).toBe(
      first.observations?.[0]?.materialHash,
    );
    expect(entityUpdate.observations?.[0]?.materialHash).not.toBe(
      first.observations?.[0]?.materialHash,
    );
    expect(severityUpdate.observations?.[0]?.materialHash).not.toBe(
      first.observations?.[0]?.materialHash,
    );
  });

  test('preserves deployment revision changes as investigation material', () => {
    const first = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000205',
        description: 'deployment revision is abc123 trace_id=0123456789abcdef0123456789abcdef',
      }),
      ctx,
    )!;
    const traceUpdate = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000206',
        description: 'deployment revision is abc123 trace_id=fedcba9876543210fedcba9876543210',
      }),
      ctx,
    )!;
    const changed = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000207',
        description: 'deployment revision is def456 trace_id=fedcba9876543210fedcba9876543210',
      }),
      ctx,
    )!;

    expect(traceUpdate.observations?.[0]?.materialHash).toBe(first.observations?.[0]?.materialHash);
    expect(changed.observations?.[0]?.materialHash).not.toBe(first.observations?.[0]?.materialHash);
  });

  test('retains named entities without treating deployment metric drift as material', () => {
    const first = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000208',
        description: 'deployment checkout-v3 on api-1 has latency 412.5ms',
      }),
      ctx,
    )!;
    const metricUpdate = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000209',
        description: 'deployment checkout-v3 on api-1 has latency 901.2ms',
      }),
      ctx,
    )!;
    const entityUpdate = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000210',
        description: 'deployment checkout-v3 on api-2 has latency 901.2ms',
      }),
      ctx,
    )!;
    const revisionUpdate = normalizedCandidate(
      alertEvent({
        ts: '1787991000.000211',
        description: 'deployment checkout-v4 on api-1 has latency 901.2ms',
      }),
      ctx,
    )!;

    expect(metricUpdate.observations?.[0]?.materialHash).toBe(
      first.observations?.[0]?.materialHash,
    );
    expect(entityUpdate.observations?.[0]?.materialHash).not.toBe(
      first.observations?.[0]?.materialHash,
    );
    expect(revisionUpdate.observations?.[0]?.materialHash).not.toBe(
      first.observations?.[0]?.materialHash,
    );
  });
});
