import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `incident_feedback_${randomUUID().replaceAll('-', '')}`;
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
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < '0038_')
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

test('0038 adds attributed feedback and 0040 repairs prerelease schema drift', async () => {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const userId = randomUUID();
  const foreignUserId = randomUUID();
  const incidentId = randomUUID();
  const foreignIncidentId = randomUUID();
  const messageId = randomUUID();
  const firstFeedbackId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const secondFeedbackId = '00000000-0000-4000-8000-000000000001';
  await upgrade`
    INSERT INTO tenants (id, name)
    VALUES (${tenantId}, 'feedback upgrade'), (${foreignTenantId}, 'foreign feedback upgrade')
  `;
  await upgrade`
    INSERT INTO users (id, issuer, subject)
    VALUES
      (${userId}, 'test', ${`user-${userId}`}),
      (${foreignUserId}, 'test', ${`user-${foreignUserId}`})
  `;
  await upgrade`
    INSERT INTO memberships (user_id, tenant_id)
    VALUES (${userId}, ${tenantId}), (${foreignUserId}, ${foreignTenantId})
  `;
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity)
    VALUES
      (${incidentId}, ${tenantId}, ${`legacy-${incidentId}`}, 'test', 'checkout', 'sev2'),
      (${foreignIncidentId}, ${foreignTenantId}, ${`foreign-${foreignIncidentId}`}, 'test', 'checkout', 'sev2')
  `;
  await upgrade`
    INSERT INTO incident_messages (id, tenant_id, incident_id, author, kind, content)
    VALUES (${messageId}, ${tenantId}, ${incidentId}, 'agent', 'finding', 'Legacy finding')
  `;

  await applyMigration(upgrade, '0038_huge_rockslide.sql');
  await upgrade`ALTER TABLE incident_feedback FORCE ROW LEVEL SECURITY`;

  const [legacy] = await upgrade<Array<{ content: string; finding: unknown | null }>>`
    SELECT content, finding FROM incident_messages WHERE id = ${messageId}
  `;
  expect(legacy).toEqual({ content: 'Legacy finding', finding: null });
  await upgrade`
    INSERT INTO incident_feedback
      (id, tenant_id, incident_id, target_type, target_id, decision, rationale,
       created_by_user_id, created_at)
    VALUES
      (${firstFeedbackId}, ${tenantId}, ${incidentId}, 'finding', 'legacy-run', 'confirm', 'Evidence agrees.',
       ${userId}, '2026-09-01T00:00:00.000Z'),
      (${randomUUID()}, ${foreignTenantId}, ${foreignIncidentId}, 'noise', 'foreign-signal', 'noise', 'Synthetic only.',
       ${foreignUserId}, '2026-09-01T00:00:00.000Z')
  `;
  await upgrade`
    INSERT INTO incident_feedback
      (id, tenant_id, incident_id, target_type, target_id, decision, rationale,
       created_by_user_id, revision, created_at)
    VALUES
      (${secondFeedbackId}, ${tenantId}, ${incidentId}, 'finding', 'legacy-run', 'correct', 'Evidence changed.',
       ${userId}, 2, '2026-09-01T00:00:00.000Z')
  `;
  await expect(
    upgrade`
      INSERT INTO incident_feedback
        (tenant_id, incident_id, target_type, target_id, decision, rationale, created_by_user_id)
      VALUES
        (${tenantId}, ${incidentId}, 'finding', 'wrong-member', 'confirm', 'Wrong tenant.', ${foreignUserId})
    `,
  ).rejects.toThrow(/incident_feedback_membership_fk/);
  await expect(
    upgrade`
      INSERT INTO incident_feedback
        (tenant_id, incident_id, target_type, target_id, decision, rationale, created_by_user_id)
      VALUES
        (${tenantId}, ${foreignIncidentId}, 'noise', 'foreign-incident', 'noise', 'Wrong incident.', ${userId})
    `,
  ).rejects.toThrow(/incident_feedback_incident_fk/);

  const [security] = await upgrade<Array<{ enabled: boolean; forced: boolean; policies: number }>>`
    SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
      (SELECT count(*)::int FROM pg_policies WHERE tablename = 'incident_feedback') AS policies
    FROM pg_class c WHERE c.oid = 'incident_feedback'::regclass
  `;
  expect(security).toEqual({ enabled: true, forced: true, policies: 1 });
  const indexes = await upgrade<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'incident_feedback'
  `;
  expect(indexes.map((row) => row.indexname)).toContain('incident_feedback_actor_created_idx');
  expect(indexes.map((row) => row.indexname)).toContain('incident_feedback_target_revision_uq');
  await upgrade.unsafe('GRANT USAGE ON SCHEMA public TO app_user');
  await upgrade.unsafe('GRANT SELECT, INSERT ON incident_feedback TO app_user');
  const visible = await upgrade.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return tx<Array<{ target_id: string; revision: number }>>`
      SELECT target_id, revision FROM incident_feedback ORDER BY target_id, revision
    `;
  });
  expect(visible).toEqual([
    { target_id: 'legacy-run', revision: 1 },
    { target_id: 'legacy-run', revision: 2 },
  ]);

  await applyMigration(upgrade, '0040_repair_incident_feedback_revision.sql');
  const preserved = await upgrade<Array<{ id: string; rationale: string; revision: number }>>`
    SELECT id, rationale, revision
    FROM incident_feedback
    WHERE target_id = 'legacy-run'
    ORDER BY revision
  `;
  expect(preserved).toEqual([
    { id: firstFeedbackId, rationale: 'Evidence agrees.', revision: 1 },
    { id: secondFeedbackId, rationale: 'Evidence changed.', revision: 2 },
  ]);

  await upgrade`
    UPDATE incident_feedback
    SET created_at = '2026-09-01T00:01:00.000Z'
    WHERE id = ${secondFeedbackId}
  `;
  await upgrade`DROP INDEX incident_feedback_target_revision_uq`;
  await upgrade`ALTER TABLE incident_feedback DROP COLUMN revision`;
  await applyMigration(upgrade, '0040_repair_incident_feedback_revision.sql');

  const repaired = await upgrade<Array<{ target_id: string; rationale: string; revision: number }>>`
    SELECT target_id, rationale, revision
    FROM incident_feedback
    ORDER BY target_id, revision
  `;
  expect(repaired).toEqual([
    { target_id: 'foreign-signal', rationale: 'Synthetic only.', revision: 1 },
    { target_id: 'legacy-run', rationale: 'Evidence agrees.', revision: 1 },
    { target_id: 'legacy-run', rationale: 'Evidence changed.', revision: 2 },
  ]);
  const [repairIndex] = await upgrade<Array<{ indexname: string }>>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'incident_feedback_target_revision_uq'
  `;
  expect(repairIndex).toEqual({ indexname: 'incident_feedback_target_revision_uq' });
});
