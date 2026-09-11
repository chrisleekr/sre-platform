import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { InboundCandidate } from '@sre/connectors';
import { describe, expect, test } from 'vitest';
import * as z from 'zod';
import { makeAgentSdkClassifier, makeAgentSdkGenerator, makeAgentSdkVision } from '../agent-sdk';
import { createFixture } from './agent-sdk.fixture';

const __fixture = createFixture();

const candidate = {
  externalId: 'slack-alert',
  channel: 'C123',
  author: 'bot',
  producerId: 'bot:B_STATUSCAKE',
  text: 'checkout errors are high',
  raw: {},
  signalState: 'firing',
  eventKey: 'slack:C123:alert',
  eventAt: '2026-08-28T00:00:00.000Z',
  contentHash: 'hash',
  isEdit: false,
} satisfies InboundCandidate;

describe('Claude Agent SDK one-shot generator deadline signal', () => {
  test('rejects immediately on an already-aborted signal, before starting a query', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);
    let called = false;
    const generator = makeAgentSdkGenerator({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.scriptedQuery([], () => {
        called = true;
      }),
    });

    await expect(
      generator.generate('Summarize the alert', z.object({ ok: z.boolean() }), {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(called).toBe(false);
  });

  test("wires an abort controller whose signal follows the caller's signal", async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    let captured: Options | undefined;
    const generator = makeAgentSdkGenerator({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.scriptedQuery(
        [],
        (options) => {
          captured = options;
          controller.abort(reason);
        },
        new Error('provider transport failed'),
      ),
    });

    await expect(
      generator.generate('Summarize the alert', z.object({ ok: z.boolean() }), {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(captured?.abortController?.signal.aborted).toBe(true);
    expect(captured?.abortController?.signal.reason).toBe(reason);
  });
});

describe('Claude Agent SDK one-shot classifier deadline signal', () => {
  test('rejects immediately on an already-aborted signal, before starting a query', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);
    let called = false;
    const classifier = makeAgentSdkClassifier({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.scriptedQuery([], () => {
        called = true;
      }),
    });

    await expect(
      classifier.classify(candidate, [], [], { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(called).toBe(false);
  });

  test("wires an abort controller whose signal follows the caller's signal", async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    let captured: Options | undefined;
    const classifier = makeAgentSdkClassifier({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.scriptedQuery(
        [],
        (options) => {
          captured = options;
          controller.abort(reason);
        },
        new Error('provider transport failed'),
      ),
    });

    await expect(
      classifier.classify(candidate, [], [], { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(captured?.abortController?.signal.aborted).toBe(true);
    expect(captured?.abortController?.signal.reason).toBe(reason);
  });
});

describe('Claude Agent SDK one-shot vision deadline signal', () => {
  test('rejects immediately on an already-aborted signal, before starting a query', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);
    let called = false;
    const vision = makeAgentSdkVision({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.scriptedQuery([], () => {
        called = true;
      }),
    });

    await expect(
      vision.describeImage(new ArrayBuffer(1), 'image/png', 'Describe this image', {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(called).toBe(false);
  });

  test("wires an abort controller whose signal follows the caller's signal", async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    let captured: Options | undefined;
    const vision = makeAgentSdkVision({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.scriptedQuery(
        [],
        (options) => {
          captured = options;
          controller.abort(reason);
        },
        new Error('provider transport failed'),
      ),
    });

    await expect(
      vision.describeImage(new ArrayBuffer(1), 'image/png', 'Describe this image', {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(captured?.abortController?.signal.aborted).toBe(true);
    expect(captured?.abortController?.signal.reason).toBe(reason);
  });
});
