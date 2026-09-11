import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  createIncident,
  recordToolCall,
  agentToolCalls,
  incidents,
  tenants,
  type DbHandle,
} from '@sre/db';
import {
  makeDbAuditSink,
  makeSearchIncidentEvidenceTool,
  type ToolContext,
} from '@sre/agent-tools';
import { runLoop, type LoopProvider, type ToolRunResult } from '../engine/loop';
import { REPORT_FINDINGS_NAME } from '../engine/report-findings';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let incidentId: string;
let sizeEvidenceId: string;
let jobEvidenceId: string;
let runtimeEvidenceId: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'generic-evidence-closure' });
  incidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: `storage-latency-${randomUUID()}`,
      alertSource: 'test',
      service: 'metadata-store',
      severity: 'sev3',
    })
  ).id;
  sizeEvidenceId = await recordToolCall(app.db, tenantId, {
    incidentId,
    tool: 'metrics_query',
    input: { query: 'database_storage_size_bytes' },
    output: { bytes: 206_393_344, quotaBytes: 2_147_483_648 },
    latencyMs: 2,
    outcome: 'data',
  });
  jobEvidenceId = await recordToolCall(app.db, tenantId, {
    incidentId,
    tool: 'source_job_history',
    input: { project: 'acme/application', job: 42 },
    output: { durationSeconds: 1_465, stage: 'release', priorComparableRuns: 1 },
    latencyMs: 3,
    outcome: 'data',
  });
  runtimeEvidenceId = await recordToolCall(app.db, tenantId, {
    incidentId,
    tool: 'runtime_get_resource',
    input: { resource: 'pods', name: 'build-runner' },
    output: {
      nodeRole: 'control-plane',
      taints: [],
      nodeSelector: null,
      storage: 'node-local',
    },
    latencyMs: 2,
    outcome: 'data',
  });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(agentToolCalls).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('generic incident evidence closure', () => {
  test('reuses prior facts and leaves only partial evidence, a capability gap, and a decision', async () => {
    let turn = 0;
    const searchEvidenceIds: string[] = [];
    const rendered: ToolRunResult[] = [];
    const provider: LoopProvider = {
      toolSpecs: () => [],
      userMsg: (text) => text,
      call: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            assistantMsg: {},
            stopReason: 'tool_use',
            toolCalls: [
              {
                id: 'draft',
                name: REPORT_FINDINGS_NAME,
                input: {
                  outcome: 'inconclusive',
                  summary: 'Draft diagnosis.',
                  confidence: 55,
                  unknowns: [
                    {
                      question: 'What is the datastore size?',
                      category: 'observable',
                      evidenceKind: 'metrics',
                      attemptedEvidenceIds: [],
                    },
                    {
                      question: 'Which build workload overlapped the alert?',
                      category: 'observable',
                      evidenceKind: 'provider_history',
                      attemptedEvidenceIds: [],
                    },
                    {
                      question: 'Why could the runner use this node?',
                      category: 'observable',
                      evidenceKind: 'runtime_configuration',
                      attemptedEvidenceIds: [],
                    },
                  ],
                },
              },
            ],
          };
        }
        if (turn === 2) {
          return {
            text: '',
            assistantMsg: {},
            stopReason: 'tool_use',
            toolCalls: [
              {
                id: 'size-search',
                name: 'search_incident_evidence',
                input: { query: 'storage_size' },
              },
              {
                id: 'job-search',
                name: 'search_incident_evidence',
                input: { query: 'acme/application' },
              },
              {
                id: 'runtime-search',
                name: 'search_incident_evidence',
                input: { query: 'control-plane' },
              },
            ],
          };
        }
        return {
          text: '',
          assistantMsg: {},
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'final',
              name: REPORT_FINDINGS_NAME,
              input: {
                outcome: 'conclusive',
                summary: 'The size, overlapping job, and scheduling configuration are established.',
                confidence: 84,
                evidenceIds: [sizeEvidenceId, jobEvidenceId, runtimeEvidenceId],
                unknowns: [
                  {
                    question: 'Only one comparable historical job was retained.',
                    category: 'partial_evidence',
                    evidenceKind: 'provider_history',
                    attemptedEvidenceIds: [searchEvidenceIds[1]],
                  },
                  {
                    question: 'The exact node runtime storage root is not exposed.',
                    category: 'missing_capability',
                    evidenceKind: 'runtime_configuration',
                    attemptedEvidenceIds: [searchEvidenceIds[2]],
                  },
                  {
                    question: 'Should build workloads remain schedulable on control-plane nodes?',
                    category: 'operator_decision',
                    evidenceKind: null,
                    attemptedEvidenceIds: [searchEvidenceIds[2]],
                  },
                ],
              },
            },
          ],
        };
      },
      toolResultMsgs: (results) => {
        rendered.push(...results);
        for (const result of results) {
          if (!result.id.endsWith('-search')) continue;
          const evidenceId = /evidenceId:\s*([0-9a-f-]{36})/i.exec(result.content)?.[1];
          if (evidenceId) searchEvidenceIds.push(evidenceId);
        }
        return results;
      },
    };
    const ctx: ToolContext = {
      tenantId,
      incidentId,
      service: 'metadata-store',
      resolveConnectors: async () => [],
      audit: makeDbAuditSink({ db: app.db }),
    };

    const result = await runLoop({
      provider,
      system: 'generic evidence closure acceptance',
      initialUser: 'investigate',
      tools: [makeSearchIncidentEvidenceTool({ db: app.db })],
      ctx,
      onStep: async () => undefined,
      maxTurns: 4,
      path: 'investigate',
      engineProvider: 'test',
      sessionId: 'test:generic-evidence-closure',
      terminals: [REPORT_FINDINGS_NAME],
    });

    expect(turn).toBe(3);
    expect(rendered.find((item) => item.id === 'draft')?.content).toContain(
      'machine-checkable questions',
    );
    expect(rendered.find((item) => item.id === 'size-search')?.content).toContain(sizeEvidenceId);
    expect(rendered.find((item) => item.id === 'job-search')?.content).toContain(jobEvidenceId);
    expect(rendered.find((item) => item.id === 'runtime-search')?.content).toContain(
      runtimeEvidenceId,
    );
    expect(result.unknowns?.map((gap) => gap.category)).toEqual([
      'partial_evidence',
      'missing_capability',
      'operator_decision',
    ]);
    expect(result.unknowns?.some((gap) => gap.category === 'observable')).toBe(false);
  });
});
