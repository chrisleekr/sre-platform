import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = 'packages/db/migrations';
const databaseName = `resolution_policy_${randomUUID().replaceAll('-', '')}`;
let control: Sql;
let upgrade: Sql;
const tenantId = randomUUID();
const incidentId = randomUUID();

async function apply(filename: string) {
  const migration = await readFile(`${migrationsDir}/${filename}`, 'utf8');
  for (const statement of migration.split('--> statement-breakpoint'))
    if (statement.trim()) await upgrade.unsafe(statement);
}

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/postgres';
  control = postgres(url.toString(), { max: 1 });
  await control.unsafe(`CREATE DATABASE "${databaseName}"`);
  url.pathname = `/${databaseName}`;
  upgrade = postgres(url.toString(), { max: 1 });
  await upgrade`CREATE EXTENSION IF NOT EXISTS vector`;
  const files = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const file of files.filter((name) => name < '0087_')) await apply(file);
  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'Legacy resolution policy')`;
  await upgrade`INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity)
    VALUES (${incidentId}, ${tenantId}, ${randomUUID()}, 'slack', 'checkout', 'sev3')`;
  await upgrade`INSERT INTO incident_signals
    (tenant_id, incident_id, surface, channel, external_message_id, state, summary, content_hash, last_event_key, last_event_type, last_event_at)
    VALUES (${tenantId}, ${incidentId}, 'slack', 'C_LEGACY', 'legacy-message', 'resolved', 'Historical recovery notice', 'legacy-hash', 'legacy-event', 'resolved', now())`;
  for (const file of files.filter((name) => name >= '0087_')) await apply(file);
}, 30_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

test('upgrade gives legacy incidents strict policy without inventing resolution basis or provider provenance', async () => {
  const [incident] = await upgrade`SELECT to_jsonb(i)->>'resolution_policy' AS policy,
    to_jsonb(i)->>'resolution_basis' AS basis FROM incidents i WHERE id = ${incidentId}`;
  expect(incident).toEqual({ policy: 'verified_recovery', basis: null });
  const [signal] =
    await upgrade`SELECT to_jsonb(s)->>'clear_provenance' AS provenance FROM incident_signals s WHERE incident_id = ${incidentId}`;
  expect(signal).toEqual({ provenance: null });
});

test('database constraints reject invalid policy, basis, provenance and provider-clear health checks', async () => {
  await expect(
    upgrade`UPDATE incidents SET resolution_policy = 'unrecognized' WHERE id = ${incidentId}`,
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    upgrade`UPDATE incidents SET resolution_basis = 'unrecognized' WHERE id = ${incidentId}`,
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    upgrade`UPDATE incident_signals SET clear_provenance = 'unrecognized' WHERE incident_id = ${incidentId}`,
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    upgrade`UPDATE incidents SET purpose = 'health_check', resolution_policy = 'provider_clear' WHERE id = ${incidentId}`,
  ).rejects.toMatchObject({ code: '23514' });
});
