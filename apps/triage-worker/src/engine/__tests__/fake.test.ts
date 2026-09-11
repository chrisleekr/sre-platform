import { describe, expect, test, vi } from 'vitest';
import { makeInMemoryAuditSink } from '@sre/agent-tools';
import { makeFakeEngine } from '../fake';

describe('fake triage engine recovery', () => {
  test('uses the shared conclusive outcome for an investigation', async () => {
    const engine = makeFakeEngine();
    const result = await engine.investigate(
      {
        incident: {
          id: 'incident-1',
          tenantId: 'tenant-1',
          service: 'checkout',
          severity: 'sev3',
          fingerprint: 'fingerprint-1',
          alertSource: 'fake',
        },
      },
      {
        ctx: {
          tenantId: 'tenant-1',
          incidentId: 'incident-1',
          service: 'checkout',
          resolveConnectors: async () => [],
          audit: makeInMemoryAuditSink(),
        },
        tools: [],
        signal: new AbortController().signal,
        onStep: vi.fn(),
      },
    );

    expect(result).toMatchObject({ outcome: 'conclusive', disposition: 'rca' });
  });

  test('records current fake health evidence during verification', async () => {
    const audit = makeInMemoryAuditSink();
    const engine = makeFakeEngine();
    const result = await engine.verifyRecovery(
      {
        incident: {
          id: 'incident-1',
          tenantId: 'tenant-1',
          service: 'checkout',
          severity: 'sev3',
          fingerprint: 'fingerprint-1',
          alertSource: 'fake',
        },
        prior: [],
        evidence: [],
        signalSummary: 'resolved',
      },
      {
        ctx: {
          tenantId: 'tenant-1',
          incidentId: 'incident-1',
          service: 'checkout',
          resolveConnectors: async () => [],
          audit,
        },
        tools: [],
        signal: new AbortController().signal,
        onStep: vi.fn(),
      },
    );

    expect(audit.records).toEqual([
      expect.objectContaining({
        tool: 'fake_current_health',
        incidentId: 'incident-1',
        outcome: 'data',
        output: { healthy: true, source: 'fake' },
      }),
    ]);
    expect(result.recovery).toMatchObject({
      recovered: true,
      evidenceIds: [expect.any(String)],
      unknowns: [],
      nextStep: null,
    });
  });
});
