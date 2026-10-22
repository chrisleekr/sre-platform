// Pure unit test (no DB/Valkey) for the shared tool dispatch (`runTool`). Dispatch is UNCHANGED by
// the five signal tools it used to exercise are gone, so these tests drive the SAME dispatch
// contract (real-data, error, tenant-scoping, input-validation, audit outcomes, JSON Schema) through
// an inline `ToolDefinition` double that mimics a connector-backed tool.
// EARS 5 (bad input → ZodError, no audit row) lives here; the per-connector adapter's EARS 1/3/4/9
// live in connector-tools.test.ts.

import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { makeFakeConnector } from '@sre/connectors';
import {
  SourceFileNotFoundError,
  SourceRateLimitError,
} from '@sre/connectors/src/source-file-error';
import type { ConnectorConfig, ConnectorType, IDataSourceConnector } from '@sre/connectors';
import { classifyToolError, runTool, toJsonSchema } from '../dispatch';
import { makeInMemoryAuditSink } from '../audit';
import type { ToolAuditSink, ToolContext, ToolDefinition } from '../types';

const TENANT = 'tenant-1';
const INCIDENT = 'incident-1';
const SERVICE = 'checkout';
const WINDOW = 30;
// Dispatch has never had a notion of capability: `runTool` resolves connectors and runs the handler,
// nothing more. The double below needs *some* branching predicate purely to keep the empty-result path
// reachable, so it keys off the connector's own `type`. Both values are arbitrary and decoupled from
// any shipped tool; only the capable/incapable distinction matters.
const CAPABLE_TYPE: ConnectorType = 'datadog';
const INCAPABLE_TYPE: ConnectorType = 'github';

type TriageToolInput = { service: string; windowMinutes: number };
const VALID_INPUT: TriageToolInput = { service: SERVICE, windowMinutes: WINDOW };
const triageInputSchema = z.object({
  service: z.string().min(1),
  windowMinutes: z.number().int().positive(),
});

// Per-tenant connector resolution. An unknown tenant resolves to none, which is how
// tenant isolation manifests here: never another tenant's connectors.
type ConnectorProvider = (tenantId: string) => Promise<IDataSourceConnector[]>;

function tenantConnectors(byTenant: Record<string, IDataSourceConnector[]>): ConnectorProvider {
  return async (tenantId) => byTenant[tenantId] ?? [];
}

function connectorConfig(tenantId: string, type: ConnectorType): ConnectorConfig {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: `Test ${type}`,
    tenantId,
    type,
    settings: {},
    getCredential: async () => 'secret',
  };
}

// A fake connector plus a spy on fetchTriageContext, so each case can assert whether the
// real-data path was taken. 'capable' is what the double below serves from.
function fakeConnector(capability: 'capable' | 'incapable') {
  const type = capability === 'capable' ? CAPABLE_TYPE : INCAPABLE_TYPE;
  const connector = makeFakeConnector(connectorConfig(TENANT, type));
  const fetchSpy = vi.spyOn(connector, 'fetchTriageContext');
  return { connector, fetchSpy };
}

// An inline connector-backed tool: it resolves the tenant's connectors, fetches from one it can serve
// from, and returns an EMPTY RESULT when none matches. Empty is data, not unavailability — a tool has
// only two outcomes, data or error. Reproduces the dispatch behaviors the deleted signal tools used to
// exercise, without depending on them.
function probeTool(): ToolDefinition<TriageToolInput, unknown[]> {
  return {
    name: 'connector_probe',
    description: 'connector-backed probe',
    inputSchema: triageInputSchema,
    async handler(ctx, input) {
      const connectors = await ctx.resolveConnectors();
      const capable = connectors.find((c) => c.type === CAPABLE_TYPE);
      if (!capable) return { available: true, data: [] };
      return { available: true, data: [await capable.fetchTriageContext(input)] };
    },
  };
}

function makeContext(opts: {
  tenantId?: string;
  resolve: ConnectorProvider;
  audit: ToolAuditSink;
}): ToolContext {
  const tenantId = opts.tenantId ?? TENANT;
  return {
    tenantId,
    incidentId: INCIDENT,
    service: SERVICE,
    resolveConnectors: () => opts.resolve(tenantId),
    audit: opts.audit,
  };
}

