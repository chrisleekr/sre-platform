import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `incident_correlation_${randomUUID().replaceAll('-', '')}`;
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
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < '0032_')
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

test('0032 preserves historical rows while enforcing correlation provenance', async () => {
  const tenantId = randomUUID();
  const sourceIncidentId = randomUUID();
  const targetIncidentId = randomUUID();
  const signalId = randomUUID();
  const relationId = randomUUID();
  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'correlation migration')`;
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity, title)
    VALUES
      (${sourceIncidentId}, ${tenantId}, ${`source-${sourceIncidentId}`}, 'test', 'checkout', 'sev2', 'Source incident'),
      (${targetIncidentId}, ${tenantId}, ${`target-${targetIncidentId}`}, 'test', 'database', 'sev2', 'Target incident')
  `;
  await upgrade`
    INSERT INTO incident_signals
      (id, tenant_id, incident_id, surface, channel, external_message_id, state,
       last_event_type, summary, content_hash, last_event_key, last_event_at,
       material_hash, last_investigated_material_hash)
    VALUES
      (${signalId}, ${tenantId}, ${sourceIncidentId}, 'slack', 'C-alerts', 'legacy-root',
       'firing', 'opened', 'Legacy provider signal', 'legacy-content', 'legacy-event',
       '2026-08-30T00:00:00.000Z', 'legacy-material', 'legacy-material')
  `;
  await upgrade`
    INSERT INTO incident_relations
      (id, tenant_id, source_incident_id, target_incident_id, type, rationale, evidence,
       decided_by)
    VALUES
      (${relationId}, ${tenantId}, ${sourceIncidentId}, ${targetIncidentId},
       'possible_related', 'Legacy relationship', jsonb_build_array('legacy:evidence'),
       'system')
  `;

  await applyMigration(upgrade, '0032_spotty_abomination.sql');

  const [incident] = await upgrade<Array<{ title: string; correlation_max_age_at: Date | null }>>`
    SELECT title, correlation_max_age_at
    FROM incidents
    WHERE id = ${sourceIncidentId}
  `;
  expect(incident).toEqual({ title: 'Source incident', correlation_max_age_at: null });

  const [signal] = await upgrade<
    Array<{
      summary: string;
      correlation_method: string | null;
      correlation_rationale: string | null;
      correlation_features: unknown | null;
      correlation_confidence: number | null;
      correlation_window_started_at: Date | null;
      correlation_window_expires_at: Date | null;
      correlation_max_age_at: Date | null;
    }>
  >`
    SELECT summary, correlation_method, correlation_rationale, correlation_features,
           correlation_confidence, correlation_window_started_at, correlation_window_expires_at,
           correlation_max_age_at
    FROM incident_signals
    WHERE id = ${signalId}
  `;
  expect(signal).toEqual({
    summary: 'Legacy provider signal',
    correlation_method: null,
    correlation_rationale: null,
    correlation_features: null,
    correlation_confidence: null,
    correlation_window_started_at: null,
    correlation_window_expires_at: null,
    correlation_max_age_at: null,
  });
  const [relation] = await upgrade<
    Array<{ rationale: string; evidence: string[]; correlation_feedback: unknown | null }>
  >`
    SELECT rationale, evidence, correlation_feedback
    FROM incident_relations
    WHERE id = ${relationId}
  `;
  expect(relation).toEqual({
    rationale: 'Legacy relationship',
    evidence: ['legacy:evidence'],
    correlation_feedback: null,
  });

  const tables = await upgrade<Array<{ relname: string; rls_enabled: boolean }>>`
    SELECT relname, relrowsecurity AS rls_enabled
    FROM pg_class
    WHERE relname IN ('incident_signals', 'incident_relations')
    ORDER BY relname
  `;
  expect(tables).toEqual([
    { relname: 'incident_relations', rls_enabled: true },
    { relname: 'incident_signals', rls_enabled: true },
  ]);
  const constraints = await upgrade<Array<{ conname: string }>>`
    SELECT conname
    FROM pg_constraint
    WHERE conname LIKE 'incident_signals_correlation_%'
    ORDER BY conname
  `;
  expect(constraints.map(({ conname }) => conname)).toEqual([
    'incident_signals_correlation_confidence_range',
    'incident_signals_correlation_decision_shape',
    'incident_signals_correlation_method_vocabulary',
  ]);
  const relationConstraints = await upgrade<Array<{ conname: string }>>`
    SELECT conname
    FROM pg_constraint
    WHERE conname = 'incident_relations_correlation_feedback_shape'
  `;
  expect(relationConstraints).toEqual([
    { conname: 'incident_relations_correlation_feedback_shape' },
  ]);
  const indexes = await upgrade<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE indexname IN (
      'incident_relations_active_uq',
      'incident_relations_correlation_feedback_idx',
      'incident_relations_target_idx',
      'incident_signals_correlation_history_idx',
      'incident_signals_correlation_scope_idx'
    )
    ORDER BY indexname
  `;
  expect(indexes.map(({ indexname }) => indexname)).toEqual([
    'incident_relations_active_uq',
    'incident_relations_correlation_feedback_idx',
    'incident_relations_target_idx',
    'incident_signals_correlation_history_idx',
    'incident_signals_correlation_scope_idx',
  ]);
  const feedbackIndex = indexes.find(
    ({ indexname }) => indexname === 'incident_relations_correlation_feedback_idx',
  );
  expect(feedbackIndex?.indexdef.toLowerCase()).toContain('using gin (correlation_feedback)');
  expect(feedbackIndex?.indexdef.toLowerCase()).toContain('superseded_at is null');

  await expect(
    upgrade`UPDATE incident_signals SET correlation_method = 'guess' WHERE id = ${signalId}`,
  ).rejects.toThrow();
  await expect(
    upgrade`
      UPDATE incident_relations
      SET correlation_feedback = jsonb_build_object(
        'decision', 'separate',
        'sourceScopeKeys', jsonb_build_array('scope'),
        'targetScopeKeys', jsonb_build_array('scope'),
        'sharedScopeKeys', jsonb_build_array('scope')
      )
      WHERE id = ${relationId}
    `,
  ).rejects.toThrow();
  await expect(
    upgrade`
      UPDATE incident_relations
      SET decided_by = 'human',
          decided_by_user_id = ${randomUUID()},
          correlation_feedback = jsonb_build_object(
            'decision', 'guess',
            'sourceScopeKeys', jsonb_build_array('scope'),
            'targetScopeKeys', jsonb_build_array('scope'),
            'sharedScopeKeys', 'scope'
          )
      WHERE id = ${relationId}
    `,
  ).rejects.toThrow();
  await expect(
    upgrade`
      UPDATE incident_relations
      SET decided_by = 'human',
          decided_by_user_id = ${randomUUID()},
          correlation_feedback = jsonb_build_object(
            'decision', 'separate',
            'targetScopeKeys', jsonb_build_array('scope'),
            'sharedScopeKeys', jsonb_build_array('scope')
          )
      WHERE id = ${relationId}
    `,
  ).rejects.toThrow();
  await expect(
    upgrade`
      UPDATE incident_relations
      SET decided_by = 'human',
          decided_by_user_id = ${randomUUID()},
          correlation_feedback = jsonb_build_object(
            'decision', 'separate',
            'sourceScopeKeys', jsonb_build_array(42),
            'targetScopeKeys', jsonb_build_array('scope'),
            'sharedScopeKeys', jsonb_build_array('scope')
          )
      WHERE id = ${relationId}
    `,
  ).rejects.toThrow();
  await upgrade`
    UPDATE incident_relations
    SET decided_by = 'human',
        decided_by_user_id = ${randomUUID()},
        correlation_feedback = jsonb_build_object(
          'decision', 'separate',
          'sourceScopeKeys', jsonb_build_array('scope'),
          'targetScopeKeys', jsonb_build_array('scope'),
          'sharedScopeKeys', jsonb_build_array('scope')
        )
    WHERE id = ${relationId}
  `;
  await expect(
    upgrade`UPDATE incident_signals SET correlation_confidence = 101 WHERE id = ${signalId}`,
  ).rejects.toThrow();
  await expect(
    upgrade`
      UPDATE incident_signals
      SET correlation_method = 'new_incident'
      WHERE id = ${signalId}
    `,
  ).rejects.toThrow();
  await expect(
    upgrade`
      UPDATE incident_signals
      SET correlation_window_expires_at = '2026-08-30T00:05:00.000Z'
      WHERE id = ${signalId}
    `,
  ).rejects.toThrow();
  await expect(
    upgrade`
      UPDATE incident_signals
      SET correlation_window_started_at = '2026-08-30T00:00:00.000Z'
      WHERE id = ${signalId}
    `,
  ).rejects.toThrow();
  await upgrade`
    UPDATE incident_signals
    SET correlation_method = 'new_incident',
        correlation_rationale = 'No active incident owns this stable subject.',
        correlation_features = jsonb_build_array('stable_subject_identity', 'no_active_incident'),
        correlation_confidence = 100,
        correlation_window_started_at = '2026-08-30T00:00:00.000Z',
        correlation_window_expires_at = '2026-08-30T00:05:00.000Z',
        correlation_max_age_at = '2026-08-30T12:00:00.000Z'
    WHERE id = ${signalId}
  `;
  await expect(
    upgrade`
      UPDATE incident_signals
      SET correlation_features = jsonb_build_array('stable_subject_identity', 42)
      WHERE id = ${signalId}
    `,
  ).rejects.toThrow();
});
