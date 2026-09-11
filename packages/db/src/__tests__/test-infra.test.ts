import { describe, expect, test } from 'vitest';

describe('Vitest infrastructure isolation', () => {
  test('always runs against disposable Testcontainers instead of the development services', () => {
    expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
    expect(process.env.SRE_TEST_POSTGRES_CONTAINER_ID).toBeTruthy();
    expect(process.env.SRE_TEST_VALKEY_CONTAINER_ID).toBeTruthy();

    const admin = new URL(process.env.DATABASE_URL!);
    const app = new URL(process.env.APP_DATABASE_URL!);
    const valkey = new URL(process.env.VALKEY_URL!);

    expect(admin.host).toBe(app.host);
    expect(admin.port).not.toBe('45432');
    expect(valkey.port).not.toBe('46379');
  });
});
