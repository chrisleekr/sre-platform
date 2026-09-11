import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `provider_lifecycle_${randomUUID().replaceAll('-', '')}`;
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
  for (const migration of [
    '0000_damp_the_professor.sql',
    '0001_wandering_exiles.sql',
    '0002_natural_vance_astro.sql',
    '0003_white_stature.sql',
    '0004_strange_mentor.sql',
    '0005_early_namor.sql',
    '0006_polite_piledriver.sql',
    '0007_mature_old_lace.sql',
    '0008_common_solo.sql',
    '0009_swift_cerebro.sql',
    '0010_gray_clea.sql',
    '0011_open_skreet.sql',
    '0012_fancy_adam_warlock.sql',
    '0013_loving_thundra.sql',
    '0014_bent_lady_mastermind.sql',
    '0015_square_edwin_jarvis.sql',
    '0016_romantic_doctor_faustus.sql',
    '0017_smiling_doorman.sql',
  ])
    await applyMigration(upgrade, migration);
}, 30_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

test('0018-0019 safely upgrade historical delivery ownership and install tenant-safe fences', async () => {
  const tenantId = randomUUID();
  const connectorId = randomUUID();
  const incidentId = randomUUID();
  const bindingId = randomUUID();
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const signalId = randomUUID();
  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'migration tenant')`;
  await upgrade`
    INSERT INTO connector_configs (id, tenant_id, name, type, settings, enabled)
    VALUES (${connectorId}, ${tenantId}, 'Prometheus', 'prometheus', '{}'::jsonb, true)
  `;
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity, title)
    VALUES (${incidentId}, ${tenantId}, ${randomUUID()}, 'prometheus', 'checkout', 'sev2', 'Checkout alert')
  `;
  await upgrade`
    INSERT INTO surface_bindings (id, tenant_id, incident_id, surface, channel, thread_id)
    VALUES (${bindingId}, ${tenantId}, ${incidentId}, 'slack', 'C-MIGRATION', '1788000000.000001')
  `;
  await upgrade`
    INSERT INTO incident_messages (id, tenant_id, incident_id, author, kind, content)
    VALUES (${messageId}, ${tenantId}, ${incidentId}, 'system', 'signal', 'Historical provider evidence')
  `;
  await upgrade`
    INSERT INTO surface_deliveries (id, tenant_id, incident_id, message_id, surface, state)
    VALUES (${deliveryId}, ${tenantId}, ${incidentId}, ${messageId}, 'slack', 'accepted')
  `;
  await upgrade`
    INSERT INTO incident_signals
      (id, tenant_id, incident_id, surface, channel, external_message_id, state,
       last_event_type, summary, content_hash, last_event_key, last_event_at)
    VALUES
      (${signalId}, ${tenantId}, ${incidentId}, 'slack', 'C-MIGRATION', '1788000000.000001',
       'firing', 'opened', 'Historical signal summary', 'content-hash', 'event-key', now())
  `;

  const orphanIncidentId = randomUUID();
  const orphanMessageId = randomUUID();
  await expect(
    upgrade.begin(async (tx) => {
      await tx`
        INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity)
        VALUES (${orphanIncidentId}, ${tenantId}, ${randomUUID()}, 'prometheus', 'orphan', 'sev3')
      `;
      await tx`
        INSERT INTO incident_messages (id, tenant_id, incident_id, author, content)
        VALUES (${orphanMessageId}, ${tenantId}, ${orphanIncidentId}, 'system', 'Orphan delivery')
      `;
      await tx`
        INSERT INTO surface_deliveries (tenant_id, incident_id, message_id, surface)
        VALUES (${tenantId}, ${orphanIncidentId}, ${orphanMessageId}, 'slack')
      `;
      await applyMigration(tx as unknown as Sql, '0018_omniscient_bedlam.sql');
    }),
  ).rejects.toThrow(/surface delivery has no matching incident binding/i);

  await applyMigration(upgrade, '0018_omniscient_bedlam.sql');
  await applyMigration(upgrade, '0019_eager_oracle.sql');

  const [preserved] = await upgrade<
    Array<{
      binding_id: string;
      content: string;
      summary: string;
      provider: string | null;
      role: string;
      projection_mode: string;
      assignment_version: number;
      binding_assignment_version: number;
    }>
  >`
    SELECT d.binding_id, d.binding_assignment_version, m.content, s.summary, s.provider,
           b.role, b.projection_mode, b.assignment_version
    FROM surface_deliveries d
    JOIN incident_messages m ON m.tenant_id = d.tenant_id AND m.id = d.message_id
    JOIN incident_signals s ON s.tenant_id = d.tenant_id AND s.incident_id = d.incident_id
    JOIN surface_bindings b ON b.tenant_id = d.tenant_id AND b.id = d.binding_id
    WHERE d.id = ${deliveryId}
  `;
  expect(preserved).toEqual({
    binding_id: bindingId,
    content: 'Historical provider evidence',
    summary: 'Historical signal summary',
    provider: null,
    role: 'primary',
    projection_mode: 'full',
    assignment_version: 0,
    binding_assignment_version: 0,
  });

  await upgrade`
    INSERT INTO surface_bindings
      (tenant_id, incident_id, surface, channel, thread_id, role, projection_mode)
    VALUES
      (${tenantId}, ${incidentId}, 'slack', 'C-MIGRATION', '1788000000.000002', 'source', 'status')
  `;
  await expect(
    upgrade`
      INSERT INTO surface_bindings
        (tenant_id, incident_id, surface, channel, thread_id, role, projection_mode)
      VALUES
        (${tenantId}, ${incidentId}, 'slack', 'C-MIGRATION', '1788000000.000003', 'primary', 'full')
    `,
  ).rejects.toThrow(/surface_bindings_primary_uq/i);

  const otherTenantId = randomUUID();
  const otherIncidentId = randomUUID();
  const otherBindingId = randomUUID();
  await upgrade`INSERT INTO tenants (id, name) VALUES (${otherTenantId}, 'other tenant')`;
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity)
    VALUES (${otherIncidentId}, ${otherTenantId}, ${randomUUID()}, 'prometheus', 'other', 'sev3')
  `;
  await upgrade`
    INSERT INTO surface_bindings (id, tenant_id, incident_id, surface, channel, thread_id)
    VALUES (${otherBindingId}, ${otherTenantId}, ${otherIncidentId}, 'slack', 'C-OTHER', '1788000000.000004')
  `;
  await expect(
    upgrade`UPDATE surface_deliveries SET binding_id = ${otherBindingId} WHERE id = ${deliveryId}`,
  ).rejects.toThrow(/surface_deliveries_binding_fk/i);
}, 30_000);
