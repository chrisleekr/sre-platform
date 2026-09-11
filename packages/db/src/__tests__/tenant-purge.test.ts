import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  identityProviderDomains,
  identityProviders,
  incidents,
  incidentMessages,
  cancelWorkspaceDeletion,
  jobs,
  makeDb,
  memberships,
  notifications,
  purgeWorkspaceIfDue,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
} from '../index';

let admin: DbHandle;

beforeAll(() => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
});

afterAll(async () => {
  await admin?.close();
});

describe('workspace purge', () => {
  test('cascades every declared tenant foreign key and removes non-FK queue rows', async () => {
    const tenantId = randomUUID();
    const providerId = randomUUID();
    const userId = randomUUID();
    const issuer = `https://purge-${tenantId}.invalid`;
    await admin.db.insert(tenants).values({
      id: tenantId,
      name: 'Purge workspace',
      slug: `purge-${tenantId}`,
      status: 'deleting',
      deleteAfter: new Date(Date.now() - 1_000),
    });
    await admin.db.insert(identityProviders).values({
      id: providerId,
      displayName: 'Purge directory',
      issuer,
      jwksUri: `${issuer}/jwks`,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      browserClientId: 'purge-client',
      audience: 'purge-api',
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
    });
    await admin.db.insert(identityProviderDomains).values({
      providerId,
      domain: `${tenantId}.example.test`,
      status: 'verified',
    });
    await admin.db
      .insert(tenantIdentityBindings)
      .values({ tenantId, providerId, claimValue: null });
    await admin.db.insert(users).values({
      id: userId,
      issuer,
      subject: 'purge-owner',
      email: `owner@${tenantId}.example.test`,
    });
    await admin.db.insert(memberships).values({ tenantId, userId, role: 'owner' });
    await admin.db.insert(notifications).values({
      tenantId,
      recipientUserId: userId,
      kind: 'purge.test',
    });
    await admin.db.insert(jobs).values({
      tenantId,
      type: 'purge-test-work',
      payload: {},
      stream: 'purge-test',
    });
    const [incident] = await admin.db
      .insert(incidents)
      .values({
        tenantId,
        fingerprint: `purge-${tenantId}`,
        alertSource: 'manual',
        service: 'example',
        severity: 'sev3',
      })
      .returning();
    await admin.db.insert(incidentMessages).values({
      tenantId,
      incidentId: incident!.id,
      author: 'human',
      authorUserId: userId,
      content: 'Purge this conversation with its workspace.',
    });

    const tenantTables = await admin.sql<Array<{ table_name: string; cascade: boolean }>>`
      select child.relname as table_name,
        bool_and(cst.confdeltype = 'c') as cascade
      from pg_catalog.pg_constraint cst
      join pg_catalog.pg_class parent on parent.oid = cst.confrelid
      join pg_catalog.pg_class child on child.oid = cst.conrelid
      join pg_catalog.pg_attribute attribute
        on attribute.attrelid = child.oid and attribute.attnum = any(cst.conkey)
      where cst.contype = 'f'
        and parent.relname = 'tenants'
        and attribute.attname = 'tenant_id'
      group by child.relname
      order by child.relname
    `;
    expect(tenantTables.length).toBeGreaterThan(40);
    expect(tenantTables.every((table) => table.cascade)).toBe(true);

    const allTenantTables = await admin.sql<Array<{ table_name: string }>>`
      select table_name
      from information_schema.columns
      where table_schema = 'public' and column_name = 'tenant_id'
      order by table_name
    `;
    const beforeCounts: Array<{ table: string; count: number }> = [];
    for (const { table_name: table } of allTenantTables) {
      const [row] = await admin.sql.unsafe<Array<{ count: string }>>(
        `select count(*)::text as count from "${table.replaceAll('"', '""')}" where tenant_id = $1`,
        [tenantId],
      );
      beforeCounts.push({ table, count: Number(row?.count ?? 0) });
    }
    expect(beforeCounts.filter((row) => row.count > 0).length).toBeGreaterThanOrEqual(6);
    expect(await purgeWorkspaceIfDue(admin.db, tenantId)).toBe('purged');
    const remaining: Array<{ table: string; count: number }> = [];
    for (const { table_name: table } of allTenantTables) {
      const [row] = await admin.sql.unsafe<Array<{ count: string }>>(
        `select count(*)::text as count from "${table.replaceAll('"', '""')}" where tenant_id = $1`,
        [tenantId],
      );
      remaining.push({ table, count: Number(row?.count ?? 0) });
    }
    expect(remaining.filter((row) => row.count !== 0)).toEqual([]);
    expect(
      await admin.db.select().from(identityProviders).where(eq(identityProviders.id, providerId)),
    ).toEqual([]);
    expect(
      await admin.db
        .select()
        .from(identityProviderDomains)
        .where(eq(identityProviderDomains.providerId, providerId)),
    ).toEqual([]);
    await admin.db.delete(users).where(eq(users.id, userId));
  });

  test('does not purge an active workspace or one whose grace period has not elapsed', async () => {
    const activeId = randomUUID();
    const futureId = randomUUID();
    await admin.db.insert(tenants).values([
      { id: activeId, name: 'Active', slug: `active-${activeId}` },
      {
        id: futureId,
        name: 'Future',
        slug: `future-${futureId}`,
        status: 'deleting',
        deleteAfter: new Date(Date.now() + 60_000),
      },
    ]);
    try {
      expect(await purgeWorkspaceIfDue(admin.db, activeId)).toBe('not_due');
      expect(await purgeWorkspaceIfDue(admin.db, futureId)).toBe('not_due');
      await cancelWorkspaceDeletion(admin.db, futureId);
      expect(await purgeWorkspaceIfDue(admin.db, futureId, new Date(Date.now() + 120_000))).toBe(
        'not_due',
      );
    } finally {
      await admin.db.delete(tenants).where(eq(tenants.id, activeId));
      await admin.db.delete(tenants).where(eq(tenants.id, futureId));
    }
  });
});
