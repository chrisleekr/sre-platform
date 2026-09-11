import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `entity_context_${randomUUID().replaceAll('-', '')}`;
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
  const historical = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < '0033_')
    .sort();
  for (const migration of historical) await applyMigration(upgrade, migration);
}, 30_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

test('0033 preserves legacy signals and adds tenant-scoped correction storage', async () => {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const userId = randomUUID();
  const foreignUserId = randomUUID();
  const incidentId = randomUUID();
  const signalId = randomUUID();
  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'entity migration'), (${foreignTenantId}, 'foreign entity migration')`;
  await upgrade`
    INSERT INTO users (id, issuer, subject)
    VALUES (${userId}, 'test', ${`user-${userId}`}), (${foreignUserId}, 'test', ${`user-${foreignUserId}`})
  `;
  await upgrade`
    INSERT INTO memberships (user_id, tenant_id)
    VALUES (${userId}, ${tenantId}), (${foreignUserId}, ${foreignTenantId})
  `;
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity)
    VALUES (${incidentId}, ${tenantId}, ${`legacy-${incidentId}`}, 'test', 'legacy-service', 'sev3')
  `;
  await upgrade`
    INSERT INTO incident_signals
      (id, tenant_id, incident_id, surface, channel, external_message_id, state,
       last_event_type, summary, content_hash, last_event_key, last_event_at)
    VALUES
      (${signalId}, ${tenantId}, ${incidentId}, 'slack', 'C-legacy', 'legacy-message',
       'firing', 'opened', 'Legacy signal', 'content', 'event', '2026-08-31T00:00:00.000Z')
  `;

  await applyMigration(upgrade, '0033_gray_ted_forrester.sql');
  await upgrade`
    INSERT INTO services (tenant_id, name)
    VALUES (${tenantId}, 'legacy-service'), (${foreignTenantId}, 'legacy-service')
  `;
  await upgrade`
    INSERT INTO entity_service_mappings
      (tenant_id, candidate_key, candidate_kind, service_name, confirmed_by_user_id, rationale)
    VALUES
      (${tenantId}, 'workload-a', 'workload', 'legacy-service', ${userId}, 'Confirmed by tenant member.'),
      (${foreignTenantId}, 'workload-b', 'workload', 'legacy-service', ${foreignUserId}, 'Confirmed by foreign tenant member.')
  `;

  const [signal] = await upgrade<
    Array<{ summary: string; signal_source: unknown | null; affected_entities: unknown | null }>
  >`
    SELECT summary, signal_source, affected_entities
    FROM incident_signals
    WHERE id = ${signalId}
  `;
  expect(signal).toEqual({
    summary: 'Legacy signal',
    signal_source: null,
    affected_entities: null,
  });
  const [table] = await upgrade<Array<{ rls: boolean }>>`
    SELECT relrowsecurity AS rls
    FROM pg_class
    WHERE relname = 'entity_service_mappings'
  `;
  expect(table).toEqual({ rls: true });
  const constraints = await upgrade<Array<{ conname: string }>>`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'entity_service_mappings'::regclass
    ORDER BY conname
  `;
  expect(constraints.map(({ conname }) => conname)).toEqual(
    expect.arrayContaining([
      'entity_service_mappings_candidate_uq',
      'entity_service_mappings_service_fk',
      'entity_service_mappings_membership_fk',
      'entity_service_mappings_rationale_not_blank',
    ]),
  );

  await expect(
    upgrade`
      INSERT INTO entity_service_mappings
        (tenant_id, candidate_key, candidate_kind, service_name, confirmed_by_user_id, rationale)
      VALUES
        (${tenantId}, 'foreign-member', 'workload', 'legacy-service', ${foreignUserId}, 'Wrong tenant member.')
    `,
  ).rejects.toThrow(/entity_service_mappings_membership_fk/);
  await expect(
    upgrade`
      INSERT INTO entity_service_mappings
        (tenant_id, candidate_key, candidate_kind, service_name, confirmed_by_user_id, rationale)
      VALUES
        (${tenantId}, 'missing-member', 'workload', 'legacy-service', NULL, 'Missing attribution.')
    `,
  ).rejects.toThrow(/confirmed_by_user_id/);
  await expect(
    upgrade`UPDATE incident_signals SET signal_source = '[]'::jsonb WHERE id = ${signalId}`,
  ).rejects.toThrow(/incident_signals_signal_source_shape/);
  await expect(
    upgrade`UPDATE incident_signals SET affected_entities = '{}'::jsonb WHERE id = ${signalId}`,
  ).rejects.toThrow(/incident_signals_affected_entities_shape/);

  await upgrade.unsafe('GRANT USAGE ON SCHEMA public TO app_user');
  await upgrade.unsafe(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON entity_service_mappings TO app_user',
  );
  const visible = await upgrade.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return tx<Array<{ candidate_key: string }>>`
      SELECT candidate_key FROM entity_service_mappings ORDER BY candidate_key
    `;
  });
  expect(visible).toEqual([{ candidate_key: 'workload-a' }]);
});
