import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `issue276_upgrade_${randomUUID().replaceAll('-', '')}`;
let control: Sql;
let upgrade: Sql;

async function applyMigration(client: Sql, filename: string): Promise<void> {
  const source = await readFile(join(migrationsDir, filename), 'utf8');
  for (const statement of source.split('--> statement-breakpoint')) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

beforeAll(async () => {
  const controlUrl = new URL(ADMIN_URL);
  controlUrl.pathname = '/postgres';
  control = postgres(controlUrl.toString(), { max: 1 });
  await control.unsafe(`CREATE DATABASE "${databaseName}"`);
  const upgradeUrl = new URL(ADMIN_URL);
  upgradeUrl.pathname = `/${databaseName}`;
  upgrade = postgres(upgradeUrl.toString(), { max: 1 });
  await upgrade`CREATE EXTENSION IF NOT EXISTS vector`;
  const migrations = [
    '0000_damp_the_professor.sql',
    '0001_wandering_exiles.sql',
    '0002_natural_vance_astro.sql',
    '0003_white_stature.sql',
    '0004_strange_mentor.sql',
    '0005_early_namor.sql',
    '0006_polite_piledriver.sql',
    '0007_mature_old_lace.sql',
  ];
  for (const migration of migrations) await applyMigration(upgrade, migration);
}, 30_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

describe('0008 GitLab deployment identity upgrade', () => {
  test('preserves legacy rows and splits legacy SHA from provider-event uniqueness', async () => {
    const tenantId = randomUUID();
    const legacyId = randomUUID();
    await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'migration tenant')`;
    await upgrade`
      INSERT INTO deployments
        (id, tenant_id, source, repo, ref, sha, service, status, url, deployed_at)
      VALUES
        (${legacyId}, ${tenantId}, 'gitlab', 'legacy/project', 'main', 'same-sha',
         'checkout', 'success', 'https://gitlab.example.com/legacy', '2026-08-20T00:00:00Z')
    `;

    await applyMigration(upgrade, '0008_common_solo.sql');

    const [legacy] = await upgrade<
      Array<{
        id: string;
        provider_id: string | null;
        environment: string | null;
        actor: string | null;
        provider_created_at: Date | null;
        provider_updated_at: Date | null;
      }>
    >`SELECT id, provider_id, environment, actor, provider_created_at, provider_updated_at
      FROM deployments WHERE id = ${legacyId}`;
    expect(legacy).toEqual({
      id: legacyId,
      provider_id: null,
      environment: null,
      actor: null,
      provider_created_at: null,
      provider_updated_at: null,
    });

    await expect(
      upgrade`
        INSERT INTO deployments
          (tenant_id, source, repo, sha, status, deployed_at)
        VALUES (${tenantId}, 'gitlab', 'another/project', 'same-sha', 'success', now())
      `,
    ).rejects.toThrow(/deployments_legacy_sha_uq/);

    await upgrade`
      INSERT INTO deployments
        (tenant_id, source, repo, provider_id, sha, status, deployed_at)
      VALUES
        (${tenantId}, 'gitlab', 'legacy/project', 'deployment-42', 'same-sha', 'blocked', now())
    `;
    const [{ count }] = await upgrade<[{ count: number }]>`
      SELECT count(*)::int AS count FROM deployments WHERE tenant_id = ${tenantId}
    `;
    expect(count).toBe(2);
  });
});
