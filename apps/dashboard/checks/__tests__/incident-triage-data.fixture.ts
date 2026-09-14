import type { EvidenceDetail, IncidentWorkspaceData } from '../../src/lib/types';

export const TRIAGE_ID = '11111111-1111-4111-8111-111111111111';
export const checks: EvidenceDetail[] = Array.from({ length: 45 }, (_, index) => ({
  id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
  tool: index === 0 ? 'argocd_get_application_logs' : 'prometheus_query_range',
  summary:
    index === 0
      ? 'name: checkout · podName: checkout-api-7d9f'
      : `query: rate(checkout_errors_total{region="ap-southeast-2",deployment="checkout-api-7d9f"}[5m]) · sample ${index}`,
  outcome: index > 4 && index % 4 === 0 ? 'no_data' : 'data',
  latencyMs: 10,
  recordedAt: `2026-09-14T00:${String(59 - index).padStart(2, '0')}:00Z`,
  hasOutput: true,
  input: { query: 'rate(checkout_errors_total[5m])' },
  output:
    index === 0
      ? {
          log: Array.from(
            { length: 300 },
            (_line, line) =>
              `00:01:${String(line % 60).padStart(2, '0')} checkout request deadline exceeded <untrusted> ${'long-resource-name'.repeat(8)}`,
          ).join('\n'),
        }
      : { data: 'Retained metric samples' },
  projection:
    index === 0
      ? { kind: 'raw' }
      : {
          kind: 'time_series',
          source: 'prometheus',
          query: 'rate(checkout_errors_total[5m])',
          from: '2026-09-14T00:00:00Z',
          to: '2026-09-14T00:29:00Z',
          series: [
            {
              name: 'checkout errors',
              unit: null,
              points: Array.from({ length: 30 }, (_point, i) => ({
                timestamp: `2026-09-14T00:${String(i).padStart(2, '0')}:00Z`,
                value: i < 12 ? 2 : 10,
              })),
            },
          ],
        },
  referenceUrl: null,
  ...(index > 4 && index % 4 === 0
    ? { hasOutput: false, output: null, projection: { kind: 'raw' as const } }
    : {}),
}));
export const triageWorkspace: IncidentWorkspaceData = {
  incident: {
    id: TRIAGE_ID,
    title: 'Checkout requests timing out after the latest rollout',
    service: 'checkout',
    severity: 'sev2',
    status: 'open',
    investigationStatus: 'assessed',
    lifecycleVersion: 0,
    alertSource: 'datadog',
    createdAt: '2026-09-14T00:00:00Z',
    rcaSummary:
      'Connection pool pressure coincides with the rollout. The cause is not established.',
    confidence: 60,
    impact: 'Checkout requests have elevated errors in ap-southeast-2.',
    currentState: 'Recovery not verified',
    assessmentUpdatedAt: '2026-09-14T00:29:00Z',
    nextStep: 'Compare database connection pressure before and after the rollout.',
    pendingAutomation: null,
    recoveryState: null,
    assessmentEvidenceIds: checks.slice(0, 5).map((item) => item.id),
    rankedHypotheses: [
      {
        hypothesis: 'Database saturation may explain the timeouts',
        confidence: 60,
        evidence: 'Error rate rose after deployment',
        state: 'leading',
        supportingEvidenceIds: [checks[1]!.id],
        contradictingEvidenceIds: [checks[4]!.id],
      },
    ],
    unknowns: [
      {
        question: 'Database wait time is not recorded for the pre-rollout interval.',
        category: 'historical_gap',
        evidenceKind: null,
        attemptedEvidenceIds: [],
      },
    ],
  },
  viewerUserId: null,
  progress: { total: 45, successful: 34, failed: 11, lastRecordedAt: checks[0]!.recordedAt },
  signals: [],
  attention: {
    decision: 'Compare database pressure and rollout timing before choosing a mitigation.',
    owner: 'Payments team',
    nextAutomation: null,
  },
};
