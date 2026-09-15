import { and, eq } from 'drizzle-orm';
import type { Tx } from '../rls';
import { connectorConfigs } from '../schema';

/** Total-order cursor for the human evidence ledger. */
export interface EvidencePageCursor {
  createdAt: Date;
  id: string;
}

export interface EvidenceListItem {
  summary?: string | null;
  id: string;
  tool: string;
  outcome: string;
  latencyMs: number;
  recordedAt: Date;
  hasOutput: boolean;
}

export interface EvidenceDetail extends EvidenceListItem {
  input: unknown;
  output: unknown | null;
  projection: EvidenceProjection;
  referenceUrl: string | null;
}

export type EvidenceScalar = string | number | boolean | null;
export type EvidenceProjection =
  | {
      kind: 'time_series';
      source: 'prometheus' | 'datadog';
      query: string;
      from: string | null;
      to: string | null;
      series: Array<{
        name: string;
        unit: string | null;
        points: Array<{ timestamp: string; value: number }>;
      }>;
    }
  | {
      kind: 'code';
      status: string;
      artifacts: Array<{
        dataSourceName: string;
        identity: string;
        namespace: string;
        workload: string | null;
        container: string;
        revision: string | null;
      }>;
      revisions: Array<{
        repository: string;
        role: string;
        basis: string;
        strength: string;
        revision: string | null;
        providerUrl: string | null;
        deployedAt: string | null;
      }>;
      matches: Array<{
        repository: string;
        revision: string;
        strength: string;
        path: string;
        startLine: number;
        endLine: number;
        excerpt: string;
        providerUrl: string | null;
        changedFromPreviousRevision: boolean | null;
      }>;
      uncertainties: string[];
      requiredSetup: string[];
    }
  | { kind: 'facts'; columns: string[]; rows: Array<Record<string, EvidenceScalar>> }
  | { kind: 'raw' };

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const finiteNumeric = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const timestamp = (value: unknown, milliseconds: boolean): string | null => {
  const numeric = finiteNumeric(value);
  if (numeric === null) return null;
  const date = new Date(milliseconds ? numeric : numeric * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function compactEvidenceScalar(value: EvidenceScalar): EvidenceScalar {
  if (typeof value !== 'string') return value;
  const characters = [...value.replace(/\s+/g, ' ').trim()];
  return characters.length <= 240 ? characters.join('') : `${characters.slice(0, 239).join('')}…`;
}

function metricName(labels: unknown, fallback: string): string {
  const values = record(labels);
  if (!values) return fallback;
  const name = typeof values.__name__ === 'string' ? values.__name__ : fallback;
  const rest = Object.entries(values)
    .filter(([key, value]) => key !== '__name__' && typeof value === 'string')
    .map(([key, value]) => `${key}=${value}`);
  return rest.length > 0 ? `${name} {${rest.join(', ')}}` : name;
}

function sampleBounds(series: Array<{ points: Array<{ timestamp: string }> }>): {
  from: string;
  to: string;
} {
  const timestamps = series.flatMap((item) => item.points.map((point) => point.timestamp)).sort();
  return { from: timestamps[0]!, to: timestamps.at(-1)! };
}

function prometheusProjection(input: unknown, output: unknown): EvidenceProjection | null {
  const request = record(input);
  const envelope = record(output);
  const data = record(envelope?.data);
  if (data?.resultType !== 'matrix' || !Array.isArray(data.result)) return null;
  const query = typeof request?.query === 'string' ? request.query : '';
  const series = data.result.slice(0, 20).flatMap((candidate, index) => {
    const item = record(candidate);
    if (!item || !Array.isArray(item.values)) return [];
    const points = item.values.slice(0, 1_000).flatMap((point) => {
      if (!Array.isArray(point) || point.length < 2) return [];
      const at = timestamp(point[0], false);
      const value = finiteNumeric(point[1]);
      return at && value !== null ? [{ timestamp: at, value }] : [];
    });
    return points.length > 0
      ? [
          {
            name: metricName(item.metric, `series ${index + 1}`),
            unit: null,
            points,
          },
        ]
      : [];
  });
  if (series.length === 0) return null;
  const bounds = sampleBounds(series);
  return {
    kind: 'time_series',
    source: 'prometheus',
    query,
    from: bounds.from,
    to: bounds.to,
    series,
  };
}

function datadogProjection(input: unknown, output: unknown): EvidenceProjection | null {
  const request = record(input);
  const envelope = record(output);
  if (!Array.isArray(envelope?.series)) return null;
  const query = typeof request?.query === 'string' ? request.query : '';
  const series = envelope.series.slice(0, 20).flatMap((candidate, index) => {
    const item = record(candidate);
    if (!item || !Array.isArray(item.pointlist)) return [];
    const points = item.pointlist.slice(0, 1_000).flatMap((point) => {
      if (!Array.isArray(point) || point.length < 2) return [];
      const at = timestamp(point[0], true);
      const value = finiteNumeric(point[1]);
      return at && value !== null ? [{ timestamp: at, value }] : [];
    });
    const unit = Array.isArray(item.unit) ? record(item.unit[0]) : null;
    const baseName =
      (typeof item.display_name === 'string' && item.display_name) ||
      (typeof item.metric === 'string' && item.metric) ||
      `series ${index + 1}`;
    const scope = typeof item.scope === 'string' && item.scope ? item.scope : null;
    return points.length > 0
      ? [
          {
            name: scope ? `${baseName} {${scope}}` : baseName,
            unit:
              (typeof unit?.name === 'string' && unit.name) ||
              (typeof unit?.family === 'string' && unit.family) ||
              null,
            points,
          },
        ]
      : [];
  });
  if (series.length === 0) return null;
  const bounds = sampleBounds(series);
  return {
    kind: 'time_series',
    source: 'datadog',
    query,
    from: bounds.from,
    to: bounds.to,
    series,
  };
}

function flattenScalars(value: unknown, prefix = '', depth = 0): Record<string, EvidenceScalar> {
  const out: Record<string, EvidenceScalar> = {};
  const object = record(value);
  if (!object) return out;
  for (const [key, child] of Object.entries(object)) {
    if (Object.keys(out).length >= 12) break;
    const path = prefix ? `${prefix}.${key}` : key;
    if (child === null || ['string', 'number', 'boolean'].includes(typeof child)) {
      out[path] = compactEvidenceScalar(child as EvidenceScalar);
    } else if (depth < 2 && !Array.isArray(child)) {
      Object.assign(out, flattenScalars(child, path, depth + 1));
    }
  }
  return out;
}

function factsProjection(output: unknown): EvidenceProjection | null {
  const envelope = record(output);
  const knownArray = Array.isArray(output)
    ? output
    : ['items', 'data', 'events', 'resources', 'applications', 'workflow_runs', 'jobs']
        .map((key) => envelope?.[key])
        .find((value): value is unknown[] => Array.isArray(value));
  const candidates = knownArray ?? (envelope ? [envelope] : []);
  const rows = candidates
    .slice(0, 50)
    .map((candidate): Record<string, EvidenceScalar> => {
      if (
        candidate === null ||
        typeof candidate === 'string' ||
        typeof candidate === 'number' ||
        typeof candidate === 'boolean'
      )
        return { value: compactEvidenceScalar(candidate as EvidenceScalar) };
      return flattenScalars(candidate);
    })
    .filter((row) => Object.keys(row).length > 0);
  if (rows.length === 0 && knownArray === undefined) return null;
  const columns =
    rows.length > 0
      ? [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 12)
      : ['value'];
  return {
    kind: 'facts',
    columns,
    rows: rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column, row[column] ?? null])),
    ),
  };
}

