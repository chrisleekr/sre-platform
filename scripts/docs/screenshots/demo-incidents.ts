/**
 * The incidents the guide walks through: one per state a responder has to recognise on sight.
 *
 * Every incident is opened through the platform's only ingress, so the conversation, the surface
 * binding, and the audit line are the same records a real alert produces.
 */
import { openIncidentWorkspace } from '../../../packages/alerts/src/index';
import {
  agentToolCalls,
  approvals,
  incidentMessages,
  incidents,
  investigationRuns,
  jobs,
  withTenant,
} from '../../../packages/db/src/index';
import { and, eq, sql } from 'drizzle-orm';
import type { DemoSeedDeps } from './demo-environment';
import { demoIncidentEvidence } from './demo-evidence';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface DemoIncidentInput {
  fingerprint: string;
  service: string;
  severity: string;
  title: string;
  alertName: string;
  channel: string;
  openedMinutesAgo: number;
  status: 'open' | 'mitigated' | 'resolved';
  signalState: 'firing' | 'resolved';
}

/**
 * Opens an incident through the platform's only ingress, with the Slack binding a real alert would
 * carry. The returned id is used to attach the conversation and the assessment.
 */
async function openDemoIncident(
  deps: DemoSeedDeps,
  input: DemoIncidentInput,
): Promise<{ incidentId: string; openedAt: Date }> {
  const openedAt = new Date(deps.now.getTime() - input.openedMinutesAgo * MINUTE);
  const threadId = `${(openedAt.getTime() / 1000).toFixed(6)}`;
  const result = await openIncidentWorkspace(
    { appDb: deps.appDb, queue: deps.queue },
    {
      tenantId: deps.tenantId,
      source: 'prometheus',
      service: input.service,
      severity: input.severity,
      title: input.title,
      status: input.status,
      investigationStatus: 'assessed',
      fingerprint: input.fingerprint,
      binding: { surface: 'slack', channel: input.channel, threadId },
      signal: {
        provider: 'prometheus',
        alertName: input.alertName,
        monitorKey: `prometheus:${input.alertName}`,
        surface: 'slack',
        channel: input.channel,
        externalMessageId: threadId,
        state: input.signalState,
        summary: input.title,
        contentHash: `demo-${input.fingerprint}`,
        eventKey: `demo-${input.fingerprint}-1`,
        eventAt: openedAt,
        startsAt: openedAt,
        labels: { alertname: input.alertName, service: input.service, severity: input.severity },
        annotations: { summary: input.title },
      },
    },
  );
  // The opener stamps `now`. Backdating it is what makes the queue read "22m ago" instead of
  // "just now", which is the whole point of anchoring the demo data to a fixed time.
  await withTenant(deps.appDb, deps.tenantId, (tx) =>
    tx
      .update(incidents)
      .set({ createdAt: openedAt, updatedAt: openedAt })
      .where(eq(incidents.id, result.incidentId)),
  );
  // The opener audit line is written by the conversation hub in the running platform. Here the
  // alert is recorded as the first message directly, which is what the reader sees either way.
  await withTenant(deps.appDb, deps.tenantId, (tx) =>
    tx.insert(incidentMessages).values({
      tenantId: deps.tenantId,
      incidentId: result.incidentId,
      author: 'system',
      kind: 'signal',
      content: `${input.alertName} firing for ${input.service}`,
      originSurface: 'slack',
      originMessageId: threadId,
      createdAt: openedAt,
    }),
  );
  return { incidentId: result.incidentId, openedAt };
}

interface ConversationTurn {
  author: string;
  kind?: string;
  content: string;
  minutesAfterOpen: number;
  originSurface?: string;
  finding?: unknown;
}

/** Appends a conversation to an incident. Message ordering is what the hub keyset reader shows. */
async function appendConversation(
  deps: DemoSeedDeps,
  incidentId: string,
  openedAt: Date,
  turns: ConversationTurn[],
): Promise<void> {
  await withTenant(deps.appDb, deps.tenantId, (tx) =>
    tx.insert(incidentMessages).values(
      turns.map((turn, index) => ({
        tenantId: deps.tenantId,
        incidentId,
        author: turn.author,
        kind: turn.kind ?? 'text',
        content: turn.content,
        originSurface: turn.originSurface ?? 'slack',
        originMessageId: `demo-${incidentId.slice(0, 8)}-${index}`,
        ...(turn.finding ? { finding: turn.finding as never } : {}),
        createdAt: new Date(openedAt.getTime() + turn.minutesAfterOpen * MINUTE),
      })),
    ),
  );
}

