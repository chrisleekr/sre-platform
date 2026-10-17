let stopping = false;
const running: Promise<void>[] = [];

/** Stops every loop from claiming new work; each finishes its current turn first. */
export function requestShutdown(): void {
  stopping = true;
}

/** Whether a shutdown was requested. */
export function shuttingDown(): boolean {
  return stopping;
}

/**
 * Requests shutdown on SIGTERM or SIGINT. The worker is PID 1 in its container, so an unhandled
 * SIGTERM is ignored: Kubernetes would wait out the grace period while the replica kept claiming jobs
 * with the old code.
 * @returns The shutdown check for the caller's own loop.
 */
export function stopOnSignal(): () => boolean {
  process.once('SIGTERM', requestShutdown);
  process.once('SIGINT', requestShutdown);
  return shuttingDown;
}

/**
 * Runs one consumer turn after another, pausing only when a turn handled nothing, until shutdown.
 * @param turn - Processes one batch and returns how many jobs it handled.
 * @param idleMs - Pause after an empty turn.
 * @param stopped - Shutdown check, injectable for tests.
 */
export async function runConsumerLoop(
  turn: () => Promise<number>,
  idleMs = 1000,
  stopped: () => boolean = shuttingDown,
): Promise<void> {
  while (!stopped()) {
    if ((await turn()) === 0) await new Promise((resolve) => setTimeout(resolve, idleMs));
  }
}

/**
 * Starts a detached consumer and exits the process if it ever fails, so the orchestrator restarts
 * the worker. A detached loop that died quietly would leave its stream unconsumed while the rest of
 * the process looked healthy.
 * @param name - Consumer name for the failure log.
 * @param run - The consumer loop to start.
 * @param exit - Process exit, injectable for tests.
 */
export function superviseConsumer(
  name: string,
  run: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const loop = run().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: 'error',
        app: 'triage-worker',
        msg: 'consumer loop failed; exiting',
        consumer: name,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    exit(1);
  });
  running.push(loop);
}

/** Resolves once every supervised loop has finished its current turn after shutdown. */
export async function drainConsumers(): Promise<void> {
  await Promise.all(running);
}

/**
 * Stops the schedulers, waits for every loop to finish its current turn, then exits. A run still
 * going when Kubernetes sends SIGKILL is redelivered after its lease expires.
 * @param schedulers - Timers that enqueue new work.
 */
export async function drainAndExit(schedulers: Array<{ stop(): void }>): Promise<never> {
  for (const scheduler of schedulers) scheduler.stop();
  await drainConsumers();
  console.log(JSON.stringify({ level: 'info', app: 'triage-worker', msg: 'stopped' }));
  process.exit(0);
}
