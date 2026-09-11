import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { withTenant } from '../index';

import { createFixture } from './schema-ddl.fixture';

const __fixture = createFixture();

describe('terminal investigation-run immutability', () => {
  test('prevents the application role from rewriting or deleting a completed run', async () => {
    const tenantId = randomUUID();
    const incidentId = randomUUID();
    const runId = randomUUID();
    const pendingRunId = randomUUID();
    try {
      await __fixture.admin.db.execute(
        sql`insert into tenants (id, name) values (${tenantId}, 'immutable run test')`,
      );
      await __fixture.admin.db.execute(sql`
        insert into incidents (id, tenant_id, fingerprint, alert_source, service, severity)
        values (${incidentId}, ${tenantId}, ${`immutable-${incidentId}`}, 'test', 'api', 'sev3')
      `);
      await __fixture.admin.db.execute(sql`
        insert into investigation_runs
          (id, tenant_id, incident_id, operation, outcome, result, completed_at)
        values
          (${runId}, ${tenantId}, ${incidentId}, 'investigate', 'conclusive',
           ${JSON.stringify({ summary: 'trusted' })}::jsonb, now())
      `);
      await __fixture.admin.db.execute(sql`
        insert into investigation_runs (id, tenant_id, incident_id, operation)
        values (${pendingRunId}, ${tenantId}, ${incidentId}, 'investigate')
      `);

      await expect(
        withTenant(__fixture.app.db, tenantId, (tx) =>
          tx.execute(sql`
            update investigation_runs
            set outcome = 'failed', result = ${JSON.stringify({ summary: 'rewritten' })}::jsonb
            where id = ${runId}
          `),
        ),
      ).rejects.toMatchObject({ cause: { code: '55000' } });
      await expect(
        withTenant(__fixture.app.db, tenantId, (tx) =>
          tx.execute(sql`delete from investigation_runs where id = ${runId}`),
        ),
      ).rejects.toMatchObject({ cause: { code: '55000' } });
      await expect(
        withTenant(__fixture.app.db, tenantId, (tx) =>
          tx.execute(sql`
            update investigation_runs
            set operation = 'resume'
            where id = ${pendingRunId}
          `),
        ),
      ).rejects.toMatchObject({ cause: { code: '55000' } });
      await expect(
        withTenant(__fixture.app.db, tenantId, (tx) =>
          tx.execute(sql`
            update investigation_runs
            set outcome = 'inconclusive',
                result = ${JSON.stringify({ summary: 'completed normally' })}::jsonb,
                completed_at = now()
            where id = ${pendingRunId}
          `),
        ),
      ).resolves.toBeDefined();
      const [completedPending] = (await __fixture.admin.db.execute(sql`
        select outcome, completed_at as "completedAt"
        from investigation_runs
        where id = ${pendingRunId}
      `)) as unknown as Array<{ outcome: string; completedAt: Date | string | null }>;
      expect({
        ...completedPending,
        completedAt: completedPending?.completedAt
          ? completedPending.completedAt instanceof Date
            ? completedPending.completedAt
            : new Date(completedPending.completedAt)
          : null,
      }).toMatchObject({
        outcome: 'inconclusive',
        completedAt: expect.any(Date),
      });
    } finally {
      await __fixture.admin.db.execute(
        sql`delete from investigation_runs where id in (${runId}, ${pendingRunId})`,
      );
      await __fixture.admin.db.execute(sql`delete from incidents where id = ${incidentId}`);
      await __fixture.admin.db.execute(sql`delete from tenants where id = ${tenantId}`);
    }
  });
});
