export interface EvaluationState {
  passed: number;
  failed: number;
  currentCase: string | null;
}

/** Export completed and interrupted evaluation accounting before storage teardown.
 * @param state - Current case and completed assertion counts.
 * @param run - Sequential, non-retrying evaluation.
 * @param readUsage - Disposable invocation telemetry reader.
 * @param emit - Local artifact output.
 */
export async function withEvaluationReport(
  state: EvaluationState,
  run: () => Promise<void>,
  readUsage: () => Promise<unknown>,
  emit: (record: unknown) => void,
): Promise<void> {
  let stopped: unknown;
  try {
    await run();
  } catch (error) {
    stopped = error;
  }
  try {
    emit({
      event: stopped ? 'partial' : 'complete',
      ...state,
      usage: await readUsage(),
      ...(stopped ? { error: stopped instanceof Error ? stopped.name : 'UnknownError' } : {}),
    });
  } catch (error) {
    emit({
      event: 'usage_unavailable',
      ...state,
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    stopped ??= error;
  }
  if (stopped) throw stopped;
}
