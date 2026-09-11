export interface TunnelSpec {
  name: 'prometheus' | 'grafana';
  context: string;
  namespace: string;
  service: string;
  localPort: number;
  remotePort: number;
}

interface PortForwardProcess {
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

interface SupervisorDeps {
  spawn(command: string[]): PortForwardProcess;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  log(message: string): void;
}

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const STABLE_RUN_MS = 60_000;
const FORCE_KILL_AFTER_MS = 5_000;

function port(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`[dev-tunnels] ${key} must be an integer from 1 to 65535`);
  }
  return parsed;
}

function envValue(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return env[key]?.trim() || fallback;
}

export function tunnelSpecs(env: NodeJS.ProcessEnv): TunnelSpec[] {
  if (env.DEV_OBSERVABILITY_TUNNELS === 'false') return [];
  const context = envValue(env, 'DEV_KUBE_CONTEXT', 'homelab-v2');
  return [
    {
      name: 'prometheus',
      context,
      namespace: envValue(env, 'DEV_PROMETHEUS_NAMESPACE', 'monitoring'),
      service: envValue(env, 'DEV_PROMETHEUS_SERVICE', 'kube-prometheus-stack-prometheus'),
      localPort: port(env, 'DEV_PROMETHEUS_LOCAL_PORT', 9090),
      remotePort: port(env, 'DEV_PROMETHEUS_REMOTE_PORT', 9090),
    },
    {
      name: 'grafana',
      context,
      namespace: envValue(env, 'DEV_GRAFANA_NAMESPACE', 'monitoring'),
      service: envValue(env, 'DEV_GRAFANA_SERVICE', 'kube-prometheus-stack-grafana'),
      localPort: port(env, 'DEV_GRAFANA_LOCAL_PORT', 3000),
      remotePort: port(env, 'DEV_GRAFANA_REMOTE_PORT', 80),
    },
  ];
}

export function portForwardCommand(spec: TunnelSpec): string[] {
  return [
    'kubectl',
    '--context',
    spec.context,
    '--namespace',
    spec.namespace,
    'port-forward',
    '--address=127.0.0.1',
    `service/${spec.service}`,
    `${spec.localPort}:${spec.remotePort}`,
  ];
}

export function restartDelayMs(failures: number): number {
  return Math.min(INITIAL_RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function superviseTunnel(
  spec: TunnelSpec,
  signal: AbortSignal,
  deps: SupervisorDeps,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    const command = portForwardCommand(spec);
    deps.log(
      `${spec.name} forwarding http://127.0.0.1:${spec.localPort} via ${spec.context}/${spec.namespace}`,
    );
    const startedAt = deps.now();
    const child = deps.spawn(command);
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_AFTER_MS);
    };
    signal.addEventListener('abort', stop, { once: true });
    const exitCode = await child.exited;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signal.removeEventListener('abort', stop);
    if (signal.aborted) return;

    failures = deps.now() - startedAt >= STABLE_RUN_MS ? 1 : failures + 1;
    const delay = restartDelayMs(failures);
    deps.log(`${spec.name} tunnel exited with code ${exitCode}; retrying in ${delay}ms`);
    await deps.sleep(delay, signal);
  }
}

async function main(): Promise<void> {
  const specs = tunnelSpecs(process.env);
  if (specs.length === 0) {
    console.info('[dev-tunnels] disabled by DEV_OBSERVABILITY_TUNNELS=false');
    return;
  }
  if (!Bun.which('kubectl')) throw new Error('[dev-tunnels] kubectl is required');

  const controller = new AbortController();
  const shutdown = (): void => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const deps: SupervisorDeps = {
    spawn: (command) =>
      Bun.spawn(command, {
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    sleep: wait,
    now: Date.now,
    log: (message) => console.info(`[dev-tunnels] ${message}`),
  };
  try {
    await Promise.all(specs.map((spec) => superviseTunnel(spec, controller.signal, deps)));
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  }
}

if (import.meta.main) await main();
