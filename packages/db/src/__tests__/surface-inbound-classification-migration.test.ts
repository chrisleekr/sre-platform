import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `inbound_classification_${randomUUID().replaceAll('-', '')}`;
let control: Sql;
let upgrade: Sql;

async function applyMigration(client: Sql, filename: string): Promise<void> {
  const source = await readFile(join(migrationsDir, filename), 'utf8');
  for (const statement of source.split('--> statement-breakpoint')) {
    if (statement.trim()) await client.unsafe(statement);
  }
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
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < '0028_')
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

test('0028 preserves receipts and marks only historical unobserved classifications', async () => {
  const tenantId = randomUUID();
  const configId = randomUUID();
  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'classification migration')`;
  await upgrade`
    INSERT INTO surface_configs (id, tenant_id, surface)
    VALUES (${configId}, ${tenantId}, 'slack')
  `;
  await upgrade`
    INSERT INTO surface_inbound_events
      (tenant_id, config_id, surface, delivery_key, envelope_type, state, outcome,
       completed_at, updated_at)
    VALUES
      (${tenantId}, ${configId}, 'slack', 'completed', 'events_api', 'processed',
       'classify_enqueued', '2026-08-29T00:01:00.000Z', '2026-08-29T00:02:00.000Z'),
      (${tenantId}, ${configId}, 'slack', 'fallback', 'events_api', 'processed',
       'classify_enqueued', null, '2026-08-29T00:03:00.000Z'),
      (${tenantId}, ${configId}, 'slack', 'mention', 'events_api', 'processed',
       'mention_enqueued', '2026-08-29T00:03:30.000Z', '2026-08-29T00:03:45.000Z'),
      (${tenantId}, ${configId}, 'slack', 'edit', 'events_api', 'processed',
       'edit_enqueued', '2026-08-29T00:03:50.000Z', '2026-08-29T00:03:55.000Z'),
      (${tenantId}, ${configId}, 'slack', 'unrelated', 'events_api', 'processed',
       'resume_enqueued', '2026-08-29T00:04:00.000Z', '2026-08-29T00:05:00.000Z')
  `;

  await applyMigration(upgrade, '0028_cultured_colossus.sql');

  const columns = await upgrade<Array<{ column_name: string; is_nullable: string }>>`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'surface_inbound_events'
      AND column_name IN ('classification_outcome', 'classification_updated_at')
    ORDER BY column_name
  `;
  expect(columns).toEqual([
    { column_name: 'classification_outcome', is_nullable: 'YES' },
    { column_name: 'classification_updated_at', is_nullable: 'YES' },
  ]);

  const rows = await upgrade<
    Array<{
      delivery_key: string;
      classification_outcome: string | null;
      classification_updated_at: Date | null;
    }>
  >`
    SELECT delivery_key, classification_outcome, classification_updated_at
    FROM surface_inbound_events
    ORDER BY delivery_key
  `;
  expect(rows).toEqual([
    {
      delivery_key: 'completed',
      classification_outcome: 'legacy_unobserved',
      classification_updated_at: new Date('2026-08-29T00:01:00.000Z'),
    },
    {
      delivery_key: 'edit',
      classification_outcome: 'legacy_unobserved',
      classification_updated_at: new Date('2026-08-29T00:03:50.000Z'),
    },
    {
      delivery_key: 'fallback',
      classification_outcome: 'legacy_unobserved',
      classification_updated_at: new Date('2026-08-29T00:03:00.000Z'),
    },
    {
      delivery_key: 'mention',
      classification_outcome: 'legacy_unobserved',
      classification_updated_at: new Date('2026-08-29T00:03:30.000Z'),
    },
    {
      delivery_key: 'unrelated',
      classification_outcome: null,
      classification_updated_at: null,
    },
  ]);
});
