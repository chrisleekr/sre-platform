import { describe, expect, test, vi } from 'vitest';
import { startClaudeTelemetry } from '../llm-telemetry';

const attribute = (key: string, value: unknown) => ({
  key,
  value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: String(value) },
});

describe('Claude native OTLP receiver', () => {
  test('accepts only its bearer and persists redacted standard provider logs', async () => {
    const events: Array<{ kind: string; payload: unknown; bodyBytes?: number }> = [];
    const receiver = await startClaudeTelemetry(async (event) => {
      events.push(event);
    });
    const endpoint = receiver.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!;
    const authorization = receiver.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS!.replace(
      'Authorization=',
      '',
    );
    const exportBody = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    attribute('event.name', 'api_request'),
                    attribute('event.sequence', 1),
                    attribute('event.timestamp', '2026-08-25T00:00:00.000Z'),
                    attribute('model', 'claude-test'),
                    attribute('authorization', 'Bearer abc.def.ghi123XYZ'),
                  ],
                  body: { stringValue: 'provider request accepted' },
                },
              ],
            },
          ],
        },
      ],
    };

    const rejected = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify(exportBody),
    });
    expect(rejected.status).toBe(401);
    expect(events).toEqual([]);

    const accepted = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(exportBody),
    });
    expect(accepted.status).toBe(200);
    await expect(receiver.close()).resolves.toEqual({ complete: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'api_request',
    });
    expect(JSON.stringify(events[0]!.payload)).toContain('provider request accepted');
    expect(JSON.stringify(events[0]!.payload)).not.toContain('abc.def.ghi123XYZ');
    expect(JSON.stringify(events[0]!.payload)).toContain('[REDACTED]');
    expect(receiver.env).not.toHaveProperty('OTEL_LOG_RAW_API_BODIES');
  });

  test('rejects unsupported and malformed exports and records the parse gap', async () => {
    const persist = vi.fn(async () => undefined);
    const receiver = await startClaudeTelemetry(persist);
    const endpoint = receiver.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!;
    const authorization = receiver.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS!.replace(
      'Authorization=',
      '',
    );

    const unsupported = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization },
      body: '{}',
    });
    expect(unsupported.status).toBe(415);

    const malformed = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    await receiver.close();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ kind: 'trace_gap' }));
  });

  test('marks telemetry incomplete when no provider request, response, or error arrives', async () => {
    const persist = vi.fn(async () => undefined);
    const receiver = await startClaudeTelemetry(persist);
    await expect(receiver.close()).resolves.toEqual({ complete: false });
    expect(persist).toHaveBeenCalledWith({
      kind: 'trace_gap',
      payload: { reason: 'No Claude provider telemetry was received' },
    });
  });

  test('ends the exporter response when both the provider event and trace-gap writes fail', async () => {
    const receiver = await startClaudeTelemetry(async () => {
      throw new Error('database unavailable');
    });
    const endpoint = receiver.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!;
    const authorization = receiver.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS!.replace(
      'Authorization=',
      '',
    );
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [{ attributes: [attribute('event.name', 'api_request')] }],
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(1_000),
    });
    expect(response.status).toBe(400);
    await expect(receiver.close()).resolves.toEqual({ complete: false });
  });
});
