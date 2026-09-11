import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `connector_instances_${randomUUID().replaceAll('-', '')}`;
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
  const adminUrl = new URL(process.env.DATABASE_URL!);
  adminUrl.pathname = '/postgres';
  control = postgres(adminUrl.toString(), { max: 1 });
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
  ]) {
    await applyMigration(upgrade, migration);
  }
  await upgrade`ALTER TABLE connector_configs FORCE ROW LEVEL SECURITY`;
}, 30_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

describe('0016 multi-instance connector upgrade', () => {
  test('preserves singleton credentials and evidence, then isolates same-type instances', async () => {
    const tenantId = randomUUID();
    const originalId = randomUUID();
    const secondId = randomUUID();
    const gitlabId = randomUUID();
    await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'migration tenant')`;
    await upgrade`
      INSERT INTO connector_configs (id, tenant_id, type, settings, enabled, webhook_key)
      VALUES (${originalId}, ${tenantId}, 'github', ${upgrade.json({ appId: '1' })}, true, ${originalId})
    `;
    await upgrade`
      INSERT INTO tenant_secrets (tenant_id, name, ciphertext, nonce, auth_tag)
      VALUES (${tenantId}, 'connector:github', decode('aa', 'hex'), decode('bb', 'hex'), decode('cc', 'hex'))
    `;
    await upgrade`
      INSERT INTO github_events
        (tenant_id, delivery_id, event_type, repository_id, repository_full_name, summary, occurred_at)
      VALUES (${tenantId}, 'delivery-1', 'push', '42', 'acme/api', '{}'::jsonb, now())
    `;
    await upgrade`
      INSERT INTO github_repositories
        (tenant_id, installation_id, repository_id, owner, name, full_name, html_url)
      VALUES (${tenantId}, '7', '42', 'acme', 'api', 'acme/api', 'https://github.com/acme/api')
    `;
    await upgrade`
      INSERT INTO deployments (tenant_id, source, repo, provider_id, sha, status, deployed_at)
      VALUES (${tenantId}, 'github', 'acme/api', 'deployment-1', 'abc123', 'success', now())
    `;
    await upgrade`
      INSERT INTO connector_configs (id, tenant_id, type, settings, enabled, webhook_key)
      VALUES (${gitlabId}, ${tenantId}, 'gitlab', ${upgrade.json({ groupId: '9' })}, true, ${gitlabId})
    `;
    await upgrade`
      INSERT INTO tenant_secrets (tenant_id, name, ciphertext, nonce, auth_tag)
      VALUES (${tenantId}, 'connector:gitlab', decode('dd', 'hex'), decode('ee', 'hex'), decode('ff', 'hex'))
    `;
    await upgrade`
      INSERT INTO gitlab_events
        (tenant_id, delivery_id, event_type, project_id, project_full_path, summary, occurred_at)
      VALUES (${tenantId}, 'gitlab-delivery-1', 'push', '51', 'acme/platform', '{}'::jsonb, now())
    `;
    await upgrade`
      INSERT INTO gitlab_projects
        (tenant_id, group_id, project_id, name, full_path, web_url)
      VALUES (${tenantId}, '9', '51', 'platform', 'acme/platform', 'https://gitlab.example.com/acme/platform')
    `;
    await upgrade`
      INSERT INTO deployments (tenant_id, source, repo, provider_id, sha, status, deployed_at)
      VALUES (${tenantId}, 'gitlab', 'acme/platform', 'gitlab-deployment-1', 'def456', 'success', now())
    `;

    await applyMigration(upgrade, '0016_romantic_doctor_faustus.sql');

    const [preserved] = await upgrade<
      Array<{
        name: string;
        secret_name: string;
        event_connector_id: string;
        repository_connector_id: string;
        deployment_connector_id: string;
      }>
    >`
      SELECT c.name, s.name AS secret_name,
             e.connector_id AS event_connector_id,
             r.connector_id AS repository_connector_id,
             d.connector_id AS deployment_connector_id
      FROM connector_configs c
      JOIN tenant_secrets s ON s.tenant_id = c.tenant_id
      JOIN github_events e ON e.tenant_id = c.tenant_id
      JOIN github_repositories r ON r.tenant_id = c.tenant_id
      JOIN deployments d ON d.tenant_id = c.tenant_id AND d.source = 'github'
      WHERE c.id = ${originalId}
    `;
    expect(preserved).toEqual({
      name: 'GitHub',
      secret_name: `connector:${originalId}`,
      event_connector_id: originalId,
      repository_connector_id: originalId,
      deployment_connector_id: originalId,
    });
    const [preservedGitLab] = await upgrade<
      Array<{
        name: string;
        secret_name: string;
        event_connector_id: string;
        project_connector_id: string;
        deployment_connector_id: string;
      }>
    >`
      SELECT c.name, s.name AS secret_name,
             e.connector_id AS event_connector_id,
             p.connector_id AS project_connector_id,
             d.connector_id AS deployment_connector_id
      FROM connector_configs c
      JOIN tenant_secrets s ON s.tenant_id = c.tenant_id AND s.name = 'connector:' || c.id::text
      JOIN gitlab_events e ON e.tenant_id = c.tenant_id
      JOIN gitlab_projects p ON p.tenant_id = c.tenant_id
      JOIN deployments d ON d.tenant_id = c.tenant_id AND d.source = 'gitlab'
      WHERE c.id = ${gitlabId}
    `;
    expect(preservedGitLab).toEqual({
      name: 'GitLab',
      secret_name: `connector:${gitlabId}`,
      event_connector_id: gitlabId,
      project_connector_id: gitlabId,
      deployment_connector_id: gitlabId,
    });

    await upgrade`
      INSERT INTO connector_configs (id, tenant_id, name, type, settings, enabled, webhook_key)
      VALUES (${secondId}, ${tenantId}, 'Security GitHub', 'github', '{}'::jsonb, true, ${secondId})
    `;
    await upgrade`
      INSERT INTO github_events
        (tenant_id, connector_id, delivery_id, event_type, repository_id, repository_full_name, summary, occurred_at)
      VALUES (${tenantId}, ${secondId}, 'delivery-1', 'push', '42', 'acme/api', '{}'::jsonb, now())
    `;
    await upgrade`
      INSERT INTO github_repositories
        (tenant_id, connector_id, installation_id, repository_id, owner, name, full_name, html_url)
      VALUES (${tenantId}, ${secondId}, '8', '42', 'acme', 'api', 'acme/api', 'https://github.com/acme/api')
    `;
    const counts = await upgrade<
      Array<{ connectors: number; events: number; repositories: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM connector_configs WHERE tenant_id = ${tenantId}) AS connectors,
        (SELECT count(*)::int FROM github_events WHERE tenant_id = ${tenantId}) AS events,
        (SELECT count(*)::int FROM github_repositories WHERE tenant_id = ${tenantId}) AS repositories
    `;
    expect(counts[0]).toEqual({
      connectors: 3,
      events: 2,
      repositories: 2,
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
