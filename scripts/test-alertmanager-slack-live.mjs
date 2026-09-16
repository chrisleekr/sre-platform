import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectorConfigs,
  connectorEventCredentialKey,
  grantPlatformOperator,
  makeDb,
  makeSecretStore,
  runMigrations,
  surfaceBotTokenKey,
  tenants,
  upsertSurfaceConfig,
  withTenant,
} from '../packages/db/src/index.ts';
import { seedMembership } from '../packages/db/src/test-support.ts';
import { alertmanagerEventCredential } from '../packages/connectors/src/index.ts';
import { LOCAL_ISSUER } from '../apps/api/src/local-auth.ts';
import { runScenario } from './alertmanager-slack-live/scenario.mjs';
import { removeContainerChecked, settleOrThrow } from './alertmanager-slack-live/cleanup.mjs';

const timeoutMs = Number(process.env.ALERTMANAGER_E2E_TIMEOUT_MS || 600_000);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const alertmanagerImage =
  'ghcr.io/prometheus/alertmanager:v0.34.0@sha256:690c7b525f4367aa91f73e2f91c632206d32e97c6384bdbf2fb7a861b420340d';
const postgresImage = 'pgvector/pgvector:pg16';
const valkeyImage = 'valkey/valkey:9';
const activeContainers = new Set();
const activeProcesses = new Set();
const activeDirectories = new Set();

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const slackBotToken = required(process.env.SLACK_E2E_BOT_TOKEN, 'SLACK_E2E_BOT_TOKEN');
const slackChannel = required(process.env.SLACK_E2E_CHANNEL, 'SLACK_E2E_CHANNEL');
if (!Number.isFinite(timeoutMs) || timeoutMs < 60_000)
  throw new Error('ALERTMANAGER_E2E_TIMEOUT_MS must be at least 60000');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function jsonRequest(url, init, expected, label) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (!expected.includes(response.status))
    throw new Error(`${label} returned HTTP ${response.status}`);
  return { response, body };
}

async function eventually(label, check) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(2_000);
  }
  throw new Error(`${label} did not converge${lastError ? ` (${lastError.message})` : ''}`);
}