/** The lead incident: assessed, still open, with a recommendation waiting on a human. */
export async function seedLeadIncident(deps: DemoSeedDeps): Promise<string> {
  const { incidentId, openedAt } = await openDemoIncident(deps, {
    fingerprint: 'demo-checkout-latency',
    service: 'checkout-api',
    severity: 'critical',
    title: 'Checkout p99 latency above 2s for 10 minutes',
    alertName: 'CheckoutLatencyHigh',
    channel: 'C-ALERTS-PROD',
    openedMinutesAgo: 22,
    status: 'open',
    signalState: 'firing',
  });

  const runId = crypto.randomUUID();
  const evidence = demoIncidentEvidence(openedAt);
  const evidenceIds = evidence.slice(0, 4).map((item) => item.id);
  await deps.adminDb
    .update(jobs)
    .set({ status: 'done' })
    .where(
      and(eq(jobs.tenantId, deps.tenantId), sql`${jobs.payload}->>'incidentId' = ${incidentId}`),
    );
  await withTenant(deps.appDb, deps.tenantId, async (tx) => {
    await tx.insert(investigationRuns).values({
      id: runId,
      tenantId: deps.tenantId,
      incidentId,
      operation: 'investigate',
      triggerReason: 'new_episode',
      triggerAutomatic: true,
      triggerMonitorKey: 'prometheus:CheckoutLatencyHigh',
      provider: 'anthropic',
      engineModel: 'claude-opus-4-8',
      turnBudget: 8,
      outcome: 'conclusive',
      // The table requires an outcome, a result, and a completion time together, so a finished run
      // can never be recorded without saying what it concluded.
      result: {
        summary: 'Concurrency change exceeded the connection-pool ceiling.',
        confidence: 78,
        turnsUsed: 6,
      },
      startedAt: new Date(openedAt.getTime() + 1 * MINUTE),
      completedAt: new Date(openedAt.getTime() + 4 * MINUTE),
    });

    await tx.insert(agentToolCalls).values(
      evidence.map((call, index) => ({
        tenantId: deps.tenantId,
        incidentId,
        createdAt: new Date(openedAt.getTime() + (90 + index * 20) * 1000),
        ...call,
      })),
    );

    await tx
      .update(incidents)
      .set({
        engineProvider: 'anthropic',
        engineModel: 'claude-opus-4-8',
        trustedAssessmentRunId: runId,
        assessmentEvidenceIds: evidenceIds,
        confidence: 78,
        rcaSummary:
          'The 14:02 checkout-api release raised worker concurrency from 8 to 32 without raising the ' +
          'connection-pool ceiling. Workers now queue on the pool, and the wait shows up as request latency. ' +
          'One pod is in CrashLoopBackOff after being OOMKilled, which removes a third of capacity and ' +
          'concentrates the remaining load.',
        currentState:
          'p99 latency 2.4s against a 0.8s baseline. Error rate is flat, so requests are slow rather than failing.',
        impact:
          'Checkout is degraded for all customers. Payments and orders are downstream and are not yet affected.',
        nextStep:
          'Roll back the checkout-api release to 61d0b9c. This is reversible and does not need a schema change.',
        rankedHypotheses: [
          {
            hypothesis: 'Worker concurrency raised above the connection-pool ceiling',
            confidence: 78,
            evidence:
              'The release 26 minutes ago changed pool concurrency 8 to 32. Latency rose within 90 seconds ' +
              'of the rollout and pool-wait time tracks it exactly.',
            state: 'leading',
            supportingEvidenceIds: evidenceIds.slice(0, 2),
            contradictingEvidenceIds: [],
          },
          {
            hypothesis: 'Memory limit too low for the new concurrency, causing the OOM kill',
            confidence: 46,
            evidence:
              'One pod was OOMKilled and is in CrashLoopBackOff. This may be a consequence of the same ' +
              'change rather than an independent cause.',
            state: 'plausible',
            supportingEvidenceIds: [evidenceIds[3]!],
            contradictingEvidenceIds: [],
          },
          {
            hypothesis: 'Downstream payments-gateway slowdown',
            confidence: 8,
            evidence:
              'payments-gateway p99 is unchanged at 120ms and its error rate is flat. Contradicted.',
            state: 'disproven',
            supportingEvidenceIds: [],
            contradictingEvidenceIds: [evidenceIds[2]!],
          },
        ],
        unknowns: [
          {
            question: 'Was the connection-pool ceiling raised in a separate config repository?',
            category: 'observable',
            evidenceKind: 'runtime_configuration',
            attemptedEvidenceIds: [],
          },
          {
            question: 'Should the rollback happen now or after the current checkout queue drains?',
            category: 'operator_decision',
            evidenceKind: null,
            attemptedEvidenceIds: [],
          },
        ],
        assessmentUpdatedAt: new Date(openedAt.getTime() + 4 * MINUTE),
      })
      .where(eq(incidents.id, incidentId));
  });

  await appendConversation(deps, incidentId, openedAt, [
    {
      author: 'agent',
      content:
        'Checking blast radius, recent deploys, and error logs for checkout-api around 14:02.',
      minutesAfterOpen: 1,
    },
    {
      author: 'agent',
      kind: 'finding',
      content:
        '**Leading hypothesis: worker concurrency exceeds the connection-pool ceiling.**\n\n' +
        'The release 26 minutes ago raised concurrency from 8 to 32. Pool-wait time rose within 90 seconds ' +
        'of the rollout and now accounts for 1.9s of the 2.4s p99. Payments-gateway latency is unchanged, ' +
        'so the delay is inside checkout-api.\n\n' +
        'Confidence 78%. One pod is separately in CrashLoopBackOff after an OOM kill.',
      minutesAfterOpen: 4,
      finding: {
        runId,
        outcome: 'conclusive',
        promotion: 'trusted_assessment',
        promotionReason: 'conclusive_assessment',
        evidenceIds,
        currentState: 'p99 latency 2.4s against a 0.8s baseline.',
        impact: 'Checkout is degraded for all customers.',
        nextStep: 'Roll back checkout-api to 61d0b9c.',
      },
    },
    {
      author: 'human',
      content:
        'Did the config repo raise the pool ceiling as well? We split those two repos last month.',
      minutesAfterOpen: 9,
    },
    {
      author: 'agent',
      content:
        'I cannot see that repository. The GitLab data source is scoped to the acme group, and the ' +
        'deployment config lives outside it. I am recording this as an open question rather than assuming ' +
        'the ceiling is unchanged.',
      minutesAfterOpen: 10,
    },
  ]);

  await seedPendingApproval(deps, incidentId, openedAt);
  return incidentId;
}

