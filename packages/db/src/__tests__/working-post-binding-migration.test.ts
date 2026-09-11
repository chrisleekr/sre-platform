import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `working_post_binding_${randomUUID().replaceAll('-', '')}`;
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
  const migrations = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 26)
    .sort();
  for (const migration of migrations) await applyMigration(upgrade, migration);
}, 30_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

test('0027 preserves an in-flight post on its primary conversation binding', async () => {
  const tenantId = randomUUID();
  const incidentId = randomUUID();
  const promotableIncidentId = randomUUID();
  const movedIncidentId = randomUUID();
  const orphanIncidentId = randomUUID();
  const primaryBindingId = randomUUID();
  const sourceBindingId = randomUUID();
  const promotablePrimaryBindingId = randomUUID();
  const promotableSourceBindingId = randomUUID();
  const crossChannelBindingId = randomUUID();
  const movedBindingId = randomUUID();
  const movedMessageId = randomUUID();
  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'migration tenant')`;
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity)
    VALUES
      (${incidentId}, ${tenantId}, ${randomUUID()}, 'slack', 'checkout', 'sev2'),
      (${promotableIncidentId}, ${tenantId}, ${randomUUID()}, 'slack', 'payments', 'sev2'),
      (${movedIncidentId}, ${tenantId}, ${randomUUID()}, 'slack', 'billing', 'sev2'),
      (${orphanIncidentId}, ${tenantId}, ${randomUUID()}, 'slack', 'search', 'sev3')
  `;
  await upgrade`
    INSERT INTO surface_bindings
      (id, tenant_id, incident_id, surface, channel, thread_id, role, projection_mode)
    VALUES
      (${primaryBindingId}, ${tenantId}, ${incidentId}, 'slack', 'C-MIGRATION', 'old-root', 'primary', 'full'),
      (${sourceBindingId}, ${tenantId}, ${incidentId}, 'slack', 'C-MIGRATION', 'new-root', 'source', 'status'),
      (${promotablePrimaryBindingId}, ${tenantId}, ${promotableIncidentId}, 'slack', 'C-IDLE', 'idle-old-root', 'primary', 'full'),
      (${promotableSourceBindingId}, ${tenantId}, ${promotableIncidentId}, 'slack', 'C-IDLE', 'idle-new-root', 'source', 'status'),
      (${crossChannelBindingId}, ${tenantId}, ${promotableIncidentId}, 'slack', 'C-PUBLIC', 'public-root', 'source', 'status'),
      (${movedBindingId}, ${tenantId}, ${incidentId}, 'slack', 'C-MOVED', 'moved-root', 'source', 'status')
  `;
  await upgrade`
    INSERT INTO surface_working_posts (tenant_id, incident_id, surface, message_ts)
    VALUES
      (${tenantId}, ${incidentId}, 'slack', '1788000000.000001'),
      (${tenantId}, ${movedIncidentId}, 'slack', '1788000000.000003'),
      (${tenantId}, ${orphanIncidentId}, 'slack', '1788000000.000004')
  `;
  await upgrade`
    INSERT INTO incident_messages
      (tenant_id, incident_id, author, kind, content, origin_message_id, created_at)
    VALUES
      (${tenantId}, ${incidentId}, 'system', 'relationship', 'Related alert correlated with this incident.',
       ${`correlated-source:slack:C-MIGRATION:new-root`}, '2026-08-29T00:00:00Z'),
      (${tenantId}, ${promotableIncidentId}, 'system', 'relationship', 'Related alert correlated with this incident.',
       ${`correlated-source:slack:C-IDLE:idle-new-root`}, '2026-08-29T00:00:00Z'),
      (${tenantId}, ${promotableIncidentId}, 'system', 'relationship', 'Related alert correlated with this incident.',
       ${`correlated-source:slack:C-PUBLIC:public-root`}, '2026-08-29T00:01:00Z')
  `;
  await upgrade`
    INSERT INTO incident_messages
      (id, tenant_id, incident_id, author, kind, content)
    VALUES
      (${movedMessageId}, ${tenantId}, ${movedIncidentId}, 'agent', 'tool_step', 'Inspecting billing')
  `;
  await upgrade`
    INSERT INTO surface_deliveries
      (tenant_id, incident_id, message_id, binding_id, surface, state, remote_message_id)
    VALUES
      (${tenantId}, ${movedIncidentId}, ${movedMessageId}, ${movedBindingId}, 'slack', 'accepted',
       '1788000000.000003')
  `;

  await applyMigration(upgrade, '0027_bumpy_captain_cross.sql');

  const preserved = await upgrade<
    Array<{ binding_id: string; message_ts: string; incident_id_column: boolean }>
  >`
    SELECT working.binding_id, working.message_ts,
           EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_name = 'surface_working_posts' AND column_name = 'incident_id'
           ) AS incident_id_column
    FROM surface_working_posts AS working
    ORDER BY working.message_ts
  `;
  expect(preserved).toEqual([
    {
      binding_id: primaryBindingId,
      message_ts: '1788000000.000001',
      incident_id_column: false,
    },
    {
      binding_id: movedBindingId,
      message_ts: '1788000000.000003',
      incident_id_column: false,
    },
  ]);

  await upgrade`
    INSERT INTO surface_working_posts (tenant_id, binding_id, message_ts)
    VALUES (${tenantId}, ${sourceBindingId}, '1788000000.000002')
  `;
  const rows = await upgrade`SELECT binding_id FROM surface_working_posts ORDER BY message_ts`;
  expect(rows.map((row) => row.binding_id)).toEqual([
    primaryBindingId,
    sourceBindingId,
    movedBindingId,
  ]);

  const bindings = await upgrade`
    SELECT id, role, projection_mode FROM surface_bindings
    WHERE incident_id = ${incidentId} AND channel = 'C-MIGRATION'
    ORDER BY thread_id
  `;
  expect(bindings).toEqual([
    { id: sourceBindingId, role: 'source', projection_mode: 'status' },
    { id: primaryBindingId, role: 'primary', projection_mode: 'full' },
  ]);
  const promotable = await upgrade`
    SELECT id, role, projection_mode FROM surface_bindings
    WHERE incident_id = ${promotableIncidentId} AND channel = 'C-IDLE'
    ORDER BY thread_id
  `;
  expect(promotable).toEqual([
    { id: promotableSourceBindingId, role: 'primary', projection_mode: 'full' },
    { id: promotablePrimaryBindingId, role: 'source', projection_mode: 'status' },
  ]);
  const [crossChannel] = await upgrade`
    SELECT role, projection_mode FROM surface_bindings WHERE id = ${crossChannelBindingId}
  `;
  expect(crossChannel).toEqual({ role: 'source', projection_mode: 'status' });
});