async function command(args) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  activeProcesses.add(child);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => activeProcesses.delete(child));
  if (exitCode !== 0)
    throw new Error(`${args[0]} ${args[1] || ''} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  return stdout.trim();
}

async function removeContainer(name) {
  await removeContainerChecked(command, name);
  activeContainers.delete(name);
}

async function removeContainers(names) {
  await settleOrThrow(
    names.map(removeContainer),
    'one or more ephemeral containers remain after cleanup',
  );
}

async function mappedPort(name, containerPort) {
  const published = await command(['docker', 'port', name, `${containerPort}/tcp`]);
  const match = published.match(/127\.0\.0\.1:(\d+)/);
  if (!match) throw new Error(`Docker did not publish ${name}:${containerPort} on loopback`);
  return Number(match[1]);
}

async function waitForHealthyContainer(name) {
  await eventually(`${name} readiness`, async () => {
    const status = await command([
      'docker',
      'inspect',
      '--format',
      '{{.State.Health.Status}}',
      name,
    ]).catch(() => null);
    return status === 'healthy' ? true : null;
  });
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to allocate an API port');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stopProcess(child) {
  if (child.exitCode !== null) {
    activeProcesses.delete(child);
    return;
  }
  child.kill(15);
  await Promise.race([child.exited, sleep(5_000)]);
  if (child.exitCode === null) {
    child.kill(9);
    await child.exited;
  }
  activeProcesses.delete(child);
}

let signalCleanupStarted = false;

async function cleanupActiveResources() {
  await settleOrThrow(
    [
      settleOrThrow([...activeProcesses].map(stopProcess), 'one or more processes did not stop'),
      removeContainers([...activeContainers]),
      settleOrThrow(
        [...activeDirectories].map(async (directory) => {
          await rm(directory, { recursive: true, force: true });
          activeDirectories.delete(directory);
        }),
        'one or more temporary directories remain',
      ),
    ],
    'one or more tracked resources remain after cleanup',
  );
}

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  process.once(signal, () => {
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    void cleanupActiveResources().finally(() => process.exit(exitCode));
  });

async function startIsolatedPlatform(runId) {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const postgresName = `sre-platform-e2e-postgres-${safeRunId}`;
  const valkeyName = `sre-platform-e2e-valkey-${safeRunId}`;
  let adminDb;
  let appDb;
  const children = [];
  try {
    activeContainers.add(postgresName);
    await command([
      'docker',
      'run',
      '--detach',
      '--name',
      postgresName,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_DB=sre_platform',
      '--env',
      'POSTGRES_USER=sre',
      '--env',
      'POSTGRES_PASSWORD=sre',
      '--health-cmd',
      'pg_isready -U sre -d sre_platform',
      '--health-interval',
      '1s',
      '--health-timeout',
      '5s',
      '--health-retries',
      '30',
      postgresImage,
    ]);
    await waitForHealthyContainer(postgresName);

    activeContainers.add(valkeyName);
    await command([
      'docker',
      'run',
      '--detach',
      '--name',
      valkeyName,
      '--publish',
      '127.0.0.1::6379',
      '--health-cmd',
      'valkey-cli ping',
      '--health-interval',
      '1s',
      '--health-timeout',
      '5s',
      '--health-retries',
      '30',
      valkeyImage,
    ]);
    await waitForHealthyContainer(valkeyName);

    const postgresPort = await mappedPort(postgresName, 5432);
    const valkeyPort = await mappedPort(valkeyName, 6379);
    const adminUrl = `postgresql://sre:sre@127.0.0.1:${postgresPort}/sre_platform`;
    const { host } = new URL(adminUrl);
    const appUrl = `postgres://app_user:app@${host}/sre_platform`;
    const valkeyUrl = `redis://127.0.0.1:${valkeyPort}`;
    process.env.NODE_ENV = 'test';
    process.env.APP_DB_PASSWORD = 'app';
    await runMigrations(adminUrl);

    adminDb = makeDb(adminUrl);
    appDb = makeDb(appUrl);
    const localEmail = `alertmanager-e2e-${runId}@example.test`;
    const localPassword = randomBytes(24).toString('base64url');
    const masterKey = randomBytes(32).toString('base64');
    const eventToken = randomBytes(32).toString('base64url');
    const webhookKey = randomUUID();
    const apiPort = await availablePort();
    const tenantId = randomUUID();
    await adminDb.db.insert(tenants).values({
      id: tenantId,
      name: `Alertmanager lifecycle E2E ${runId}`,
      slug: `alertmanager-e2e-${runId}`,
    });
    const userId = await seedMembership(
      adminDb.db,
      { issuer: LOCAL_ISSUER, subject: localEmail, email: localEmail },
      tenantId,
    );
    await grantPlatformOperator(adminDb.db, userId);
    await upsertSurfaceConfig(appDb.db, tenantId, { surface: 'slack' });
    const secrets = makeSecretStore(appDb.db, masterKey);
    await secrets.put(tenantId, surfaceBotTokenKey('slack'), slackBotToken);
    const connectorId = randomUUID();
    await withTenant(appDb.db, tenantId, (tx) =>
      tx.insert(connectorConfigs).values({
        id: connectorId,
        tenantId,
        name: 'Isolated Alertmanager E2E',
        type: 'prometheus',
        webhookKey,
        settings: {
          baseUrl: 'http://prometheus.invalid',
          authType: 'none',
          eventTransport: 'direct',
          alertChannel: slackChannel,
          // Keep the causal acceptance window short while remaining above the connector minimum.
          cohortWindowSec: 60,
        },
        enabled: true,
        verificationAttemptedAt: new Date(),
        verificationSucceededAt: new Date(),
      }),
    );
    await secrets.put(
      tenantId,
      connectorEventCredentialKey(connectorId),
      alertmanagerEventCredential(eventToken),
    );

    const childEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: adminUrl,
      APP_DATABASE_URL: appUrl,
      APP_DB_PASSWORD: 'app',
      VALKEY_URL: valkeyUrl,
      PORT: String(apiPort),
      CORS_ORIGINS: `http://127.0.0.1:${apiPort}`,
      DASHBOARD_BASE_URL: `http://127.0.0.1:${apiPort}`,
      SECRETS_MASTER_KEY: masterKey,
      LLM_PROVIDER: 'fake',
      EMBEDDINGS_URL: 'http://127.0.0.1:1',
      EMBEDDINGS_MODEL: 'BAAI/bge-large-en-v1.5',
      EMBEDDINGS_DIM: '1024',
      AUTH0_ISSUER: 'https://invalid.example/',
      AUTH0_AUDIENCE: 'https://api.sre-platform.test/',
      AUTH0_JWKS_URI: 'https://invalid.example/.well-known/jwks.json',
      ALLOW_LOCAL_PASSWORD_LOGIN: 'true',
      LOCAL_LOGIN_EMAIL: localEmail,
      LOCAL_LOGIN_PASSWORD: localPassword,
    };
    delete childEnv.ALLOW_SUPERUSER_APP_DB;
    for (const entrypoint of [
      'apps/api/src/index.ts',
      'apps/surface-worker/src/index.ts',
      'apps/triage-worker/checks/fake-alertmanager-worker.ts',
    ]) {
      const child = Bun.spawn(['bun', 'run', entrypoint], {
        cwd: repoRoot,
        env: childEnv,
        stdout: 'inherit',
        stderr: 'inherit',
      });
      children.push(child);
      activeProcesses.add(child);
    }

    const isolatedApiBaseUrl = `http://127.0.0.1:${apiPort}`;
    await eventually('isolated API readiness', async () => {
      if (children.some((child) => child.exitCode !== null))
        throw new Error('an isolated platform process exited before readiness');
      const response = await fetch(`${isolatedApiBaseUrl}/readyz`, {
        signal: AbortSignal.timeout(2_000),
      }).catch(() => null);
      return response?.ok ? true : null;
    });
    await sleep(1_000);

    return {
      apiBaseUrl: isolatedApiBaseUrl,
      containerDeliveryUrl: `http://host.docker.internal:${apiPort}/webhooks/alertmanager/${webhookKey}`,
      eventToken,
      localEmail,
      localPassword,
      async stop() {
        await Promise.allSettled(children.map(stopProcess));
        await Promise.allSettled([adminDb.close(), appDb.close()]);
        await removeContainers([postgresName, valkeyName]);
      },
    };
  } catch (error) {
    await Promise.allSettled(children.map(stopProcess));
    await Promise.allSettled([adminDb?.close(), appDb?.close()]);
    try {
      await removeContainers([postgresName, valkeyName]);
    } catch (cleanupError) {
      const combinedError = new Error('platform startup and cleanup both failed', { cause: error });
      combinedError.cleanupError = cleanupError;
      throw combinedError;
    }
    throw error;
  }
}