/**
 * The undecided recommendation. The buttons a responder sees come from this record, not from the
 * message text, so the screenshot has to carry a real one.
 */
async function seedPendingApproval(
  deps: DemoSeedDeps,
  incidentId: string,
  openedAt: Date,
): Promise<void> {
  await withTenant(deps.appDb, deps.tenantId, async (tx) => {
    const [approval] = await tx
      .insert(approvals)
      .values({
        tenantId: deps.tenantId,
        incidentId,
        actionId: 'rollback-checkout-api',
        prompt:
          'Roll back checkout-api to 61d0b9c. Least risky option: it reverses the concurrency ' +
          'change, needs no schema migration, and the previous revision ran for a day without ' +
          'this alert. Approving records your decision. It does not run anything.',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'deny', label: 'Deny' },
        ],
        createdAt: new Date(openedAt.getTime() + 12 * MINUTE),
      })
      .returning({ id: approvals.id });
    if (!approval) throw new Error('demo seed: the approval was not inserted');
    await tx.insert(incidentMessages).values({
      tenantId: deps.tenantId,
      incidentId,
      author: 'agent',
      kind: 'approval',
      content: 'Recommended action: roll back checkout-api to 61d0b9c.',
      originSurface: 'slack',
      originMessageId: `demo-approval-${incidentId.slice(0, 8)}`,
      approvalId: approval.id,
      createdAt: new Date(openedAt.getTime() + 12 * MINUTE),
    });
  });
}

