import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ConnectorRegistry, gitLabCredentialBundle, stubConnector } from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  gitlabHookAuthorizations,
  withTenant,
} from '@sre/db';
import { createFixture } from './connectors.fixture';
import { registerTestConnector } from './connector-registry';

const fixture = createFixture();

test.each(['retest', 'disconnect'] as const)(
  '%s locks the connector before credentials and management approval',
  async (action) => {
    const id = randomUUID();
    await withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
      await tx.insert(connectorConfigs).values({
        id,
        tenantId: fixture.tenantA,
        type: 'gitlab',
        name: id,
        enabled: true,
        lifecycleVersion: 1,
        settings: {
          baseUrl: 'https://gitlab.example.com',
          groupId: 7,
          groupPath: 'platform',
          eventStrategy: 'managed_projects',
          eventTransport: 'direct',
        },
      });
      await tx.insert(gitlabHookAuthorizations).values({
        tenantId: fixture.tenantA,
        connectorId: id,
        lifecycleVersion: 1,
        policyVersion: 1,
        approvedBy: randomUUID(),
      });
      await fixture.secrets.put(
        fixture.tenantA,
        connectorCredentialKey(id),
        gitLabCredentialBundle('fixture-read-token', { webhookSecret: 'fixture-hook-secret' }),
        tx,
      );
    });
    const registry = new ConnectorRegistry();
    registerTestConnector(registry, 'gitlab', (config) => ({
      ...stubConnector('gitlab', config),
      probe: async () => ({ status: 'healthy', authorized: true, reachable: true, warnings: [] }),
    }));
    const api = fixture.makeConnApp(undefined, undefined, undefined, {
      registry,
      discoverGroup: async () => ({
        group: {
          id: 7,
          name: 'Platform',
          fullPath: 'platform',
          webUrl: 'https://gitlab.example.com/platform',
        },
        projects: [],
      }),
    });
    let entered!: () => void;
    let proceed!: () => void;
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    // Hold the worker's first lock, then acquire its second while the real API request is waiting.
    const workerLocks = withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
      await tx.select().from(connectorConfigs).where(eq(connectorConfigs.id, id)).for('update');
      entered();
      await gate;
      await tx.execute(
        sql`select id from gitlab_hook_authorizations where connector_id = ${id} for update nowait`,
      );
    });
    await locked;
    const request = Promise.resolve(
      api.request(`/connectors/gitlab/${id}${action === 'retest' ? '/test' : ''}`, {
        method: action === 'retest' ? 'POST' : 'DELETE',
        headers: fixture.bearer(await fixture.sign(fixture.orgA)),
      }),
    );
    try {
      await vi.waitFor(async () => {
        const blocked = await fixture.admin.sql`
        select query from pg_stat_activity where datname = current_database()
        and wait_event_type = 'Lock' and query like '%connector_configs%'`;
        expect(blocked.length).toBeGreaterThan(0);
        expect(blocked.every((row) => /^select\b/i.test(row.query))).toBe(true);
      });
      proceed();
      await workerLocks;
      expect((await request).status).toBe(200);
    } finally {
      proceed();
      await Promise.allSettled([workerLocks, request]);
    }
  },
);
