import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `investigation_run_${randomUUID().replaceAll('-', '')}`;
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
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < '0029_')
    .sort();
  for (const migration of historicalMigrations) await applyMigration(upgrade, migration);
}, 30_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

test('0029 through 0031 preserve existing assessments and add nullable trigger provenance', async () => {
  const tenantId = randomUUID();
  const incidentId = randomUUID();
  const legacyRunId = randomUUID();
  const legacySignalId = randomUUID();
  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'run migration')`;
  await upgrade`
    INSERT INTO incidents
      (id, tenant_id, fingerprint, alert_source, service, severity,
       investigation_status, rca_summary, confidence, assessment_updated_at)
    VALUES
      (${incidentId}, ${tenantId}, ${`legacy-${incidentId}`}, 'test', 'checkout', 'sev2',
       'assessed', 'Existing trusted assessment', 82, '2026-08-30T00:00:00.000Z')
  `;

  await applyMigration(upgrade, '0029_hot_havok.sql');

  const [incident] = await upgrade<
    Array<{
      rca_summary: string;
      confidence: number;
      assessment_updated_at: Date;
      trusted_assessment_run_id: string | null;
    }>
  >`
    SELECT rca_summary, confidence, assessment_updated_at, trusted_assessment_run_id
    FROM incidents
    WHERE id = ${incidentId}
  `;
  expect(incident).toEqual({
    rca_summary: 'Existing trusted assessment',
    confidence: 82,
    assessment_updated_at: new Date('2026-08-30T00:00:00.000Z'),
    trusted_assessment_run_id: null,
  });

  const [table] = await upgrade<Array<{ rls_enabled: boolean; completion_check: boolean }>>`
    SELECT c.relrowsecurity AS rls_enabled,
           EXISTS (
             SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = c.oid
               AND con.conname = 'investigation_runs_completion_shape'
           ) AS completion_check
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'investigation_runs'
  `;
  expect(table).toEqual({ rls_enabled: true, completion_check: true });

  await upgrade`
    INSERT INTO investigation_runs
      (id, tenant_id, incident_id, operation, provider, engine_model, engine_session_id,
       turn_budget, outcome, result, evidence_ids, started_at, completed_at)
    VALUES
      (${legacyRunId}, ${tenantId}, ${incidentId}, 'investigate', 'anthropic', 'legacy-model',
       'legacy-session', 4, 'inconclusive', ${JSON.stringify({ summary: 'Legacy run' })}::jsonb,
       '{}'::uuid[], '2026-08-30T00:01:00.000Z', '2026-08-30T00:02:00.000Z')
  `;
  await upgrade`
    INSERT INTO incident_signals
      (id, tenant_id, incident_id, surface, channel, external_message_id, state,
       last_event_type, summary, content_hash, last_event_key, last_event_at,
       material_hash, last_investigated_material_hash)
    VALUES
      (${legacySignalId}, ${tenantId}, ${incidentId}, 'slack', 'C-alerts', 'legacy-root', 'firing',
       'opened', 'Legacy alert', 'legacy-hash', 'legacy-event', '2026-08-30T00:00:00.000Z',
       'legacy-material', 'legacy-material')
  `;

  await applyMigration(upgrade, '0030_outstanding_tusk.sql');
  const [upgradedIncident] = await upgrade<
    Array<{
      rca_summary: string;
      trusted_assessment_run_id: string | null;
      recovery_run_id: string | null;
    }>
  >`
    SELECT rca_summary, trusted_assessment_run_id, recovery_run_id
    FROM incidents
    WHERE id = ${incidentId}
  `;
  expect(upgradedIncident).toEqual({
    rca_summary: 'Existing trusted assessment',
    trusted_assessment_run_id: null,
    recovery_run_id: null,
  });

  const [recoveryForeignKey] = await upgrade<Array<{ definition: string }>>`
    SELECT pg_catalog.pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    WHERE con.conrelid = 'incidents'::regclass
      AND con.conname = 'incidents_recovery_run_fk'
  `;
  expect(recoveryForeignKey?.definition).toContain(
    'FOREIGN KEY (tenant_id, id, recovery_run_id) REFERENCES investigation_runs(tenant_id, incident_id, id)',
  );

  await applyMigration(upgrade, '0031_vengeful_santa_claus.sql');
  const [triggerColumns] = await upgrade<
    Array<{
      job_id: string | null;
      trigger_reason: string | null;
      trigger_automatic: boolean;
      trigger_monitor_key: string | null;
      trigger_monitor_keys: string[];
      trigger_budget: unknown | null;
      admission_denied: boolean;
      outcome: string;
    }>
  >`
    SELECT job_id, trigger_reason, trigger_automatic, trigger_monitor_key, trigger_monitor_keys,
           trigger_budget, admission_denied, outcome
    FROM investigation_runs
    WHERE id = ${legacyRunId}
  `;
  expect(triggerColumns).toEqual({
    job_id: null,
    trigger_reason: null,
    trigger_automatic: false,
    trigger_monitor_key: null,
    trigger_monitor_keys: [],
    trigger_budget: null,
    admission_denied: false,
    outcome: 'inconclusive',
  });
  const [signal] = await upgrade<
    Array<{ monitor_key: string | null; last_investigated_version: number | null; summary: string }>
  >`
    SELECT monitor_key, last_investigated_version, summary
    FROM incident_signals
    WHERE id = ${legacySignalId}
  `;
  expect(signal).toEqual({
    monitor_key: null,
    last_investigated_version: 1,
    summary: 'Legacy alert',
  });
  await expect(
    upgrade`UPDATE investigation_runs SET trigger_reason = 'unsupported' WHERE id = ${legacyRunId}`,
  ).rejects.toThrow();
});
