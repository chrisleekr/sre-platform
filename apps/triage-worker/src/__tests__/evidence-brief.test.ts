// Pure-unit: buildEvidenceBrief gathers connector context deterministically (no LLM) so a provider
// outage still yields a real brief. It pulls each resolved connector's fetchTriageContext
// directly (no tool schemas), includes only connectors that return data, skips ones that throw, and
// falls back to a marker when dry. Covers EARS 7.
import { describe, expect, test } from 'vitest';
import { makeInMemoryAuditSink, type ToolContext } from '@sre/agent-tools';
import type { IDataSourceConnector } from '@sre/connectors';
import { buildEvidenceBrief } from '../evidence-brief';

function dataConnector(): IDataSourceConnector {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Test GitLab',
    type: 'gitlab',
    snapshot: async () => [],
    fetchTriageContext: async ({ service }) => ({
      source: 'gitlab',
      data: { commits: [{ sha: 'abc123', title: 'fix cart' }], service },
    }),
    tools: () => [],
    probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
  };
}

function throwingConnector(): IDataSourceConnector {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Test Kubernetes',
    type: 'kubernetes',
    snapshot: async () => [],
    fetchTriageContext: async () => {
      throw new Error('connector unavailable');
    },
    tools: () => [],
    probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
  };
}

function ctxWith(connectors: IDataSourceConnector[]): ToolContext {
  return {
    tenantId: 't1',
    incidentId: 'inc-1',
    service: 'checkout',
    resolveConnectors: async () => connectors,
    audit: makeInMemoryAuditSink(),
  };
}

describe('buildEvidenceBrief', () => {
  test('treats connector resolution failure as unavailable optional evidence', async () => {
    const ctx = {
      ...ctxWith([]),
      resolveConnectors: async () => {
        throw new Error('connector registry unavailable');
      },
    };

    await expect(buildEvidenceBrief(ctx, 'checkout', 30)).resolves.toBe(
      'No live connector data available.',
    );
  });

  test('includes each connector that returns triage context, with its raw data', async () => {
    const ctx = ctxWith([dataConnector()]);
    const brief = await buildEvidenceBrief(ctx, 'checkout', 30);
    // The connector type labels the section and its real data reaches the brief.
    expect(brief).toContain('gitlab');
    expect(brief).toContain('abc123');
  });

  test('redacts secret-keyed connector data before it reaches the brief (CWE-532)', async () => {
    // The degrade brief becomes a durable finding + hub + Slack message and does NOT pass through the
    // onStep scrub choke point, so it must redact here (matching seedFirstPass). A regression guard:
    // the brief used to inherit this redaction via runTool, which it no longer calls.
    const secretConnector: IDataSourceConnector = {
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Secret GitLab',
      type: 'gitlab',
      snapshot: async () => [],
      fetchTriageContext: async () => ({
        source: 'gitlab',
        data: { apiToken: 'topsecretvalue', service: 'checkout' },
      }),
      tools: () => [],
      probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
    };
    const brief = await buildEvidenceBrief(ctxWith([secretConnector]), 'checkout', 30);
    expect(brief).not.toContain('topsecretvalue');
    expect(brief).toContain('[REDACTED]');
  });

  test('skips a connector whose fetchTriageContext throws, never rejecting the brief', async () => {
    const ctx = ctxWith([throwingConnector(), dataConnector()]);
    const brief = await buildEvidenceBrief(ctx, 'checkout', 30);
    // The throwing (alert-only/unavailable) connector is skipped; the live one still lands.
    expect(brief).toContain('gitlab');
    expect(brief).toContain('abc123');
    expect(brief).not.toContain('kubernetes');
  });

  test('falls back to a clear marker when no connector has data', async () => {
    const ctx = ctxWith([throwingConnector()]);
    const brief = await buildEvidenceBrief(ctx, 'checkout', 30);
    expect(brief).toMatch(/no live connector data/i);
  });
});
