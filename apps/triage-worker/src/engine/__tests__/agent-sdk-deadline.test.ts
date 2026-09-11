import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ToolContext } from '@sre/agent-tools';
import { describe, expect, test, vi } from 'vitest';
import { makeAgentSdkEngine } from '../agent-sdk';
import { linkedAbortController } from '../agent-sdk/query';
import type { TriageRuntime } from '../types';
import { createFixture } from './agent-sdk.fixture';

const __fixture = createFixture();

describe('Claude Agent SDK deadline signal', () => {
  test('links an already-aborted input with the same reason', () => {
    const signal = new AbortController();
    const reason = new Error('deadline');
    signal.abort(reason);

    const linked = linkedAbortController(signal.signal);

    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe(reason);
  });

  test('aborts the linked controller with the input reason', () => {
    const signal = new AbortController();
    const linked = linkedAbortController(signal.signal);
    const reason = new Error('deadline');

    signal.abort(reason);

    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe(reason);
  });

  test('passes a linked abort controller to investigate and rethrows its reason', async () => {
    const signal = new AbortController();
    const reason = new Error('deadline');
    let captured: Options | undefined;
    const query = __fixture.scriptedQuery(
      [],
      (options) => {
        captured = options;
        signal.abort(reason);
      },
      new Error('provider transport failed'),
    );
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query,
    });
    const runtime: TriageRuntime = {
      tools: [],
      ctx: {
        tenantId: 'tenant-1',
        incidentId: 'incident-1',
        service: 'checkout',
        resolveConnectors: async () => [],
        audit: { record: async () => 'evidence-1' },
      } as ToolContext,
      signal: signal.signal,
      onStep: vi.fn(async () => undefined),
    };

    await expect(
      engine.investigate(
        {
          incident: {
            id: 'incident-1',
            tenantId: 'tenant-1',
            service: 'checkout',
            severity: 'sev2',
            fingerprint: 'fingerprint',
            alertSource: 'test',
          },
        },
        runtime,
      ),
    ).rejects.toBe(reason);
    expect(captured?.abortController?.signal.aborted).toBe(true);
    expect(captured?.abortController?.signal.reason).toBe(reason);
  });
});
