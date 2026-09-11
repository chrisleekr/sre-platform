import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { runMigrations } from './packages/db/src/migrate';

// Keep tests hermetic: boot ephemeral Postgres (+pgvector) and Valkey via
// Testcontainers, then apply schema + RLS once. Random host ports, no shared/compose DB, no port
// config to keep in sync. Images match CI/compose for parity. Always replace inherited URLs: Bun
// auto-loads .env, so treating an existing DATABASE_URL as an explicit test override points local
// tests at the running development database.
//
// runMigrations must run once here, not per test file: concurrent CREATE TABLE on a fresh DB races.
// Workers spawn after this returns and inherit the process.env we set below.

let pg: StartedPostgreSqlContainer | undefined;
let valkey: StartedTestContainer | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  try {
    pg = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('sre_platform')
      .withUsername('sre')
      .withPassword('sre')
      .start();
    const uri = pg.getConnectionUri(); // postgresql://sre:sre@host:port/sre_platform
    process.env.NODE_ENV = 'test';
    process.env.APP_DB_PASSWORD = 'app';
    process.env.DATABASE_URL = uri;
    // The app role (app_user) is provisioned by runMigrations; its DSN is the same host/db with
    // swapped test-only credentials.
    const { host } = new URL(uri);
    process.env.APP_DATABASE_URL = `postgres://app_user:app@${host}/sre_platform`;

    valkey = await new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    process.env.VALKEY_URL = `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`;
    process.env.SRE_TEST_INFRA = 'testcontainers';
    process.env.SRE_TEST_POSTGRES_CONTAINER_ID = pg.getId();
    process.env.SRE_TEST_VALKEY_CONTAINER_ID = valkey.getId();

    await runMigrations(uri);
  } catch (error) {
    await Promise.allSettled([pg?.stop(), valkey?.stop()]);
    throw error;
  }

  return async () => {
    await Promise.all([pg!.stop(), valkey!.stop()]);
  };
}