/** The rest of the queue: one incident per state a responder needs to recognise on sight. */
export async function seedSupportingIncidents(deps: DemoSeedDeps): Promise<void> {
  const mitigated = await openDemoIncident(deps, {
    fingerprint: 'demo-orders-queue-depth',
    service: 'orders-service',
    severity: 'high',
    title: 'Order queue depth above 5000 for 15 minutes',
    alertName: 'OrderQueueBacklog',
    channel: 'C-ALERTS-PROD',
    openedMinutesAgo: 95,
    status: 'mitigated',
    signalState: 'resolved',
  });
  await withTenant(deps.appDb, deps.tenantId, (tx) =>
    tx
      .update(incidents)
      .set({
        engineProvider: 'anthropic',
        engineModel: 'claude-opus-4-8',
        confidence: 84,
        rcaSummary:
          'A stuck consumer held its partition lease after a network blip and stopped acknowledging. ' +
          'Restarting the consumer cleared the backlog.',
        currentState: 'Queue depth is back to 120 and falling.',
        impact: 'Order confirmation emails were delayed by up to 12 minutes. No orders were lost.',
        recoveryState: 'monitoring',
        recoverySummary:
          'Queue depth is normal and the consumer has acknowledged continuously for 8 minutes. ' +
          'Rechecking before resolving, because the earlier blip recurred once already.',
        recoveryAttempt: 1,
        recoveryMaxChecks: 3,
        recoveryNextCheckAt: new Date(deps.now.getTime() + 6 * MINUTE),
        recoveryScheduleReason:
          'Confirming the consumer stays healthy across a full lease renewal.',
        mitigatedAt: new Date(deps.now.getTime() - 20 * MINUTE),
        assessmentUpdatedAt: new Date(deps.now.getTime() - 60 * MINUTE),
      })
      .where(eq(incidents.id, mitigated.incidentId)),
  );
  await appendConversation(deps, mitigated.incidentId, mitigated.openedAt, [
    {
      author: 'agent',
      content: 'Consumer lag is concentrated on one partition. Checking consumer health.',
      minutesAfterOpen: 2,
    },
    {
      author: 'human',
      content: 'Restarted the stuck consumer.',
      minutesAfterOpen: 62,
      originSurface: 'dashboard',
    },
    {
      author: 'agent',
      content:
        'Queue depth is falling. I will recheck in 6 minutes before resolving, rather than treating ' +
        'the cleared alert as proof.',
      minutesAfterOpen: 70,
    },
  ]);

  const resolved = await openDemoIncident(deps, {
    fingerprint: 'demo-search-errors',
    service: 'search-api',
    severity: 'medium',
    title: 'Search error rate above 5% for 5 minutes',
    alertName: 'SearchErrorRateHigh',
    channel: 'C-ALERTS-PROD',
    openedMinutesAgo: 26 * 60,
    status: 'resolved',
    signalState: 'resolved',
  });
  await withTenant(deps.appDb, deps.tenantId, (tx) =>
    tx
      .update(incidents)
      .set({
        engineProvider: 'anthropic',
        engineModel: 'claude-opus-4-8',
        confidence: 91,
        rcaSummary:
          'An upstream index rebuild removed the product catalogue alias for 4 minutes. Search queries ' +
          'against the missing alias returned 500s until the rebuild completed.',
        currentState: 'Error rate is 0.1%, at baseline.',
        impact: 'Search was unavailable for roughly 4 minutes. Checkout was unaffected.',
        recoveryState: 'verified',
        recoverySummary:
          'Error rate and latency are both at baseline, and the alias resolves. Verified across two checks.',
        recoveryAttempt: 2,
        recoveryMaxChecks: 3,
        resolvedAt: new Date(deps.now.getTime() - 25 * HOUR),
        assessmentUpdatedAt: new Date(deps.now.getTime() - 25 * HOUR),
      })
      .where(eq(incidents.id, resolved.incidentId)),
  );

  const degraded = await openDemoIncident(deps, {
    fingerprint: 'demo-session-store-memory',
    service: 'session-store',
    severity: 'high',
    title: 'Session store memory above 90%',
    alertName: 'SessionStoreMemoryHigh',
    channel: 'C-ALERTS-PLATFORM',
    openedMinutesAgo: 8,
    status: 'open',
    signalState: 'firing',
  });
  await withTenant(deps.appDb, deps.tenantId, (tx) =>
    tx
      .update(incidents)
      .set({ investigationStatus: 'degraded' })
      .where(eq(incidents.id, degraded.incidentId)),
  );
  await appendConversation(deps, degraded.incidentId, degraded.openedAt, [
    {
      author: 'agent',
      content:
        'The model provider is unreachable. I assembled this brief directly from your data sources ' +
        'instead, and I am retrying. Memory is at 92% and rising about 1% every 4 minutes. ' +
        'Eviction has not started.',
      minutesAfterOpen: 2,
    },
  ]);
}
