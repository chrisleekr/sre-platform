import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `identity_control_plane_${randomUUID().replaceAll('-', '')}`;
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
  await upgrade`create extension if not exists vector`;

  const historical = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name <= '0053_\uffff')
    .sort();
  for (const migration of historical) await applyMigration(upgrade, migration);
}, 60_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

describe('identity control-plane migration', () => {
  test('adds collision-free slugs and preserves populated membership ownership', async () => {
    const tenantA = '12345678-1111-4111-8111-111111111111';
    const tenantB = '12345678-2222-4222-8222-222222222222';
    const userA = randomUUID();
    const userB = randomUUID();
    await upgrade`
      insert into tenants (id, name) values
        (${tenantA}, 'Existing workspace A'),
        (${tenantB}, 'Existing workspace B')
    `;
    await upgrade`
      insert into users (id, issuer, subject) values
        (${userA}, 'https://legacy.example.invalid', 'user-a'),
        (${userB}, 'https://legacy.example.invalid', 'user-b')
    `;
    await upgrade`
      insert into memberships (user_id, tenant_id) values
        (${userA}, ${tenantA}),
        (${userB}, ${tenantB})
    `;

    const successors = (await readdir(migrationsDir))
      .filter((name) => /^0054_.+\.sql$/.test(name))
      .sort();
    expect(successors).toHaveLength(1);
    await applyMigration(upgrade, successors[0]!);

    const tenants = await upgrade<Array<{ id: string; slug: string; status: string }>>`
      select id, slug, status from tenants order by id
    `;
    expect(tenants).toEqual([
      { id: tenantA, slug: `workspace-${tenantA}`, status: 'active' },
      { id: tenantB, slug: `workspace-${tenantB}`, status: 'active' },
    ]);
    expect(new Set(tenants.map((tenant) => tenant.slug)).size).toBe(2);

    const memberships = await upgrade<
      Array<{ user_id: string; tenant_id: string; role: string; status: string }>
    >`
      select user_id, tenant_id, role, status from memberships order by user_id
    `;
    expect(memberships).toEqual(
      [
        { user_id: userA, tenant_id: tenantA, role: 'member', status: 'active' },
        { user_id: userB, tenant_id: tenantB, role: 'member', status: 'active' },
      ].sort((left, right) => left.user_id.localeCompare(right.user_id)),
    );
  }, 30_000);
});
