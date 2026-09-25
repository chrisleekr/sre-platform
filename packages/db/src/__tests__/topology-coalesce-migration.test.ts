import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `topology_coalesce_${randomUUID().replaceAll('-', '')}`;
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
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < '0092_')
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

test('0092 keeps one queued topology pass per connector, preferring a full pass', async () => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const connectorA = randomUUID();
  const connectorB = randomUUID();
  const oldestContinuation = randomUUID();
  const fullPass = randomUUID();
  const newerContinuation = randomUUID();
  const processing = randomUUID();
  const onlyB = randomUUID();
  const otherTenant = randomUUID();
  // sql.json: a bare string bound to a jsonb cast is stored as a JSON string scalar, not an object.
  const full = upgrade.json({ connectorId: connectorA });
  const continuation = upgrade.json({
    connectorId: connectorA,
    pageCount: 1,
    collections: ['dashboards'],
  });

  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'topology migration')`;
  await upgrade`INSERT INTO tenants (id, name) VALUES (${otherTenantId}, 'other tenant')`;
  await upgrade`
    INSERT INTO jobs (id, tenant_id, type, payload, status, stream, created_at)
    VALUES
      (${oldestContinuation}, ${tenantId}, 'topology.discover', ${continuation}, 'queued',
       'sre:jobs:topology', now() - interval '3 minutes'),
      (${fullPass}, ${tenantId}, 'topology.discover', ${full}, 'queued',
       'sre:jobs:topology', now() - interval '2 minutes'),
      (${newerContinuation}, ${tenantId}, 'topology.discover', ${continuation}, 'queued',
       'sre:jobs:topology', now() - interval '1 minute'),
      (${processing}, ${tenantId}, 'topology.discover', ${full}, 'processing',
       'sre:jobs:topology', now() - interval '4 minutes'),
      (${onlyB}, ${tenantId}, 'topology.discover', ${upgrade.json({ connectorId: connectorB })},
       'queued', 'sre:jobs:topology', now() - interval '3 minutes'),
      (${otherTenant}, ${otherTenantId}, 'topology.discover', ${full}, 'queued',
       'sre:jobs:topology', now() - interval '3 minutes')
  `;

  await applyMigration(upgrade, '0092_real_quasimodo.sql');

  const rows = await upgrade<Array<{ id: string; status: string }>>`
    SELECT id, status FROM jobs WHERE tenant_id IN (${tenantId}, ${otherTenantId})
  `;
  const status = Object.fromEntries(rows.map((row) => [row.id, row.status]));
  expect(status).toEqual({
    [oldestContinuation]: 'done',
    [fullPass]: 'queued',
    [newerContinuation]: 'done',
    [processing]: 'processing',
    [onlyB]: 'queued',
    [otherTenant]: 'queued',
  });
  const indexes = await upgrade<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE indexname = 'jobs_topology_discover_coalesce_idx'
  `;
  expect(indexes).toHaveLength(1);
});
