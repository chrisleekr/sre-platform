import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `issue277_upgrade_${randomUUID().replaceAll('-', '')}`;
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
  ]) {
    await applyMigration(upgrade, migration);
  }
  // runMigrations forces RLS after every released migration batch. Reproduce that live pre-upgrade
  // state before applying the issue 277 migration in isolation.
  await upgrade`ALTER TABLE connector_configs FORCE ROW LEVEL SECURITY`;
}, 30_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

describe('issue 277 database upgrades', () => {
  test('preserves populated GitHub rows while adding health and transient-environment evidence', async () => {
    const tenantId = randomUUID();
    const connectorId = randomUUID();
    await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'migration tenant')`;
    await upgrade`
      INSERT INTO connector_configs
        (id, tenant_id, type, settings, enabled, poll_snapshot_count, poll_error_count)
      VALUES
        (${connectorId}, ${tenantId}, 'github',
         ${upgrade.json({ repo: 'acme/checkout' })}, false, 7, 2)
    `;
    await upgrade`
      INSERT INTO deployments (tenant_id, source, repo, sha, status, deployed_at)
      VALUES (${tenantId}, 'github', 'acme/checkout', 'deadbeef', 'success', now())
    `;

    await applyMigration(upgrade, '0009_swift_cerebro.sql');

    const [row] = await upgrade<
      Array<{
        id: string;
        settings: { repo: string };
        enabled: boolean;
        poll_snapshot_count: number;
        poll_error_count: number;
        lifecycle_version: number;
        verification_duration_ms: number | null;
        verification_rate_limit_remaining: number | null;
        verification_rate_limit_reset_at: Date | null;
        poll_duration_ms: number | null;
        poll_rate_limit_remaining: number | null;
        poll_rate_limit_reset_at: Date | null;
      }>
    >`SELECT * FROM connector_configs WHERE id = ${connectorId}`;
    expect(row).toMatchObject({
      id: connectorId,
      settings: { repo: 'acme/checkout' },
      enabled: false,
      poll_snapshot_count: 7,
      poll_error_count: 2,
      lifecycle_version: 0,
      verification_duration_ms: null,
      verification_rate_limit_remaining: null,
      verification_rate_limit_reset_at: null,
      poll_duration_ms: null,
      poll_rate_limit_remaining: null,
      poll_rate_limit_reset_at: null,
    });
    const [deployment] = await upgrade<
      Array<{ repo: string; sha: string; transient_environment: boolean }>
    >`SELECT repo, sha, transient_environment FROM deployments WHERE tenant_id = ${tenantId}`;
    expect(deployment).toEqual({
      repo: 'acme/checkout',
      sha: 'deadbeef',
      transient_environment: false,
    });
    const [security] = await upgrade<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>
    >`
      SELECT c.relrowsecurity, c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies WHERE tablename = 'connector_configs') AS policies
      FROM pg_class c WHERE c.oid = 'connector_configs'::regclass
    `;
    expect(security).toEqual({ relrowsecurity: true, relforcerowsecurity: true, policies: 1 });
  });
});
