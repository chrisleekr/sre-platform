/**
 * The throwaway stack the screenshot capture runs against: random-port Postgres and Valkey
 * containers, and the API and dashboard child processes pointed at them.
 *
 * Nothing here reads a developer's `.env`. Every URL is allocated at start and passed explicitly.
 */
import type { StartedTestContainer } from 'testcontainers';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../../packages/db/src/index';

/** Repository root, resolved from this file rather than the caller's working directory. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Prints a progress line under a shared prefix.
 *
 * @param message What just happened.
 */
export function log(message: string): void {
  console.log(`[screenshots] ${message}`);
}

/**
 * Allocates an unused localhost port, so a running development stack is never disturbed.
 *
 * @returns A port number nothing is currently listening on.
 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close(() => reject(new Error('could not allocate a port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Waits until an address answers, failing loudly with the child's own output if it never does.
 *
 * @param url Address to poll.
 * @param label Name used in the failure message.
 * @param child Child process serving the address, if any.
 * @param timeoutMs How long to wait before giving up.
 */
export async function waitForHttp(
  url: string,
  label: string,
  child?: Child,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    // A child that has already exited will never become ready, so waiting out the full
    // timeout only delays a failure that has already happened.
    const exited = child?.process.exitCode ?? null;
    if (exited !== null) throw new Error(`${label} exited with ${exited}${childDetail(child)}`);
    if (Date.now() > deadline)
      throw new Error(`${label} did not become ready at ${url}${childDetail(child)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function childDetail(child?: Child): string {
  const tail = child?.output().trim();
  return tail ? `\n\n${child!.label} output:\n${tail}` : '';
}

/** The started containers and the connection URLs allocated for them. */
export interface Stack {
  postgres: StartedTestContainer;
  valkey: StartedTestContainer;
  adminUrl: string;
  appDbUrl: string;
  valkeyUrl: string;
}

/**
 * Starts throwaway Postgres and Valkey containers and applies the schema to them.
 *
 * @returns The running containers and their connection URLs.
 */
export async function startInfrastructure(): Promise<Stack> {
  // Plain GenericContainer for both, rather than the Postgres-specific wrapper the test suite uses.
  // That wrapper's readiness probe never completes under Bun, so the start retries forever; the
  // wait below is the log line the image actually emits, once during initialisation and once when
  // the server is finally accepting connections.
  const { GenericContainer, Wait } = await import('testcontainers');

  log('starting throwaway Postgres and Valkey');
  const postgres = await new GenericContainer('pgvector/pgvector:pg16')
    .withEnvironment({
      POSTGRES_USER: 'sre',
      POSTGRES_PASSWORD: 'sre',
      POSTGRES_DB: 'sre_platform',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const pgHost = `${postgres.getHost()}:${postgres.getMappedPort(5432)}`;
  const adminUrl = `postgres://sre:sre@${pgHost}/sre_platform`;

  let valkey: StartedTestContainer | undefined;
  try {
    valkey = await new GenericContainer('valkey/valkey:9')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();

    const stack: Stack = {
      postgres,
      valkey,
      adminUrl,
      appDbUrl: `postgres://app_user:app@${pgHost}/sre_platform`,
      valkeyUrl: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`,
    };

    // The containers own random host ports, so this can only fire if the allocation logic changed.
    for (const inherited of [process.env.DATABASE_URL, process.env.APP_DATABASE_URL]) {
      if (inherited && (inherited === stack.adminUrl || inherited === stack.appDbUrl)) {
        throw new Error(
          'refusing to run: the throwaway database matched an inherited DATABASE_URL',
        );
      }
    }

    // The migration provisions the RLS-scoped login role, and refuses the weak local password unless
    // it can see a non-production environment. This process is the migrator, so it needs both values
    // itself; the API child gets its own copy below.
    process.env.NODE_ENV = 'development';
    process.env.APP_DB_PASSWORD = 'app';

    log('applying migrations');
    await runMigrations(adminUrl);
    return stack;
  } catch (error) {
    await Promise.allSettled([postgres.stop(), ...(valkey ? [valkey.stop()] : [])]);
    throw error;
  }
}

/** A spawned server process, with a bounded tail of its output for failure reporting. */
export interface Child {
  process: ReturnType<typeof Bun.spawn>;
  stop: () => void;
  label: string;
  /** Recent stdout and stderr, for reporting why a child never became ready. */
  output: () => string;
}

/**
 * Spawns a server process with an explicit environment layered over the current one.
 *
 * @param command Argument vector to run.
 * @param env Variables that override the inherited environment.
 * @param label Name used in failure messages.
 * @returns A handle that can stop the child and read its recent output.
 */
export function spawnChild(command: string[], env: Record<string, string>, label: string): Child {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Both pipes are otherwise never read, so a child that crashes at boot surfaces only as an
  // opaque readiness timeout. Keep a bounded tail instead.
  let tail = '';
  const decoder = new TextDecoder();
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) tail = (tail + decoder.decode(chunk)).slice(-4_000);
  };
  void drain(child.stdout as ReadableStream<Uint8Array>).catch(() => {});
  void drain(child.stderr as ReadableStream<Uint8Array>).catch(() => {});
  return { process: child, stop: () => child.kill(), label, output: () => tail };
}
