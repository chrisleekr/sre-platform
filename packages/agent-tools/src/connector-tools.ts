import type { IDataSourceConnector } from '@sre/connectors';
import type { ToolDefinition } from './types';

const UUID_HEX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encodes a connector UUID without exceeding the engine's tool-name limit.
 *
 * @param id - Immutable connector instance UUID.
 */
export function connectorToolKey(id: string): string {
  if (!UUID_HEX_RE.test(id)) throw new Error(`invalid connector instance id: ${id}`);
  return Buffer.from(id.replaceAll('-', ''), 'hex').toString('base64url');
}

/**
 * Adapts one connector's tools to the investigator engine contract.
 *
 * @remarks Names include immutable connector identity, and duplicate provider names fail at bind time.
 * @param conn - Tenant-owned connector whose tools should be bound.
 */
export function connectorTools(conn: IDataSourceConnector): ToolDefinition<any, any>[] {
  const seen = new Set<string>();
  const prefix = `${conn.type}_${connectorToolKey(conn.id)}`;
  return conn.tools().map((t) => {
    if (seen.has(t.name))
      throw new Error(`connector ${conn.type} exposes duplicate tool name: ${t.name}`);
    seen.add(t.name);
    return {
      name: `${prefix}_${t.name}`,
      description: `Data source "${conn.name}" (${conn.type}). ${t.description}`,
      inputSchema: t.inputSchema,
      handler: async (ctx, input) => ({
        available: true as const,
        data: await t.run(input, { signal: ctx.signal }),
      }),
    };
  });
}