describe('runTool (shared tool dispatch)', () => {
  it('empty-as-data: an incapable connector yields empty data and never calls fetchTriageContext', async () => {
    const tool = probeTool();
    const { connector, fetchSpy } = fakeConnector('incapable');
    const audit = makeInMemoryAuditSink();
    const ctx = makeContext({ resolve: tenantConnectors({ [TENANT]: [connector] }), audit });

    const result = await runTool(tool, ctx, VALID_INPUT);

    expect(result).toEqual({ available: true, data: [], evidenceId: expect.any(String) });
    expect(fetchSpy).not.toHaveBeenCalled();
    // Nothing to serve still audits as a data outcome: there is no third outcome to degrade to.
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.outcome).toBe('data');
  });

  it('real-data: a capable connector returns available data fetched for the input window', async () => {
    const tool = probeTool();
    const { connector, fetchSpy } = fakeConnector('capable');
    const audit = makeInMemoryAuditSink();
    const ctx = makeContext({ resolve: tenantConnectors({ [TENANT]: [connector] }), audit });

    const result = await runTool(tool, ctx, VALID_INPUT);

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected an available result');
    expect(result.data).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledWith({ service: SERVICE, windowMinutes: WINDOW });
  });

  it('tenant-scoping: a tenant with no connectors gets empty data, never another tenant data', async () => {
    const tool = probeTool();
    const { connector, fetchSpy } = fakeConnector('capable');
    const audit = makeInMemoryAuditSink();
    // The capable connector belongs to 'tenant-other'; the run is for TENANT, which has none.
    const ctx = makeContext({
      tenantId: TENANT,
      resolve: tenantConnectors({ 'tenant-other': [connector] }),
      audit,
    });

    const result = await runTool(tool, ctx, VALID_INPUT);

    // Empty, and provably NOT the other tenant's rows: the resolver never handed them over, so the
    // capable connector was never fetched from.
    expect(result).toEqual({ available: true, data: [], evidenceId: expect.any(String) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('error: a capable connector that throws is caught and audited as error', async () => {
    const tool = probeTool();
    const { connector, fetchSpy } = fakeConnector('capable');
    fetchSpy.mockRejectedValue(new Error('upstream 500'));
    const audit = makeInMemoryAuditSink();
    const ctx = makeContext({ resolve: tenantConnectors({ [TENANT]: [connector] }), audit });

    const result = await runTool(tool, ctx, VALID_INPUT);

    expect(result).toEqual({
      available: false,
      reason: 'error',
      failure: 'provider_error',
      evidenceId: expect.any(String),
    });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.outcome).toBe('error');
    expect(typeof audit.records[0]!.latencyMs).toBe('number');
  });

  it('malformed input rejects at runTool with a ZodError and records no audit entry', async () => {
    const tool = probeTool();
    const { connector } = fakeConnector('capable');
    const audit = makeInMemoryAuditSink();
    const ctx = makeContext({ resolve: tenantConnectors({ [TENANT]: [connector] }), audit });

    await expect(runTool(tool, ctx, { windowMinutes: WINDOW })).rejects.toThrow(z.ZodError);
    expect(audit.records).toHaveLength(0);
  });

  it('a sink rejection surfaces rather than relabeling a successful run as error', async () => {
    const tool = probeTool();
    const { connector } = fakeConnector('capable');
    const audit = makeInMemoryAuditSink();
    vi.spyOn(audit, 'record').mockRejectedValue(new Error('audit down'));
    const ctx = makeContext({ resolve: tenantConnectors({ [TENANT]: [connector] }), audit });

    await expect(runTool(tool, ctx, VALID_INPUT)).rejects.toThrow('audit down');
  });

  describe('input-validation: inputSchema rejects malformed input', () => {
    const tool = probeTool();

    it('accepts a well-formed input', () => {
      expect(tool.inputSchema.parse(VALID_INPUT)).toMatchObject(VALID_INPUT);
    });

    it('rejects a missing service', () => {
      expect(() => tool.inputSchema.parse({ windowMinutes: WINDOW })).toThrow(z.ZodError);
    });

    it('rejects a non-number windowMinutes', () => {
      expect(() => tool.inputSchema.parse({ service: SERVICE, windowMinutes: 'soon' })).toThrow(
        z.ZodError,
      );
    });
  });

  describe('audit: every run records exactly one entry', () => {
    it('records outcome=data for a capable run with the full record shape', async () => {
      const tool = probeTool();
      const { connector } = fakeConnector('capable');
      const audit = makeInMemoryAuditSink();
      const ctx = makeContext({ resolve: tenantConnectors({ [TENANT]: [connector] }), audit });

      await runTool(tool, ctx, VALID_INPUT);

      expect(audit.records).toHaveLength(1);
      const rec = audit.records[0]!;
      expect(rec).toMatchObject({
        tool: 'connector_probe',
        tenantId: TENANT,
        incidentId: INCIDENT,
        input: VALID_INPUT,
        outcome: 'data',
      });
      expect(typeof rec.latencyMs).toBe('number');
      expect(rec.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('records outcome=data, with an empty output, when no connector can serve', async () => {
      const tool = probeTool();
      const { connector } = fakeConnector('incapable');
      const audit = makeInMemoryAuditSink();
      const ctx = makeContext({ resolve: tenantConnectors({ [TENANT]: [connector] }), audit });

      await runTool(tool, ctx, VALID_INPUT);

      expect(audit.records).toHaveLength(1);
      expect(audit.records[0]!.outcome).toBe('data');
      // An empty run still persists its (empty) output, unlike an `error` run which carries none.
      expect(audit.records[0]!.output).toEqual([]);
    });
  });

  it('toJsonSchema derives an engine-agnostic JSON Schema from a tool input schema', () => {
    const schema = toJsonSchema(probeTool()) as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('service');
    expect(schema.properties).toHaveProperty('windowMinutes');
    expect(schema.required).toEqual(expect.arrayContaining(['service', 'windowMinutes']));
  });
});

// After the handler, the SAME value goes to BOTH the model (result.data returned to the loop) AND the
// audit sink (entry.output persisted to agent_tool_calls). Neither is redacted.
const RAW_SECRET = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

// Captures the full audit entry, including the `output` the sink is expected to receive.
function capturingAuditSink(): ToolAuditSink & { entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry as unknown as Record<string, unknown>);
      return '22222222-2222-4222-8222-222222222222';
    },
  };
}

// A tool whose handler returns credential-shaped data. No connector needed.
function secretBearingTool(): ToolDefinition<Record<string, never>, unknown> {
  return {
    name: 'leaky_tool',
    description: 'returns secret-bearing data',
    inputSchema: z.object({}),
    async handler() {
      return {
        available: true,
        data: {
          password: 'hunter2-super-secret',
          note: `deploy ok; auth Bearer ${RAW_SECRET}`,
          rows: [{ id: 1, apiKey: RAW_SECRET }],
        },
      };
    },
  };
}

describe('dispatch passes tool output through unredacted', () => {
  it('returns durable evidence id after audit persistence', async () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    let resolveRecord!: (id: string) => void;
    let recordStarted!: () => void;
    const recordCalled = new Promise<void>((resolve) => {
      recordStarted = resolve;
    });
    const record = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          recordStarted();
          resolveRecord = resolve;
        }),
    );
    const audit = { record } as unknown as ToolAuditSink;
    const ctx = makeContext({ resolve: tenantConnectors({}), audit });

    const run = runTool(secretBearingTool(), ctx, {});
    const settled = vi.fn();
    void run.then(settled);

    await recordCalled;
    expect(record).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    resolveRecord(evidenceId);

    await expect(run).resolves.toEqual({
      available: true,
      evidenceId,
      data: {
        password: 'hunter2-super-secret',
        note: `deploy ok; auth Bearer ${RAW_SECRET}`,
        rows: [{ id: 1, apiKey: RAW_SECRET }],
      },
    });
  });

  it('returns and audits the identical raw handler data', async () => {
    const audit = capturingAuditSink();
    const ctx = makeContext({ resolve: tenantConnectors({}), audit });

    const result = await runTool(secretBearingTool(), ctx, {});

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected an available result');
    expect(JSON.stringify(result.data)).toContain(RAW_SECRET);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]!.output).toBe(result.data);
  });

  describe('cancellation', () => {
    const reason = new Error('deadline exceeded');
    const cancellable = (
      handler: ToolDefinition<Record<string, never>, string>['handler'],
    ): ToolDefinition<Record<string, never>, string> => ({
      name: 'cancellable',
      description: 'observes the run signal',
      inputSchema: z.object({}),
      handler,
    });

    it('throws the signal reason without calling the handler or auditing when already aborted', async () => {
      const handler = vi.fn(async () => ({ available: true as const, data: 'ran' }));
      const audit = makeInMemoryAuditSink();
      const controller = new AbortController();
      controller.abort(reason);
      const ctx = {
        ...makeContext({ resolve: tenantConnectors({}), audit }),
        signal: controller.signal,
      };

      await expect(runTool(cancellable(handler), ctx, {})).rejects.toBe(reason);
      expect(handler).not.toHaveBeenCalled();
      expect(audit.records).toHaveLength(0);
    });

    it('rethrows the signal reason when the handler fails after the run is aborted', async () => {
      const audit = makeInMemoryAuditSink();
      const controller = new AbortController();
      const ctx = {
        ...makeContext({ resolve: tenantConnectors({}), audit }),
        signal: controller.signal,
      };
      const tool = cancellable(async (handlerCtx) => {
        controller.abort(reason);
        // A provider client reports the abort as its own error, not as the run's reason.
        handlerCtx.signal?.throwIfAborted();
        throw new Error('fetch aborted');
      });

      await expect(runTool(tool, ctx, {})).rejects.toBe(reason);
      expect(audit.records).toHaveLength(0);
    });

    it('still degrades a handler error to an error result while the signal is live', async () => {
      const audit = makeInMemoryAuditSink();
      const ctx = {
        ...makeContext({ resolve: tenantConnectors({}), audit }),
        signal: new AbortController().signal,
      };
      const tool = cancellable(async () => {
        throw new Error('provider 500');
      });

      const result = await runTool(tool, ctx, {});

      expect(result).toEqual({
        available: false,
        reason: 'error',
        failure: 'provider_error',
        evidenceId: expect.any(String),
      });
      expect(audit.records.map((record) => record.outcome)).toEqual(['error']);
    });
  });
});

