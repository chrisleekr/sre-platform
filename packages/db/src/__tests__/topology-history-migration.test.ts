import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres, { type Sql } from 'postgres';

const databaseName = `topology_upgrade_${randomUUID().replaceAll('-', '')}`;
const owner = `topology_owner_${randomUUID().replaceAll('-', '')}`;
let control: Sql;
let upgrade: Sql;
const tenantIds = [randomUUID(), randomUUID()];
beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/postgres';
  control = postgres(url.toString(), { max: 1 });
  await control.unsafe(`CREATE ROLE "${owner}" NOLOGIN NOBYPASSRLS`);
  await control.unsafe(`CREATE DATABASE "${databaseName}" OWNER "${owner}"`);
  url.pathname = `/${databaseName}`;
  upgrade = postgres(url.toString(), { max: 1 });
  await upgrade.unsafe(`SET ROLE "${owner}"`);
  await upgrade`CREATE TABLE tenants (id uuid PRIMARY KEY)`;
  await upgrade`CREATE TABLE services (tenant_id uuid, name text, team text)`;
  await upgrade`CREATE TABLE service_dependencies (
    tenant_id uuid NOT NULL, upstream text NOT NULL, downstream text NOT NULL,
    sync_type text NOT NULL DEFAULT 'sync', circuit_breaker boolean NOT NULL DEFAULT false,
    protocol text, CONSTRAINT service_deps_edge_uq UNIQUE (tenant_id, upstream, downstream))`;
  await upgrade`ALTER TABLE service_dependencies ENABLE ROW LEVEL SECURITY`;
  await upgrade`ALTER TABLE service_dependencies FORCE ROW LEVEL SECURITY`;
  await upgrade.unsafe(`CREATE POLICY tenant_isolation ON service_dependencies FOR ALL
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
  for (const id of tenantIds) {
    await upgrade`INSERT INTO tenants VALUES (${id})`;
    await upgrade`INSERT INTO services VALUES (${id}, 'checkout', 'payments'), (${id}, 'orders', 'core')`;
    await upgrade`SELECT set_config('app.tenant_id', ${id}, false)`;
    await upgrade`INSERT INTO service_dependencies (tenant_id, upstream, downstream, protocol) VALUES (${id}, 'checkout', 'orders', 'HTTPS')`;
  }
  await upgrade`SELECT set_config('app.tenant_id', '', false)`;
});
afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.unsafe(`DROP ROLE IF EXISTS "${owner}"`);
    await control.end({ timeout: 5 });
  }
});

test('populated upgrade preserves both tenants under forced RLS without inventing prior confirmation', async () => {
  expect(await upgrade`SELECT * FROM service_dependencies`).toHaveLength(0);
  const before = (await upgrade`SELECT clock_timestamp() AS at`)[0]!.at as Date;
  const migration = await readFile(
    new URL('../../migrations/0079_ambiguous_betty_ross.sql', import.meta.url),
    'utf8',
  );
  await upgrade.begin(async (tx) => {
    for (const statement of migration.split('--> statement-breakpoint'))
      if (statement.trim()) await tx.unsafe(statement);
  });
  await upgrade`ALTER TABLE service_dependency_history FORCE ROW LEVEL SECURITY`;
  expect(await upgrade`SELECT * FROM service_dependencies`).toHaveLength(0);
  expect(await upgrade`SELECT * FROM service_dependency_history`).toHaveLength(0);
  for (const id of tenantIds) {
    await upgrade`SELECT set_config('app.tenant_id', ${id}, false)`;
    const rows = await upgrade`SELECT * FROM service_dependency_history`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: id,
      upstream: 'checkout',
      downstream: 'orders',
      environment: '',
      valid_until: null,
      declaration: {
        syncType: 'sync',
        circuitBreaker: false,
        protocol: 'HTTPS',
        rationale: null,
        confirmedByUserId: null,
        lastConfirmedAt: null,
      },
    });
    expect((rows[0]!.valid_from as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(await upgrade`SELECT * FROM service_dependencies`).toHaveLength(1);
    expect(
      (await upgrade`SELECT team FROM services WHERE tenant_id = ${id} AND name = 'checkout'`)[0]!
        .team,
    ).toBe('payments');
  }
});
