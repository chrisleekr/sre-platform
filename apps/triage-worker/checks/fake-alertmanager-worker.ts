import { Redis } from 'ioredis';
import { makeDbAuditSink } from '@sre/agent-tools';
import { adminUrl, appUrl, makeDb } from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import { makeFakeEngine, makeFakeGenerator } from '../src/engine/fake';
import type { TriageEngine } from '../src/engine/types';
import { makeRedisLock } from '../src/lock';
import { TriageWorker } from '../src/worker';

const adminDb = makeDb(adminUrl());
const appDb = makeDb(appUrl());
const redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
const queue = new Queue(adminDb.db, redis);
const baseEngine = makeFakeEngine();
const engine: TriageEngine = {
  ...baseEngine,
  async investigate(input, runtime) {
    const result = await baseEngine.investigate(input, runtime);
    if (!input.context?.startsWith('Investigate whether the numbered incident candidate'))
      return result;
    const evidenceId = await runtime.ctx.audit.record({
      tenantId: runtime.ctx.tenantId,
      incidentId: input.incident.id,
      tool: 'fake_causal_trace',
      input: { candidateRef: 1 },
      output: { direction: 'this_caused_candidate', aligned: true },
      latencyMs: 0,
      outcome: 'data',
    });
    return {
      ...result,
      evidenceReceipts: [{ evidenceId, tool: 'fake_causal_trace', outcome: 'complete' }],
      evidenceIds: [evidenceId],
      confidence: 95,
      causalFindings: [
        {
          candidateRef: 1,
          direction: 'this_caused_candidate',
          rationale: 'The deterministic trace links the downstream symptom to this source alert.',
          confidence: 95,
          evidenceIds: [evidenceId],
        },
      ],
    };
  },
};
const generator = makeFakeGenerator((prompt) => {
  if (!prompt.startsWith('Compare this provider-scoped, time-bounded alert cohort.')) return {};
  return {
    decisions: [
      {
        sourceRef: 1,
        targetRef: 2,
        decision: 'possible_related',
        rationale: 'The deterministic acceptance pair shares one causal test window.',
        confidence: 95,
      },
    ],
  };
});

const worker = new TriageWorker({
  appDb: appDb.db,
  hub: new ConversationHub(appDb.db, redis),
  engine,
  generator,
  queue,
  auditSink: makeDbAuditSink({ db: appDb.db }),
  connectorProvider: () => async () => [],
  tools: [],
  lock: makeRedisLock(redis),
  clearResumeGate: (incidentId) => queue.clearResumeGate(incidentId),
});

await queue.ensureGroup();
console.log(JSON.stringify({ level: 'info', app: 'fake-triage-worker', msg: 'started' }));
for (;;) {
  const processed = await worker.tick('fake-triage-worker');
  await queue.dispatchDue();
  if (processed === 0) await new Promise((resolve) => setTimeout(resolve, 100));
}
