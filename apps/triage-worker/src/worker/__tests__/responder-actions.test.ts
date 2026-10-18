import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test, vi } from 'vitest';
import { INVESTIGATION_RETRY_ORIGIN_PREFIX } from '@sre/contracts';
import type { HumanMessage } from '@sre/db';
import type { Job } from '@sre/queue';
import type { StructuredGenerator } from '../../engine/types';
import type { WorkerRuntime } from '../runtime';

vi.mock('../issue-actions', () => ({
  handleIssueDecision: vi.fn(async () => false),
  draftConversationIssue: vi.fn(),
}));
vi.mock('../knowledge-capture-offer', () => ({
  hasPendingKnowledgeCapture: vi.fn(async () => false),
  invalidateKnowledgeCapture: vi.fn(async () => undefined),
  offerKnowledgeCapture: vi.fn(),
}));
vi.mock('../knowledge-capture', () => ({ requestKnowledgeCapture: vi.fn() }));
vi.mock('../recovery-request', () => ({ requestRecoveryVerification: vi.fn() }));

import { processResponderActions } from '../responder-actions';
import { requestRecoveryVerification } from '../recovery-request';

const incidentId = '33333333-3333-4333-8333-333333333333';
const job: Job = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  type: 'incident.resume',
  payload: { incidentId },
  attempts: 1,
};

const generate = vi.fn(async (): Promise<Record<string, unknown>> => ({
  kind: 'investigate',
  target: 'current',
  to: null,
  reason: 'Asked to investigate.',
}));
const executeSemantic = vi.fn(
  async (
    _job: unknown,
    _operation: unknown,
    _signal: unknown,
    run: (generator: StructuredGenerator) => Promise<unknown>,
  ) => run({ generate } as unknown as StructuredGenerator),
);
const runtime = {
  deps: { hub: { appendOnce: vi.fn(), transitionIncident: vi.fn() } },
  executeSemantic,
} as unknown as WorkerRuntime;

function message(originSurface: string, originMessageId: string | null): HumanMessage {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    content: 'Retry the investigation.',
    originSurface,
    originMessageId,
    authorUserId: '55555555-5555-4555-8555-555555555555',
    createdAt: new Date(),
  };
}

async function process(input: HumanMessage, earlier: HumanMessage[] = []) {
  const checkpoint = vi.fn(async () => undefined);
  const pending = await processResponderActions(
    runtime,
    job,
    incidentId,
    [input],
    1,
    new AbortController().signal,
    { newer: [input], pending: earlier, base: null, checkpoint },
  );
  return { pending, checkpoint };
}

beforeEach(() => vi.clearAllMocks());

test('the dashboard retry control resumes an investigation without calling the intent model', async () => {
  const retry = message('dashboard', `${INVESTIGATION_RETRY_ORIGIN_PREFIX}${incidentId}:request`);
  const { pending, checkpoint } = await process(retry);
  expect(pending).toEqual([retry]);
  expect(checkpoint).toHaveBeenCalledWith(retry.id, retry.id);
  expect(executeSemantic).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
});

test('the same words typed in chat still go through intent classification', async () => {
  for (const typed of [message('slack', 'slack:C1:1'), message('dashboard', 'dashboard:typed')]) {
    const { pending } = await process(typed);
    expect(pending).toEqual([typed]);
  }
  expect(generate).toHaveBeenCalledTimes(2);
});

test('a retry origin id arriving from another surface is still classified', async () => {
  await process(message('slack', `${INVESTIGATION_RETRY_ORIGIN_PREFIX}${incidentId}:request`));
  expect(generate).toHaveBeenCalledTimes(1);
});

test.each([
  // A handled request answers everything before it, and a check answers it in their place.
  { outcome: 'handled' as const, kept: 'none' },
  { outcome: 'investigate' as const, kept: 'request' },
  // A forbidden request did nothing, so the earlier question still waits for an answer.
  { outcome: 'forbidden' as const, kept: 'earlier' },
])(
  'a recovery verification request is $outcome without a lifecycle transition',
  async ({ outcome, kept }) => {
    generate.mockResolvedValueOnce({
      kind: 'verify_recovery',
      target: 'current',
      to: null,
      reason: 'Check recovery and resolve only if it is confirmed.',
    });
    vi.mocked(requestRecoveryVerification).mockResolvedValueOnce(outcome);
    const typed = message('dashboard', 'dashboard:typed');
    const earlier = { ...message('dashboard', 'dashboard:earlier'), id: randomUUID() };
    const { pending } = await process(typed, [earlier]);
    expect(requestRecoveryVerification).toHaveBeenCalledWith(
      runtime,
      job,
      incidentId,
      typed,
      typed.id,
    );
    expect(pending).toEqual({ none: [], request: [typed], earlier: [earlier] }[kept]);
    expect(runtime.deps.hub.transitionIncident).not.toHaveBeenCalled();
  },
);
