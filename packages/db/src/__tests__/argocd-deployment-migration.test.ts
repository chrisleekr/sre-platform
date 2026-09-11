import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import postgres, { type Sql } from 'postgres';

const ADMIN_URL = process.env.DATABASE_URL!;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `argocd_upgrade_${randomUUID().replaceAll('-', '')}`;
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
    '0009_swift_cerebro.sql',
  ]) {
    await applyMigration(upgrade, migration);
  }
  await upgrade`ALTER TABLE deployments FORCE ROW LEVEL SECURITY`;
}, 30_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

describe('ArgoCD deployment evidence migration', () => {
  test('preserves populated rows and adds nullable structured evidence without weakening RLS', async () => {
    const tenantId = randomUUID();
    await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'migration tenant')`;
    await upgrade`
      INSERT INTO deployments (tenant_id, source, provider_id, repo, sha, status, deployed_at)
      VALUES (${tenantId}, 'argocd', 'payments/argocd/checkout:7',
              'payments/argocd/checkout', 'release-app', 'success', now())
    `;
    await upgrade`
      INSERT INTO connector_configs
        (tenant_id, type, settings, enabled, verification_attempted_at,
         verification_succeeded_at, verification_failure_category, verification_duration_ms,
         verification_rate_limit_remaining, verification_rate_limit_reset_at,
         poll_attempted_at, poll_succeeded_at, poll_snapshot_count, poll_error_count,
         poll_failure_category, poll_duration_ms, poll_rate_limit_remaining,
         poll_rate_limit_reset_at, poll_cursor)
      VALUES
        (${tenantId}, 'argocd', ${upgrade.json({ baseUrl: 'https://legacy.example' })}, true,
         now(), now(), 'legacy', 10, 20, now(), now(), now(), 3, 4, 'legacy', 11, 19, now(),
         ${upgrade.json({ cursor: 'legacy' })})
    `;

    await applyMigration(upgrade, '0010_gray_clea.sql');

    const [preserved] = await upgrade<
      Array<{
        provider_id: string;
        sha: string;
        revisions: string[] | null;
        operation_phase: string | null;
      }>
    >`SELECT provider_id, sha, revisions, operation_phase
      FROM deployments WHERE tenant_id = ${tenantId}`;
    expect(preserved).toEqual({
      provider_id: 'payments/argocd/checkout:7',
      sha: 'release-app',
      revisions: null,
      operation_phase: null,
    });
    const [connector] = await upgrade<
      Array<{
        enabled: boolean;
        lifecycle_version: number;
        verification_attempted_at: Date | null;
        verification_succeeded_at: Date | null;
        verification_failure_category: string | null;
        verification_duration_ms: number | null;
        verification_rate_limit_remaining: number | null;
        verification_rate_limit_reset_at: Date | null;
        poll_attempted_at: Date | null;
        poll_succeeded_at: Date | null;
        poll_snapshot_count: number;
        poll_error_count: number;
        poll_failure_category: string | null;
        poll_duration_ms: number | null;
        poll_rate_limit_remaining: number | null;
        poll_rate_limit_reset_at: Date | null;
        poll_cursor: unknown;
      }>
    >`SELECT enabled, lifecycle_version, verification_attempted_at, verification_succeeded_at,
             verification_failure_category, verification_duration_ms,
             verification_rate_limit_remaining, verification_rate_limit_reset_at,
             poll_attempted_at, poll_succeeded_at, poll_snapshot_count, poll_error_count,
             poll_failure_category, poll_duration_ms, poll_rate_limit_remaining,
             poll_rate_limit_reset_at, poll_cursor
      FROM connector_configs WHERE tenant_id = ${tenantId} AND type = 'argocd'`;
    expect(connector).toEqual({
      enabled: false,
      lifecycle_version: 1,
      verification_attempted_at: null,
      verification_succeeded_at: null,
      verification_failure_category: null,
      verification_duration_ms: null,
      verification_rate_limit_remaining: null,
      verification_rate_limit_reset_at: null,
      poll_attempted_at: null,
      poll_succeeded_at: null,
      poll_snapshot_count: 0,
      poll_error_count: 0,
      poll_failure_category: null,
      poll_duration_ms: null,
      poll_rate_limit_remaining: null,
      poll_rate_limit_reset_at: null,
      poll_cursor: null,
    });
    const [security] = await upgrade<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>
    >`
      SELECT c.relrowsecurity, c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies WHERE tablename = 'deployments') AS policies
      FROM pg_class c WHERE c.oid = 'deployments'::regclass
    `;
    expect(security).toEqual({ relrowsecurity: true, relforcerowsecurity: true, policies: 1 });
  });
});