const shortString = (value: unknown, max = 500): string | null => {
  if (typeof value !== 'string') return null;
  const characters = [...value];
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join('')}…`;
};

const safeHttpsReference = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
};

function codeProjection(output: unknown): EvidenceProjection | null {
  const result = record(output);
  if (!result || typeof result.status !== 'string') return null;
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const revisions = Array.isArray(result.revisions) ? result.revisions : [];
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  return {
    kind: 'code',
    status: result.status,
    artifacts: artifacts.slice(0, 20).flatMap((candidate) => {
      const artifact = record(candidate);
      const dataSourceName = shortString(artifact?.dataSourceName, 120);
      const identity = shortString(artifact?.identity, 500);
      const namespace = shortString(artifact?.namespace, 253);
      const container = shortString(artifact?.container, 253);
      if (!dataSourceName || !identity || !namespace || !container) return [];
      return [
        {
          dataSourceName,
          identity,
          namespace,
          workload: shortString(artifact?.workload, 253),
          container,
          revision: shortString(artifact?.revision, 128),
        },
      ];
    }),
    revisions: revisions.slice(0, 10).flatMap((candidate) => {
      const revision = record(candidate);
      const repository = record(revision?.repository);
      const fullName = shortString(repository?.fullName, 300);
      const role = shortString(revision?.role, 80);
      const basis = shortString(revision?.basis, 80);
      const strength = shortString(revision?.strength, 80);
      if (!fullName || !role || !basis || !strength) return [];
      return [
        {
          repository: fullName,
          role,
          basis,
          strength,
          revision: shortString(revision?.revision, 128),
          providerUrl: safeHttpsReference(revision?.providerUrl),
          deployedAt: shortString(revision?.deployedAt, 100),
        },
      ];
    }),
    matches: evidence.slice(0, 10).flatMap((candidate) => {
      const match = record(candidate);
      const repository = record(match?.repository);
      const fullName = shortString(repository?.fullName, 300);
      const revision = shortString(match?.revision, 128);
      const strength = shortString(match?.strength, 80);
      const path = shortString(match?.path, 500);
      const excerpt = shortString(match?.excerpt, 16 * 1024);
      if (
        !fullName ||
        !revision ||
        !strength ||
        !path ||
        !excerpt ||
        typeof match?.startLine !== 'number' ||
        typeof match?.endLine !== 'number'
      )
        return [];
      return [
        {
          repository: fullName,
          revision,
          strength,
          path,
          startLine: match.startLine,
          endLine: match.endLine,
          excerpt,
          providerUrl: safeHttpsReference(match.providerUrl),
          changedFromPreviousRevision:
            typeof match.changedFromPreviousRevision === 'boolean'
              ? match.changedFromPreviousRevision
              : null,
        },
      ];
    }),
    uncertainties: Array.isArray(result.uncertainties)
      ? result.uncertainties.flatMap((value) => shortString(value, 500) ?? []).slice(0, 20)
      : [],
    requiredSetup: Array.isArray(result.requiredSetup)
      ? result.requiredSetup.flatMap((value) => shortString(value, 500) ?? []).slice(0, 10)
      : [],
  };
}

const RAW_TEXT_TOOL_SUFFIXES = ['_get_pod_logs', '_get_job_logs', '_get_job_trace'] as const;

/**
 * Projects an audited tool call into model-safe incident evidence.
 *
 * @param tool - Value supplied for tool.
 * @param input - Validated input for the operation.
 * @param output - Value supplied for output.
 */
export function projectEvidence(tool: string, input: unknown, output: unknown): EvidenceProjection {
  if (tool === 'investigate_code') {
    const projection = codeProjection(output);
    if (projection) return projection;
  }
  if (tool.endsWith('_query_range')) {
    const projection = prometheusProjection(input, output);
    if (projection) return projection;
  }
  if (tool.endsWith('_query_metrics')) {
    const projection = datadogProjection(input, output);
    if (projection) return projection;
  }
  if (RAW_TEXT_TOOL_SUFFIXES.some((suffix) => tool.endsWith(suffix))) return { kind: 'raw' };
  return factsProjection(output) ?? { kind: 'raw' };
}

function connectorIdentity(tool: string): { type: string; id: string } | null {
  const match = /^([a-z0-9-]+)_([A-Za-z0-9_-]{22})_/.exec(tool);
  if (!match) return null;
  const hex = Buffer.from(match[2]!, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  return {
    type: match[1]!,
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}

export async function providerReferenceBaseUrl(tx: Tx, tool: string): Promise<string | null> {
  const identity = connectorIdentity(tool);
  if (!identity) return null;
  const rows = await tx
    .select({ type: connectorConfigs.type, settings: connectorConfigs.settings })
    .from(connectorConfigs)
    .where(and(eq(connectorConfigs.id, identity.id), eq(connectorConfigs.type, identity.type)))
    .limit(1);
  const connector = rows[0];
  if (!connector) return null;
  if (connector.type === 'github') return 'https://github.com';
  const settings = record(connector.settings);
  return typeof settings?.baseUrl === 'string' ? settings.baseUrl : null;
}

function withinProviderBase(candidate: URL, providerBaseUrl: string): boolean {
  try {
    const base = new URL(providerBaseUrl);
    if (candidate.username || candidate.password || candidate.origin !== base.origin) return false;
    const basePath = base.pathname.replace(/\/+$/, '');
    return (
      !basePath || candidate.pathname === basePath || candidate.pathname.startsWith(`${basePath}/`)
    );
  } catch {
    return false;
  }
}

/**
 * Parses a validated reference to durable incident evidence.
 *
 * @param output - Value supplied for output.
 * @param providerBaseUrl - Value supplied for provider base url.
 * @param depth - Value supplied for depth.
 */
export function safeEvidenceReference(
  output: unknown,
  providerBaseUrl: string | null,
  depth = 0,
): string | null {
  if (!providerBaseUrl || depth > 3) return null;
  if (Array.isArray(output)) {
    for (const child of output.slice(0, 50)) {
      const nested = safeEvidenceReference(child, providerBaseUrl, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  const values = record(output);
  if (!values) return null;
  for (const key of ['permalink', 'htmlUrl', 'webUrl', 'html_url', 'web_url', 'url']) {
    const candidate = values[key];
    if (typeof candidate !== 'string') continue;
    try {
      const parsed = new URL(candidate);
      if (withinProviderBase(parsed, providerBaseUrl)) return parsed.toString();
    } catch {
      // Ignore malformed provider references; raw evidence remains available.
    }
  }
  for (const child of Object.values(values)) {
    const nested = safeEvidenceReference(child, providerBaseUrl, depth + 1);
    if (nested) return nested;
  }
  return null;
}
