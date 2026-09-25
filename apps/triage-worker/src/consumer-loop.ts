/**
 * Runs one consumer turn after another, pausing only when a turn handled nothing.
 * @param turn - Processes one batch and returns how many jobs it handled.
 * @param idleMs - Pause after an empty turn.
 */
export async function runConsumerLoop(turn: () => Promise<number>, idleMs = 1000): Promise<never> {
  for (;;) {
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
  run: () => Promise<never>,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  run().catch((error: unknown) => {
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
}