describe('tool failure classes', () => {
  /** Mirrors the typed fields connector errors carry; the message always holds a secret. */
  const failing = (fields: Record<string, unknown>, name = 'Error') =>
    Object.assign(new Error('upstream said token=ghp_LEAKED'), { name, ...fields });

  it.each([
    ['TimeoutError from an aborted request', failing({}, 'TimeoutError'), 'timeout'],
    ['K8sApiError 403', failing({ status: 403 }), 'permission_denied'],
    ['K8sApiError 401', failing({ status: 401 }), 'permission_denied'],
    ['K8sApiError 404', failing({ status: 404 }), 'not_found'],
    ['K8sApiError 429', failing({ status: 429 }), 'rate_limited'],
    ['K8sApiError 500', failing({ status: 500 }), 'provider_error'],
    [
      'GitHubApiError quota 403',
      failing({ failureCategory: 'rate_limited', status: 403 }),
      'rate_limited',
    ],
    [
      'GitHubApiError 404, which hides what the credential cannot see',
      failing({ failureCategory: 'permission_denied', status: 404 }),
      'permission_denied',
    ],
    ['SourceFileNotFoundError', new SourceFileNotFoundError(), 'not_found'],
    ['SourceRateLimitError', new SourceRateLimitError(), 'rate_limited'],
    [
      'ArgoApiError permission',
      failing({ failureCategory: 'permission_denied' }),
      'permission_denied',
    ],
    ['ArgoApiError unreachable', failing({ failureCategory: 'unreachable' }), 'unreachable'],
    ['ArgoApiError tls', failing({ failureCategory: 'tls' }), 'unreachable'],
    [
      'ArgoApiError provider',
      failing({ failureCategory: 'provider_unavailable' }),
      'provider_error',
    ],
    [
      'networkprobe target',
      failing({ failureCategory: 'target_not_allowed' }),
      'target_not_allowed',
    ],
    ['untyped Error', failing({}), 'provider_error'],
    ['a thrown string', 'boom', 'provider_error'],
  ] as const)('%s classifies as %s', (_label, error, failure) => {
    expect(classifyToolError(error)).toBe(failure);
  });

  it('returns and audits the class without the provider message', async () => {
    const audit = makeInMemoryAuditSink();
    const ctx = makeContext({ resolve: tenantConnectors({}), audit });
    const tool: ToolDefinition<Record<string, never>, never> = {
      name: 'k8s_secrets',
      description: 'denied read',
      inputSchema: z.object({}).strict() as z.ZodType<Record<string, never>>,
      handler: async () => {
        throw failing({ status: 403 });
      },
    };

    const result = await runTool(tool, ctx, {});

    expect(result).toEqual({
      available: false,
      reason: 'error',
      failure: 'permission_denied',
      evidenceId: expect.any(String),
    });
    expect(audit.records[0]).toMatchObject({
      outcome: 'error',
      output: { failure: 'permission_denied' },
    });
    expect(JSON.stringify([result, audit.records])).not.toMatch(/LEAKED|upstream said/);
  });
});
