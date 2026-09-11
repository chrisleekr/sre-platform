import { afterEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const createdDatabases: string[] = [];

const databaseUrl = (name: string): string => {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
};

async function applyMigrationFile(sql: Sql, filename: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${filename}`, 'utf8');
  for (const statement of source.split('--> statement-breakpoint')) {
    if (statement.trim()) await sql.unsafe(statement);
  }
}

afterEach(async () => {
  const base = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    for (const name of createdDatabases.splice(0)) {
      await base.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    }
  } finally {
    await base.end();
  }
});

describe('0011 incident lifecycle migration', () => {
  test('upgrades legacy incident states without inventing investigation conclusions', async () => {
    const name = `migration_0011_${randomUUID().replaceAll('-', '')}`;
    const base = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await base.unsafe(`CREATE DATABASE ${name}`);
      createdDatabases.push(name);
    } finally {
      await base.end();
    }

    const sql = postgres(databaseUrl(name), { max: 1 });
    try {
      await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
      const legacy = (await readdir(migrationsDir))
        .filter((filename) => /^(?:000\d|0010)_.*\.sql$/.test(filename))
        .sort();
      for (const filename of legacy) await applyMigrationFile(sql, filename);

      const tenantId = randomUUID();
      await sql`insert into tenants (id, name) values (${tenantId}, 'migration-0011')`;
      const fixtures = [
        { fingerprint: 'open-no-rca', status: 'open', rca: null },
        { fingerprint: 'investigating-no-rca', status: 'investigating', rca: null },
        { fingerprint: 'investigating-with-rca', status: 'investigating', rca: 'Known cause' },
        { fingerprint: 'degraded', status: 'degraded', rca: null },
        { fingerprint: 'resolved-no-rca', status: 'resolved', rca: null },
        { fingerprint: 'resolved-with-rca', status: 'resolved', rca: 'Known cause' },
        { fingerprint: 'closed', status: 'closed', rca: null },
        { fingerprint: 'closed-with-rca', status: 'closed', rca: 'Known cause' },
      ];
      for (const fixture of fixtures) {
        await sql`
            insert into incidents (
              tenant_id, fingerprint, alert_source, service, severity, status, rca_summary, updated_at
            ) values (
              ${tenantId}, ${fixture.fingerprint}, 'slack', 'checkout', 'sev2',
              ${fixture.status}, ${fixture.rca}, '2026-08-20T00:00:00.000Z'
            )
          `;
      }

      await applyMigrationFile(sql, '0011_open_skreet.sql');

      const rows = await sql<
        Array<{
          fingerprint: string;
          status: string;
          investigation_status: string;
          lifecycle_version: number;
          closed_at: Date | null;
        }>
      >`
          select fingerprint, status, investigation_status, lifecycle_version, closed_at
          from incidents
          where tenant_id = ${tenantId}
          order by fingerprint
        `;
      const byFingerprint = Object.fromEntries(rows.map((row) => [row.fingerprint, row]));
      expect(byFingerprint['investigating-no-rca']).toMatchObject({
        status: 'open',
        investigation_status: 'gathering',
        lifecycle_version: 0,
      });
      expect(byFingerprint['investigating-with-rca']).toMatchObject({
        status: 'open',
        investigation_status: 'assessed',
      });
      expect(byFingerprint.degraded).toMatchObject({
        status: 'open',
        investigation_status: 'degraded',
      });
      expect(byFingerprint['open-no-rca']).toMatchObject({
        status: 'open',
        investigation_status: 'queued',
        lifecycle_version: 0,
      });
      expect(byFingerprint['resolved-no-rca']).toMatchObject({
        status: 'resolved',
        investigation_status: 'queued',
      });
      expect(byFingerprint['resolved-with-rca']).toMatchObject({
        status: 'resolved',
        investigation_status: 'assessed',
      });
      expect(byFingerprint.closed).toMatchObject({
        status: 'closed',
        investigation_status: 'queued',
      });
      expect(byFingerprint.closed!.closed_at?.toISOString()).toBe('2026-08-20T00:00:00.000Z');
      expect(byFingerprint['closed-with-rca']).toMatchObject({
        status: 'closed',
        investigation_status: 'assessed',
      });
      expect(byFingerprint['closed-with-rca']!.closed_at?.toISOString()).toBe(
        '2026-08-20T00:00:00.000Z',
      );
    } finally {
      await sql.end();
    }
  }, 30_000);
});
