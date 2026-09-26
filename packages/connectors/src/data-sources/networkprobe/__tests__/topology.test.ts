import { describe, expect, test } from 'vitest';
import { networkProbeTopologyEvidence } from '../topology';

describe('networkProbeTopologyEvidence http_meta', () => {
  const target = new URL('https://service.example/health');
  const row = (output: Record<string, unknown>) => ({
    id: 'e1',
    incidentId: 'i1',
    tool: 'networkprobe_AAAAAAAAAAAAAAAAAAAAAA_http_meta',
    input: { url: target.href },
    output: { url: target.href, ...output },
    outcome: 'data',
    createdAt: new Date(0),
  });

  test('keeps the TLS verdict beside an https status', () => {
    const probe = networkProbeTopologyEvidence(
      target,
      row({ status: 200, tlsAuthorized: false }),
      new Date(1000),
    );
    expect(probe?.facts).toEqual({ status: 200, authorized: false });
  });

  test('records no verdict when the probe had none', () => {
    const probe = networkProbeTopologyEvidence(
      target,
      row({ status: 200, tlsAuthorized: null }),
      new Date(1000),
    );
    expect(probe?.facts).toEqual({ status: 200 });
  });
});
