import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, expect, test } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const databaseName = `incident_title_${randomUUID().replaceAll('-', '')}`;
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
  const controlUrl = new URL(process.env.DATABASE_URL!);
  controlUrl.pathname = '/postgres';
  control = postgres(controlUrl.toString(), { max: 1 });
  await control.unsafe(`CREATE DATABASE "${databaseName}"`);

  const upgradeUrl = new URL(process.env.DATABASE_URL!);
  upgradeUrl.pathname = `/${databaseName}`;
  upgrade = postgres(upgradeUrl.toString(), { max: 1 });
  await upgrade`CREATE EXTENSION IF NOT EXISTS vector`;
  const historicalMigrations = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < '0039_')
    .sort();
  for (const migration of historicalMigrations) await applyMigration(upgrade, migration);
}, 30_000);

afterAll(async () => {
  if (upgrade) await upgrade.end({ timeout: 5 });
  if (control) {
    await control.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await control.end({ timeout: 5 });
  }
});

test('0039 repairs missing incident titles from the earliest normalized signal name', async () => {
  const tenantId = randomUUID();
  const repairedId = randomUUID();
  const preservedId = randomUUID();
  const untitledId = randomUUID();
  const secretId = randomUUID();
  const gitlabToken = 'glpat-ABCDEF1234567890abcd';
  const highEntropyToken = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2';
  const scrubFixtures = [
    { input: 'AWS AKIAIOSFODNN7EXAMPLE', expected: 'AWS [REDACTED]' },
    { input: 'Authorization: Bearer abc.def.ghi123XYZ', expected: 'Authorization: [REDACTED]' },
    {
      input: 'Authorization: Bearer\u00a0abc.def.ghi123XYZ',
      expected: 'Authorization: [REDACTED]',
    },
    {
      input: 'OpenAI sk-abcdefghijklmnopqrstuvwx1234',
      expected: 'OpenAI [REDACTED]',
    },
    {
      input: 'GitHub ghp_abcdefghijklmnopqrstuvwxyz123456',
      expected: 'GitHub [REDACTED]',
    },
    { input: 'GitLab glpat-ABCDEF1234567890abcd', expected: 'GitLab [REDACTED]' },
    { input: 'Slack xoxb-1234567890-ABCDEFGHIJK', expected: 'Slack [REDACTED]' },
    {
      input: 'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_123',
      expected: 'JWT [REDACTED]',
    },
    {
      input: 'Entropy Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2',
      expected: 'Entropy [REDACTED]',
    },
    {
      input: `Mixed ${highEntropyToken} and _${highEntropyToken}`,
      expected: `Mixed [REDACTED] and _${highEntropyToken}`,
    },
    {
      input: 'Order 00000000-0000-0000-0000-000000000000',
      expected: 'Order 00000000-0000-0000-0000-000000000000',
    },
    {
      input: 'Commit abcdef0123456789abcdef0123456789abcdef01',
      expected: 'Commit abcdef0123456789abcdef0123456789abcdef01',
    },
    {
      input: 'Image flask-abcdefghijklmnopqrstuvwx1234',
      expected: 'Image flask-abcdefghijklmnopqrstuvwx1234',
    },
    {
      input: 'Metric _Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2',
      expected: 'Metric _Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2',
    },
    {
      input: 'Unicode églpat-ABCDEF1234567890abcd',
      expected: 'Unicode é[REDACTED]',
    },
    {
      input: 'Unicode éAb1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2é',
      expected: 'Unicode é[REDACTED]é',
    },
    { input: 'Checkout latency is high', expected: 'Checkout latency is high' },
  ].map((fixture) => ({ ...fixture, id: randomUUID() }));
  await upgrade`INSERT INTO tenants (id, name) VALUES (${tenantId}, 'incident title migration')`;
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity, title)
    VALUES
      (${repairedId}, ${tenantId}, ${`repair-${repairedId}`}, 'slack', 'slack:C-alerts', 'sev3', null),
      (${preservedId}, ${tenantId}, ${`preserve-${preservedId}`}, 'slack', 'checkout', 'sev2', 'Existing incident title'),
      (${untitledId}, ${tenantId}, ${`untitled-${untitledId}`}, 'manual', 'payments', 'sev3', null),
      (${secretId}, ${tenantId}, ${`secret-${secretId}`}, 'slack', 'slack:C-secret', 'sev3', null)
  `;
  await upgrade`
    INSERT INTO incident_signals
      (tenant_id, incident_id, surface, channel, external_message_id, state,
       last_event_type, summary, content_hash, last_event_key, last_event_at,
       first_seen_at, alert_name)
    VALUES
      (${tenantId}, ${repairedId}, 'slack', 'C-alerts', 'root#1', 'resolved',
       'resolved', 'Later signal', 'later-content', 'later-event',
       '2026-09-01T00:05:00.000Z', '2026-09-01T00:05:00.000Z', 'Later alert'),
      (${tenantId}, ${repairedId}, 'slack', 'C-alerts', 'root#0', 'resolved',
       'resolved', 'Original signal', 'original-content', 'original-event',
       '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '  Pod is crash looping.  '),
      (${tenantId}, ${preservedId}, 'slack', 'C-alerts', 'preserved#0', 'firing',
       'opened', 'Replacement signal', 'replacement-content', 'replacement-event',
       '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'Replacement title'),
      (${tenantId}, ${secretId}, 'slack', 'C-secret', 'secret#0', 'firing',
       'opened', 'Secret-bearing signal', 'secret-content', 'secret-event',
       '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
       ${`Pod ${gitlabToken} exposed ${highEntropyToken}`})
  `;
  for (const fixture of scrubFixtures) {
    await upgrade`
      INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity, title)
      VALUES (${fixture.id}, ${tenantId}, ${`scrub-${fixture.id}`}, 'slack', 'slack:C-scrub', 'sev3', null)
    `;
    await upgrade`
      INSERT INTO incident_signals
        (tenant_id, incident_id, surface, channel, external_message_id, state,
         last_event_type, summary, content_hash, last_event_key, last_event_at,
         first_seen_at, alert_name)
      VALUES
        (${tenantId}, ${fixture.id}, 'slack', 'C-scrub', ${`scrub-${fixture.id}`}, 'firing',
         'opened', 'Scrub fixture', ${`content-${fixture.id}`}, ${`event-${fixture.id}`},
         '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ${fixture.input})
    `;
  }

  await applyMigration(upgrade, '0039_backfill_incident_titles.sql');

  const [icuScrub] = await upgrade<Array<{ scrubbed: string }>>`
    SELECT sre_scrub_legacy_incident_text(
      ${'Unicode églpat-ABCDEF1234567890abcd'} COLLATE "und-x-icu"
    ) AS scrubbed
  `;
  expect(icuScrub?.scrubbed).toBe('Unicode é[REDACTED]');

  const rows = await upgrade<Array<{ id: string; title: string | null }>>`
    SELECT id, title
    FROM incidents
    WHERE id IN (${repairedId}, ${preservedId}, ${untitledId}, ${secretId})
    ORDER BY id
  `;
  expect(Object.fromEntries(rows.map((row) => [row.id, row.title]))).toEqual({
    [preservedId]: 'Existing incident title',
    [repairedId]: 'Pod is crash looping.',
    [secretId]: 'Pod [REDACTED] exposed [REDACTED]',
    [untitledId]: null,
  });
  const [secretSignal] = await upgrade<Array<{ alert_name: string }>>`
    SELECT alert_name
    FROM incident_signals
    WHERE incident_id = ${secretId}
  `;
  expect(secretSignal?.alert_name).toBe('Pod [REDACTED] exposed [REDACTED]');
  const scrubbedFixtures = await upgrade<
    Array<{ id: string; title: string | null; alert_name: string | null }>
  >`
    SELECT incident.id, incident.title, signal.alert_name
    FROM incidents AS incident
    JOIN incident_signals AS signal
      ON signal.tenant_id = incident.tenant_id AND signal.incident_id = incident.id
    WHERE incident.id IN ${upgrade(scrubFixtures.map((fixture) => fixture.id))}
  `;
  expect(
    Object.fromEntries(scrubbedFixtures.map((row) => [row.id, [row.title, row.alert_name]])),
  ).toEqual(
    Object.fromEntries(
      scrubFixtures.map((fixture) => [fixture.id, [fixture.expected, fixture.expected]]),
    ),
  );

  await upgrade`
    UPDATE incident_signals
    SET alert_name = ${`Bearer legacy-token.${gitlabToken}`}
    WHERE incident_id = ${secretId}
  `;
  await upgrade`
    UPDATE incidents
    SET title = ${`Bearer legacy-token.${gitlabToken}`}
    WHERE id = ${secretId}
  `;
  for (const fixture of scrubFixtures) {
    await upgrade`
      UPDATE incident_signals SET alert_name = ${fixture.input} WHERE incident_id = ${fixture.id}
    `;
    await upgrade`
      UPDATE incidents SET title = ${fixture.input} WHERE id = ${fixture.id}
    `;
  }
  const lateIncidentId = randomUUID();
  await upgrade`
    INSERT INTO incidents (id, tenant_id, fingerprint, alert_source, service, severity, title)
    VALUES (${lateIncidentId}, ${tenantId}, ${`late-${lateIncidentId}`}, 'slack', 'slack:C-late', 'sev3', null)
  `;
  await upgrade`
    INSERT INTO incident_signals
      (tenant_id, incident_id, surface, channel, external_message_id, state,
       last_event_type, summary, content_hash, last_event_key, last_event_at,
       first_seen_at, alert_name)
    VALUES
      (${tenantId}, ${lateIncidentId}, 'slack', 'C-late', 'late#0', 'firing',
       'opened', 'Late signal', 'late-content', 'late-event',
       '2026-09-01T00:10:00.000Z', '2026-09-01T00:10:00.000Z', 'Late normalized alert')
  `;
  await applyMigration(upgrade, '0041_scrub_legacy_incident_titles.sql');
  const [repairedDrift] = await upgrade<Array<{ title: string; alert_name: string }>>`
    SELECT incident.title, signal.alert_name
    FROM incidents AS incident
    JOIN incident_signals AS signal
      ON signal.tenant_id = incident.tenant_id AND signal.incident_id = incident.id
    WHERE incident.id = ${secretId}
  `;
  expect(repairedDrift).toEqual({ title: '[REDACTED]', alert_name: '[REDACTED]' });
  const repairedFixtures = await upgrade<
    Array<{ id: string; title: string | null; alert_name: string | null }>
  >`
    SELECT incident.id, incident.title, signal.alert_name
    FROM incidents AS incident
    JOIN incident_signals AS signal
      ON signal.tenant_id = incident.tenant_id AND signal.incident_id = incident.id
    WHERE incident.id IN ${upgrade(scrubFixtures.map((fixture) => fixture.id))}
  `;
  expect(
    Object.fromEntries(repairedFixtures.map((row) => [row.id, [row.title, row.alert_name]])),
  ).toEqual(
    Object.fromEntries(
      scrubFixtures.map((fixture) => [fixture.id, [fixture.expected, fixture.expected]]),
    ),
  );
  const [lateIncident] = await upgrade<Array<{ title: string | null }>>`
    SELECT title FROM incidents WHERE id = ${lateIncidentId}
  `;
  expect(lateIncident?.title).toBe('Late normalized alert');
  const [scrubFunction] = await upgrade<Array<{ function_name: string | null }>>`
    SELECT to_regprocedure('sre_scrub_legacy_incident_text(text)')::text AS function_name
  `;
  expect(scrubFunction?.function_name).toBeNull();
});
