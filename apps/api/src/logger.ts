export interface Logger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Stable error identity for logs that must never include raw messages, queries, URLs, or secrets. */
export function safeErrorMetadata(error: unknown): Record<string, unknown> {
  const record =
    error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
  const data =
    record?.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : undefined;
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(typeof record?.code === 'string' ? { errorCode: record.code } : {}),
    ...(typeof data?.error === 'string' ? { slackError: data.error } : {}),
    ...(typeof record?.statusCode === 'number' ? { upstreamStatus: record.statusCode } : {}),
  };
}

/** Minimal structured (JSON line) logger. */
export function makeLogger(base: Record<string, unknown> = {}): Logger {
  function emit(level: 'info' | 'error', msg: string, fields?: Record<string, unknown>): void {
    const line = JSON.stringify({ level, msg, ...base, ...fields, ts: new Date().toISOString() });
    if (level === 'error') console.error(line);
    else console.log(line);
  }
  return {
    info: (msg, fields) => emit('info', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
