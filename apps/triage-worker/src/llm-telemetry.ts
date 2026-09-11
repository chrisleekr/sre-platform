import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { redactInput } from '@sre/agent-tools';
import type { LlmTelemetryEventInput } from '@sre/db';

const OTLP_PATH = '/v1/logs';
const MAX_BYTES = 64 * 1024 * 1024;
const PROVIDER_EVENTS = new Set(['api_request', 'api_response', 'api_error']);

export interface ClaudeTelemetryReceiver {
  env: Record<string, string>;
  recordDiagnostic(message: string): Promise<void>;
  close(): Promise<{ complete: boolean }>;
}

interface ReceiverState {
  providerEvents: number;
  gaps: number;
  processing: Promise<void>;
}

/**
 * Starts one authenticated loopback OTLP/HTTP receiver for one Claude Agent SDK query.
 * Standard provider logs are redacted and persisted through the caller. Raw API bodies stay
 * disabled because arbitrary prompts and tool results cannot be made safe by best-effort scrubbing.
 * A receiver gap makes the invocation telemetry explicitly incomplete.
 */
export async function startClaudeTelemetry(
  persist: (event: LlmTelemetryEventInput) => Promise<void>,
): Promise<ClaudeTelemetryReceiver> {
  const token = randomBytes(32).toString('base64url');
  const state: ReceiverState = {
    providerEvents: 0,
    gaps: 0,
    processing: Promise.resolve(),
  };
  const gap = async (reason: string): Promise<void> => {
    state.gaps += 1;
    await persist({
      kind: 'trace_gap',
      payload: { reason: sanitize(reason, token) },
    });
  };
  const server = createServer((request, response) => {
    void receive(request, response, token, state, persist, gap);
  });

  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Claude telemetry receiver did not bind a TCP port');
  }

  let closed: Promise<{ complete: boolean }> | undefined;
  return {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${address.port}${OTLP_PATH}`,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${token}`,
      OTEL_LOGS_EXPORT_INTERVAL: '1000',
      CLAUDE_CODE_OTEL_DIAG_STDERR: '1',
    },
    async recordDiagnostic(message) {
      if (!/OTEL|OpenTelemetry/iu.test(message)) return;
      await gap(`Claude telemetry diagnostic: ${message.slice(0, 2_000)}`);
    },
    close() {
      closed ??= closeReceiver(server, state, gap);
      return closed;
    },
  };
}

async function closeReceiver(
  server: Server,
  state: ReceiverState,
  gap: (reason: string) => Promise<void>,
): Promise<{ complete: boolean }> {
  await closeServer(server).catch(() => gap('Claude telemetry receiver did not stop cleanly'));
  await state.processing;
  if (state.providerEvents === 0) await gap('No Claude provider telemetry was received');
  return { complete: state.gaps === 0 };
}

async function receive(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  state: ReceiverState,
  persist: (event: LlmTelemetryEventInput) => Promise<void>,
  gap: (reason: string) => Promise<void>,
): Promise<void> {
  if (request.method !== 'POST' || request.url !== OTLP_PATH) {
    request.resume();
    reply(response, 404);
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    request.resume();
    reply(response, 401);
    return;
  }
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    request.resume();
    reply(response, 415);
    return;
  }

  try {
    const bytes = await readRequest(request);
    const payload = JSON.parse(bytes.toString('utf8')) as unknown;
    const next = state.processing.then(() => processExport(payload, state, persist));
    state.processing = next.catch(() => undefined);
    await next;
    reply(response, 200);
  } catch (error) {
    const status = error instanceof TooLargeError ? 413 : 400;
    try {
      await gap(error instanceof Error ? error.message : 'Malformed Claude OTLP export');
    } catch {
      // The in-memory gap counter already marks this capture incomplete. A second persistence
      // failure must never leave the authenticated exporter connection open.
    } finally {
      reply(response, status);
    }
  }
}

async function processExport(
  payload: unknown,
  state: ReceiverState,
  persist: (event: LlmTelemetryEventInput) => Promise<void>,
): Promise<void> {
  const root = objectValue(payload, 'OTLP export');
  for (const resourceLogValue of arrayProperty(root, 'resourceLogs')) {
    const resourceLog = objectValue(resourceLogValue, 'resource log');
    const resource = optionalObject(resourceLog.resource, 'resource');
    const resourceAttributes = attributesOf(resource?.attributes);
    for (const scopeLogValue of arrayProperty(resourceLog, 'scopeLogs')) {
      const scopeLog = objectValue(scopeLogValue, 'scope log');
      for (const recordValue of arrayProperty(scopeLog, 'logRecords')) {
        const record = objectValue(recordValue, 'log record');
        const attributes = new Map([...resourceAttributes, ...attributesOf(record.attributes)]);
        await processRecord(record, attributes, state, persist);
      }
    }
  }
}

async function processRecord(
  record: Record<string, unknown>,
  attributes: Map<string, unknown>,
  state: ReceiverState,
  persist: (event: LlmTelemetryEventInput) => Promise<void>,
): Promise<void> {
  const eventName = stringValue(attributes.get('event.name')) ?? 'otel_log';
  const providerSequence = safeInteger(attributes.get('event.sequence'));
  const providerTimestamp = dateValue(attributes.get('event.timestamp'));
  const model = stringValue(attributes.get('model'));
  const bodyBytes = safeInteger(attributes.get('body_length'));

  const payload = Object.fromEntries(attributes);
  delete payload.body_ref;
  delete payload.body_length;
  if (record.body !== undefined) payload.logBody = attributeValue(record.body);
  if (PROVIDER_EVENTS.has(eventName)) state.providerEvents += 1;

  await persist({
    kind: eventName,
    providerSequence,
    providerTimestamp,
    model,
    payload: redactInput(payload),
    bodyBytes,
  });
}

async function readRequest(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new TooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_BYTES) throw new TooLargeError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

class TooLargeError extends Error {}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function reply(response: ServerResponse, status: number): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end('{}');
}

function attributesOf(value: unknown): Array<[string, unknown]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('OTLP attributes is not an array');
  return value.map((attribute) => {
    const item = objectValue(attribute, 'OTLP attribute');
    if (typeof item.key !== 'string') throw new Error('OTLP attribute key is invalid');
    return [item.key, attributeValue(item.value)];
  });
}

function attributeValue(value: unknown): unknown {
  if (!isObject(value)) return undefined;
  for (const key of ['stringValue', 'intValue', 'doubleValue', 'boolValue'] as const) {
    if (key in value) return value[key];
  }
  return undefined;
}

function arrayProperty(value: Record<string, unknown>, key: string): unknown[] {
  const property = value[key];
  if (property === undefined) return [];
  if (!Array.isArray(property)) throw new Error(`OTLP ${key} is not an array`);
  return property;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} is not an object`);
  return value;
}

function optionalObject(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : objectValue(value, label);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function dateValue(value: unknown): Date | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function sanitize(message: string, token: string): string {
  return message.replaceAll(token, '[redacted]');
}
