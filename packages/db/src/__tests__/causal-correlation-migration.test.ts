import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `causal_correlation_${randomUUID().replaceAll('-', '')}`;
let control: Sql;
let upgrade: Sql;

async function applyMigration(client: Sql, filename: string): Promise<void> {
  const source = await readFile(join(migrationsDir, filename), 'utf8');
  for (const statement of source.split('--> statement-breakpoint'))
    if (statement.trim()) await client.unsafe(statement);
}

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  const controlUrl = new URL(process.env.DATABASE_URL!);
  controlUrl.pathname = '/postgres';
  control = postgres(controlUrl.toString(), { max: 1 });
  await control.unsafe(`CREATE DATABASE "${databaseName}"`);

  const upgradeUrl = new URL(process.env.DATABASE_URL!);
  upgradeUrl.pathname = `/${databaseName}`;
  upgrade = postgres(upgradeUrl.toString(), { max: 1 });
  await upgrade`CREATE EXTENSION IF NOT EXISTS vector`;
  const historicalMigrations = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < '0042_')
    .sort();
  for (const migration of historicalMigrations) await applyMigration(upgrade, migration);
}, 120_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

test('0042 through 0044 preserve historical correlation and delivery evidence', async () => {
  const tenantId = randomUUID();
  const connectorId = randomUUID();
  const sourceIncidentId = randomUUID();
  const targetIncidentId = randomUUID();
  const signalId = randomUUID();
  const relationId = randomUUID();
  const cohortId = randomUUID();
  const runId = randomUUID();
  const bindingId = randomUUID();
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const evidenceId = randomUUID();
  const otherTenantId = randomUUID();
  const otherIncidentId = randomUUID();
  const otherRunId = randomUUID();

  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'causal migration')`;
  await upgrade`
    INSERT INTO connector_configs (id, tenant_id, type, name, settings)
    VALUES (${connectorId}, ${tenantId}, 'prometheus', 'Historical Prometheus', '{}'::jsonb)
  `;
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity, title)
    VALUES
      (${sourceIncidentId}, ${tenantId}, ${`source-${sourceIncidentId}`}, 'prometheus', 'checkout', 'sev2', 'Source'),
      (${targetIncidentId}, ${tenantId}, ${`target-${targetIncidentId}`}, 'prometheus', 'database', 'sev2', 'Target')
  `;
  await upgrade`
    INSERT INTO incident_signals
      (id, tenant_id, incident_id, surface, channel, external_message_id, state,
       last_event_type, summary, content_hash, last_event_key, last_event_at,
       material_hash, last_investigated_material_hash, data_source_id, provider,
       provider_fingerprint, starts_at)
    VALUES
      (${signalId}, ${tenantId}, ${sourceIncidentId}, 'slack', 'C-history', 'history-root',
       'resolved', 'resolved', 'Historical signal', 'history-content', 'history-event',
       '2026-08-30T00:00:00.000Z', 'history-material', 'history-material', ${connectorId},
       'alertmanager', '0123456789abcdef', '2026-08-30T00:00:00.000Z')
  `;
  await upgrade`
    INSERT INTO incident_relations
      (id, tenant_id, source_incident_id, target_incident_id, type, rationale, evidence, decided_by)
    VALUES
      (${relationId}, ${tenantId}, ${sourceIncidentId}, ${targetIncidentId},
       'possible_related', 'Historical candidate', jsonb_build_array('cohort:historical'), 'agent')
  `;
  await upgrade`
    INSERT INTO alert_cohorts
      (id, tenant_id, data_source_id, anchor_signal_id, state, window_started_at,
       window_ends_at, last_alert_at)
    VALUES
      (${cohortId}, ${tenantId}, ${connectorId}, ${signalId}, 'settled',
       '2026-08-30T00:00:00.000Z', '2026-08-30T00:02:00.000Z',
       '2026-08-30T00:00:00.000Z')
  `;
  await upgrade`
    INSERT INTO alert_cohort_members (tenant_id, cohort_id, signal_id)
    VALUES (${tenantId}, ${cohortId}, ${signalId})
  `;
  await upgrade`
    INSERT INTO investigation_runs
      (id, tenant_id, incident_id, operation, turn_budget, outcome, result, evidence_ids,
       started_at, completed_at)
    VALUES
      (${runId}, ${tenantId}, ${sourceIncidentId}, 'reassess', 1, 'conclusive',
       jsonb_build_object('summary', 'Historical run'), '{}'::uuid[],
       '2026-08-30T00:01:00.000Z', '2026-08-30T00:02:00.000Z')
  `;
  await upgrade`
    INSERT INTO surface_bindings
      (id, tenant_id, incident_id, surface, channel, thread_id, role, projection_mode)
    VALUES
      (${bindingId}, ${tenantId}, ${sourceIncidentId}, 'slack', 'C-history', 'history-root',
       'primary', 'full')
  `;
  await upgrade`
    INSERT INTO incident_messages (id, tenant_id, incident_id, author, kind, content)
    VALUES (${messageId}, ${tenantId}, ${sourceIncidentId}, 'system', 'lifecycle', 'Historical lifecycle')
  `;
  await upgrade`
    INSERT INTO surface_deliveries
      (id, tenant_id, incident_id, message_id, binding_id, surface, state, remote_message_id)
    VALUES
      (${deliveryId}, ${tenantId}, ${sourceIncidentId}, ${messageId}, ${bindingId}, 'slack',
       'accepted', '1788000000.000001')
  `;

  for (const migration of [
    '0042_superb_captain_cross.sql',
    '0043_funny_captain_marvel.sql',
    '0044_complete_prowler.sql',
  ])
    await applyMigration(upgrade, migration);

  const [cohort] = await upgrade<
    Array<{ source_scope_key: string; state: string; analysis_job_id: string | null }>
  >`
    SELECT source_scope_key, state, analysis_job_id FROM alert_cohorts WHERE id = ${cohortId}
  `;
  expect(cohort).toEqual({
    source_scope_key: `connector:${connectorId}`,
    state: 'settled',
    analysis_job_id: null,
  });
  const [relation] = await upgrade<
    Array<{
      rationale: string;
      evidence_ids: string[];
      confidence: number | null;
      decision_run_id: string | null;
    }>
  >`
    SELECT rationale, evidence_ids, confidence, decision_run_id
    FROM incident_relations WHERE id = ${relationId}
  `;
  expect(relation).toEqual({
    rationale: 'Historical candidate',
    evidence_ids: [],
    confidence: null,
    decision_run_id: null,
  });
  const [signal] = await upgrade<Array<{ summary: string }>>`
    SELECT summary FROM incident_signals WHERE id = ${signalId}
  `;
  expect(signal?.summary).toBe('Historical signal');
  const [delivery] = await upgrade<
    Array<{ state: string; binding_id: string; remote_message_id: string }>
  >`
    SELECT state, binding_id, remote_message_id FROM surface_deliveries WHERE id = ${deliveryId}
  `;
  expect(delivery).toEqual({
    state: 'accepted',
    binding_id: bindingId,
    remote_message_id: '1788000000.000001',
  });

  await expect(
    upgrade`
      UPDATE incident_relations
      SET type = 'caused_by', decided_by = 'agent'
      WHERE id = ${relationId}
    `,
  ).rejects.toThrow();
  await upgrade`
    UPDATE incident_relations
    SET type = 'caused_by', decided_by = 'agent', decision_run_id = ${runId},
        confidence = 90, evidence_ids = ARRAY[${evidenceId}]::uuid[]
    WHERE id = ${relationId}
  `;
  await upgrade`INSERT INTO tenants (id, name) VALUES (${otherTenantId}, 'other tenant')`;
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity, title)
    VALUES (${otherIncidentId}, ${otherTenantId}, 'other-fingerprint', 'prometheus', 'other', 'sev3', 'Other incident')
  `;
  await upgrade`
    INSERT INTO investigation_runs
      (id, tenant_id, incident_id, operation, outcome, result, completed_at)
    VALUES
      (${otherRunId}, ${otherTenantId}, ${otherIncidentId}, 'reassess', 'conclusive',
       '{"summary":"foreign run"}'::jsonb, now())
  `;
  await expect(
    upgrade`
      UPDATE incident_relations SET decision_run_id = ${otherRunId} WHERE id = ${relationId}
    `,
  ).rejects.toMatchObject({ code: '23503' });
  const indexes = await upgrade<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE indexname IN ('jobs_cohort_analysis_coalesce_idx', 'jobs_relation_reassessment_coalesce_idx')
    ORDER BY indexname
  `;
  expect(indexes).toHaveLength(2);
  for (const index of indexes) {
    expect(index.indexdef).toContain("status = 'queued'");
    expect(index.indexdef).not.toContain('processing');
  }
});