async function startAlertmanager(runId, configuredDeliveryUrl, eventToken) {
  const directory = await mkdtemp(join(tmpdir(), 'sre-alertmanager-e2e-'));
  activeDirectories.add(directory);
  const containerName = `sre-alertmanager-e2e-${runId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
  const configPath = join(directory, 'alertmanager.yml');
  await writeFile(
    configPath,
    `global:
  resolve_timeout: 1s
route:
  receiver: sre-platform-e2e
  group_by: [alertname, service]
  group_wait: 1s
  group_interval: 15s
  repeat_interval: 15s
receivers:
  - name: sre-platform-e2e
    webhook_configs:
      - url: ${JSON.stringify(configuredDeliveryUrl)}
        send_resolved: true
        http_config:
          authorization:
            type: Bearer
            credentials: ${JSON.stringify(eventToken)}
`,
    { mode: 0o600 },
  );

  try {
    activeContainers.add(containerName);
    await command([
      'docker',
      'run',
      '--detach',
      '--name',
      containerName,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--publish',
      '127.0.0.1::9093',
      '--volume',
      `${configPath}:/etc/alertmanager/alertmanager.yml:ro`,
      alertmanagerImage,
      '--config.file=/etc/alertmanager/alertmanager.yml',
      '--storage.path=/alertmanager',
      '--log.level=info',
    ]);
    const baseUrl = `http://127.0.0.1:${await mappedPort(containerName, 9093)}`;
    await eventually('Alertmanager readiness', async () => {
      const response = await fetch(`${baseUrl}/-/ready`, {
        signal: AbortSignal.timeout(2_000),
      }).catch(() => null);
      return response?.ok ? true : null;
    });
    return {
      baseUrl,
      async stop() {
        await removeContainer(containerName);
        await rm(directory, { recursive: true, force: true });
        activeDirectories.delete(directory);
      },
    };
  } catch (error) {
    await removeContainer(containerName);
    await rm(directory, { recursive: true, force: true });
    activeDirectories.delete(directory);
    throw error;
  }
}

try {
  await runScenario({
    alertmanagerImage,
    eventually,
    jsonRequest,
    startAlertmanager,
    startIsolatedPlatform,
  });
} finally {
  await cleanupActiveResources();
}
