import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `inbound_disposition_${randomUUID().replaceAll('-', '')}`;
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
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < '0034_')
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

test('0034 through 0037 preserve rows and add exact ordering plus classify idempotency', async () => {
  const tenantId = randomUUID();
  const configId = randomUUID();
  const incidentId = randomUUID();
  const signalId = randomUUID();
  const signalExternalId = `legacy-signal-${randomUUID()}`;
  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'disposition migration')`;
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity)
    VALUES (${incidentId}, ${tenantId}, ${`legacy-${incidentId}`}, 'slack', 'checkout', 'sev2')
  `;
  await upgrade`
    INSERT INTO incident_signals
      (id, tenant_id, incident_id, surface, channel, external_message_id, state,
       last_event_type, summary, content_hash, last_event_key, last_event_at)
    VALUES
      (${signalId}, ${tenantId}, ${incidentId}, 'slack', 'C-upgrade', ${signalExternalId},
       'firing', 'opened', 'Legacy checkout alert', 'legacy-hash', 'legacy-event',
       '2026-08-21T01:00:00.000Z')
  `;
  await upgrade`
    INSERT INTO surface_configs (id, tenant_id, surface)
    VALUES (${configId}, ${tenantId}, 'slack')
  `;
  await upgrade`
    INSERT INTO surface_inbound_events
      (tenant_id, config_id, surface, delivery_key, envelope_type, channel, state, outcome)
    VALUES
      (${tenantId}, ${configId}, 'slack', 'queued', 'events_api', 'C-upgrade', 'queued', null),
      (${tenantId}, ${configId}, 'slack', 'processed', 'events_api', 'C-upgrade', 'processed', 'classify_enqueued')
  `;

  await applyMigration(upgrade, '0034_late_morph.sql');
  await applyMigration(upgrade, '0035_nostalgic_korg.sql');
  await applyMigration(upgrade, '0036_redundant_inhumans.sql');

  const rows = await upgrade<
    Array<{
      delivery_key: string;
      external_message_id: string | null;
      terminal_disposition: string | null;
      terminal_disposition_at: Date | null;
      terminal_disposition_event_at: Date | null;
      terminal_disposition_event_version: bigint | null;
    }>
  >`
    SELECT delivery_key, external_message_id, terminal_disposition,
           terminal_disposition_at, terminal_disposition_event_at,
           terminal_disposition_event_version
    FROM surface_inbound_events
    ORDER BY delivery_key
  `;
  expect(rows).toEqual([
    {
      delivery_key: 'processed',
      external_message_id: null,
      terminal_disposition: null,
      terminal_disposition_at: null,
      terminal_disposition_event_at: null,
      terminal_disposition_event_version: null,
    },
    {
      delivery_key: 'queued',
      external_message_id: null,
      terminal_disposition: null,
      terminal_disposition_at: null,
      terminal_disposition_event_at: null,
      terminal_disposition_event_version: null,
    },
  ]);

  const columns = await upgrade<Array<{ column_name: string; is_nullable: string }>>`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'surface_inbound_events'
      AND column_name IN (
        'external_message_id',
        'terminal_disposition',
        'terminal_disposition_at',
        'terminal_disposition_event_at',
        'terminal_disposition_event_version'
      )
    ORDER BY column_name
  `;
  expect(columns).toEqual([
    { column_name: 'external_message_id', is_nullable: 'YES' },
    { column_name: 'terminal_disposition', is_nullable: 'YES' },
    { column_name: 'terminal_disposition_at', is_nullable: 'YES' },
    { column_name: 'terminal_disposition_event_at', is_nullable: 'YES' },
    { column_name: 'terminal_disposition_event_version', is_nullable: 'YES' },
  ]);

  const signalColumns = await upgrade<Array<{ column_name: string; is_nullable: string }>>`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'incident_signals'
      AND column_name = 'last_event_version'
  `;
  expect(signalColumns).toEqual([{ column_name: 'last_event_version', is_nullable: 'YES' }]);

  const guardTriggers = await upgrade<Array<{ trigger_name: string }>>`
    SELECT trigger.tgname AS trigger_name
    FROM pg_trigger AS trigger
    JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
    WHERE relation.relname = 'incident_signals'
      AND trigger.tgname LIKE 'incident_signals_guard_terminal_surface_decision_%'
      AND NOT trigger.tgisinternal
    ORDER BY trigger.tgname
  `;
  expect(guardTriggers).toEqual([
    { trigger_name: 'incident_signals_guard_terminal_surface_decision_insert' },
    { trigger_name: 'incident_signals_guard_terminal_surface_decision_update' },
  ]);
  const guardedRoot = `guarded-root-${randomUUID()}`;
  await upgrade`
    INSERT INTO surface_inbound_events
      (tenant_id, config_id, surface, delivery_key, envelope_type, channel,
       external_message_id, state, terminal_disposition, terminal_disposition_at,
       terminal_disposition_event_at, terminal_disposition_event_version)
    VALUES
      (${tenantId}, ${configId}, 'slack', ${`guarded-${randomUUID()}`}, 'events_api',
       'C-upgrade', ${guardedRoot}, 'processed', 'suppressed_provider_control_notification',
       now(), '2026-08-21T01:00:00.010Z', 1787274000010500)
  `;
  await expect(
    upgrade`
      INSERT INTO incident_signals
        (tenant_id, incident_id, surface, channel, external_message_id, state,
         last_event_type, summary, content_hash, last_event_key, last_event_at,
         last_event_version)
      VALUES
        (${tenantId}, ${incidentId}, 'slack', 'C-upgrade', ${`${guardedRoot}#member`},
         'firing', 'opened', 'late rolling worker', 'late-rolling-worker',
         'late-rolling-worker', '2026-08-21T01:00:00.010Z', 1787274000010499)
    `,
  ).rejects.toMatchObject({ code: 'P2871' });

  // Seed an exact writer at the historical schema boundary, then exercise the migration's trigger.
  await upgrade`UPDATE incident_signals SET summary = 'Legacy checkout alert updated',
    last_event_at = '2026-08-21T01:00:00.001Z', last_event_version = 1787274000001000
    WHERE id = ${signalId}`;
  await upgrade`
    UPDATE incident_signals
    SET last_event_at = '2026-08-21T01:00:00.001Z',
        summary = 'same-millisecond old writer regression'
    WHERE id = ${signalId}
  `;
  const sameMillisecond = await upgrade<
    Array<{ summary: string; last_event_version: string | null }>
  >`
    SELECT summary, last_event_version
    FROM incident_signals
    WHERE id = ${signalId}
  `;
  expect(sameMillisecond).toEqual([
    { summary: 'Legacy checkout alert updated', last_event_version: '1787274000001000' },
  ]);
  await upgrade`
    UPDATE incident_signals
    SET last_event_at = '2026-08-21T01:00:00.002Z',
        summary = 'newer old writer observation'
    WHERE id = ${signalId}
  `;
  const projectedOldWriter = await upgrade<
    Array<{ summary: string; last_event_version: string | null }>
  >`
    SELECT summary, last_event_version
    FROM incident_signals
    WHERE id = ${signalId}
  `;
  expect(projectedOldWriter).toEqual([
    { summary: 'newer old writer observation', last_event_version: '1787274000002999' },
  ]);
  const duplicateIntakeId = randomUUID();
  const duplicateEventKey = `slack:C-upgrade:${randomUUID()}`;
  await upgrade`
    INSERT INTO jobs (tenant_id, type, payload, stream)
    VALUES
      (${tenantId}, 'classify', ${upgrade.json({ intakeId: duplicateIntakeId, eventKey: duplicateEventKey })}, 'sre:classify'),
      (${tenantId}, 'classify', ${upgrade.json({ intakeId: duplicateIntakeId, eventKey: duplicateEventKey })}, 'sre:classify')
  `;
  await applyMigration(upgrade, '0037_next_starhawk.sql');

  const classifyRows = await upgrade<
    Array<{ idempotency_key: string | null; event_key: string | null }>
  >`
    SELECT idempotency_key, event_key
    FROM jobs
    WHERE tenant_id = ${tenantId} AND type = 'classify'
    ORDER BY idempotency_key NULLS LAST, event_key NULLS LAST
  `;
  expect(classifyRows).toEqual([
    { idempotency_key: duplicateIntakeId, event_key: duplicateEventKey },
    { idempotency_key: null, event_key: null },
  ]);

  const oldWriterIntakeId = randomUUID();
  const oldWriterEventKey = `slack:C-upgrade:${randomUUID()}`;
  const oldWriterPayload = {
    intakeId: oldWriterIntakeId,
    eventKey: oldWriterEventKey,
    channel: 'C-upgrade',
    externalId: '1788278400.000001',
  };
  const oldWriterRows = await upgrade<
    Array<{ idempotency_key: string | null; event_key: string | null }>
  >`
    INSERT INTO jobs (tenant_id, type, payload, stream)
    VALUES (${tenantId}, 'classify', ${upgrade.json(oldWriterPayload)}, 'sre:classify')
    RETURNING idempotency_key, event_key
  `;
  expect(oldWriterRows).toEqual([
    { idempotency_key: oldWriterIntakeId, event_key: oldWriterEventKey },
  ]);
  const duplicateOldWriterRows = await upgrade<Array<{ id: string }>>`
    INSERT INTO jobs (tenant_id, type, payload, stream)
    VALUES (${tenantId}, 'classify', ${upgrade.json(oldWriterPayload)}, 'sre:classify')
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  expect(duplicateOldWriterRows).toEqual([]);

  const indexColumns = await upgrade<Array<{ column_name: string }>>`
    SELECT attribute.attname AS column_name
    FROM pg_class index_class
    JOIN pg_index index_info ON index_info.indexrelid = index_class.oid
    JOIN LATERAL unnest(index_info.indkey) WITH ORDINALITY AS key(attnum, ordinal) ON true
    JOIN pg_attribute attribute
      ON attribute.attrelid = index_info.indrelid AND attribute.attnum = key.attnum
    WHERE index_class.relname = 'surface_inbound_events_message_idx'
    ORDER BY key.ordinal
  `;
  expect(indexColumns.map((row) => row.column_name)).toEqual([
    'tenant_id',
    'surface',
    'channel',
    'external_message_id',
  ]);
});
