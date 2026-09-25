// the connectorTools adapter turns a connector's granular `tools()` into engine-bindable
// ToolDefinitions that flow through the SAME audited dispatch (`runTool`). Pure unit, inline doubles,
// no DB/Valkey. Covers EARS 1 (namespacing/schema), 3 (data + one audit row), 4 (throw → error, no raw
// text), 9 (Zod-derived JSON Schema drives binding).
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { ConnectorTool, IDataSourceConnector } from '@sre/connectors';
import { connectorToolKey, connectorTools } from '../connector-tools';
import { runTool, toJsonSchema } from '../dispatch';
import { makeInMemoryAuditSink } from '../audit';
import type { ToolContext } from '../types';

const echo: ConnectorTool<{ q: string }, { echoed: string }> = {
  name: 'echo',
  description: 'echoes its input',
  inputSchema: z.object({ q: z.string() }),
  run: async (input) => ({ echoed: input.q }),
};

// A tool whose failure carries a secret in its error message: the dispatch must swallow it (CWE-209).
const RAW_SECRET = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const boom: ConnectorTool<{ q: string }, unknown> = {
  name: 'boom',
  description: 'always throws',
  inputSchema: z.object({ q: z.string() }),
  run: async () => {
    throw new Error(`upstream 500 leaking ${RAW_SECRET}`);
  },
};

function fakeConnector(
  tools: ConnectorTool[],
  identity = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Primary Datadog',
  },
): IDataSourceConnector {
  return {
    ...identity,
    type: 'datadog',
    snapshot: async () => [],
    fetchTriageContext: async () => ({ source: 'datadog', data: {} }),
    tools: () => tools,
    probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
  };
}

function makeCtx() {
  const audit = makeInMemoryAuditSink();
  const ctx: ToolContext = {
    tenantId: 't1',
    incidentId: 'inc-1',
    service: 'checkout',
    resolveConnectors: async () => [],
    audit,
  };
  return { ctx, audit };
}

describe('connectorTools adapter', () => {
  const prefix = `datadog_${connectorToolKey('00000000-0000-4000-8000-000000000001')}`;
  it('EARS1: namespaces each tool by type and immutable source id, preserving its contract', () => {
    const defs = connectorTools(fakeConnector([echo, boom]));
    expect(defs.map((d) => d.name)).toEqual([`${prefix}_echo`, `${prefix}_boom`]);
    const echoDef = defs.find((d) => d.name === `${prefix}_echo`)!;
    expect(echoDef.description).toContain('Primary Datadog');
    expect(echoDef.description).toContain('echoes its input');
    expect(echoDef.inputSchema).toBe(echo.inputSchema); // same Zod schema drives validation + binding
  });

  it('EARS9: a connector tool exposes an object JSON Schema derived from its Zod input', () => {
    const [echoDef] = connectorTools(fakeConnector([echo]));
    const schema = toJsonSchema(echoDef!) as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('q');
  });

  it('keeps same-type instance tools unique and identifies their responder-facing source', () => {
    const primary = connectorTools(fakeConnector([echo]));
    const secondary = connectorTools(
      fakeConnector([echo], {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Secondary Datadog',
      }),
    );

    expect(primary[0]!.name).not.toBe(secondary[0]!.name);
    expect(primary[0]!.description).toContain('Primary Datadog');
    expect(secondary[0]!.description).toContain('Secondary Datadog');
  });

  it('EARS3: running a connector tool returns its data and records exactly one data audit row', async () => {
    const [echoDef] = connectorTools(fakeConnector([echo]));
    const { ctx, audit } = makeCtx();

    const result = await runTool(echoDef!, ctx, { q: 'hello' });

    expect(result).toEqual({
      available: true,
      data: { echoed: 'hello' },
      evidenceId: expect.any(String),
    });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ tool: `${prefix}_echo`, outcome: 'data' });
  });

  it('EARS4: a throwing connector tool degrades to error with no raw text and an error audit row', async () => {
    const defs = connectorTools(fakeConnector([boom]));
    const boomDef = defs.find((d) => d.name === `${prefix}_boom`)!;
    const { ctx, audit } = makeCtx();

    const result = await runTool(boomDef, ctx, { q: 'x' });

    expect(result).toEqual({
      available: false,
      reason: 'error',
      evidenceId: expect.any(String),
    });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.outcome).toBe('error');
    expect(audit.records[0]!.output).toBeUndefined(); // no data on an error run
    // The raw upstream error text (which carried a secret) never reaches the audit row (CWE-209).
    expect(JSON.stringify(audit.records[0])).not.toContain(RAW_SECRET);
  });

  it('throws at bind time when a connector exposes two tools with the same name', () => {
    // Duplicate namespaced names would be rejected by the engine SDK as an opaque 400 mid-run; the
    // adapter fails fast instead so a bad connector is caught when its tools are bound.
    const conn = fakeConnector([echo, { ...echo, description: 'a clashing duplicate' }]);
    expect(() => connectorTools(conn)).toThrow(/duplicate tool name: echo/i);
  });

  it('passes the run signal to the connector tool', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const observer: ConnectorTool<{ q: string }, string> = {
      ...echo,
      name: 'observer',
      run: async (_input, options) => {
        seen.push(options?.signal);
        return 'ok';
      },
    };
    const [def] = connectorTools(fakeConnector([observer]));
    const { ctx } = makeCtx();
    const controller = new AbortController();

    await runTool(def!, { ...ctx, signal: controller.signal }, { q: 'x' });

    expect(seen).toEqual([controller.signal]);
  });
});
