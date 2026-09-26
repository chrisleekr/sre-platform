import type { TopologyEndpointEvidence } from '@sre/contracts';
import { obj } from '../../values';
import { isIP } from 'node:net';

const operations = {
  resolve_dns: 'dns',
  check_reachable: 'tcp',
  inspect_tls: 'tls',
  http_meta: 'http',
} as const;

/** Project already-audited probes without replaying network operations or exposing response headers.
 * @param target - Canonical HTTP endpoint already present in tenant discovery.
 * @param row - Redacted investigator audit evidence, scoped to the authenticated workspace.
 * @param now - Freshness reference for the observation.
 */
export function networkProbeTopologyEvidence(
  target: URL,
  row: {
    id: string;
    incidentId: string;
    tool: string;
    input: unknown;
    output: unknown;
    outcome: string;
    createdAt: Date;
  },
  now: Date,
): TopologyEndpointEvidence['probes'][number] | null {
  const match =
    /^networkprobe_[A-Za-z0-9_-]{22}_(resolve_dns|check_reachable|inspect_tls|http_meta)$/.exec(
      row.tool,
    );
  if (!match) return null;
  const operation = match[1] as keyof typeof operations;
  const input = obj(row.input),
    output = obj(row.output);
  if (operation === 'http_meta') {
    if ((output.url ?? input.url) !== target.href) return null;
  } else {
    const host = output.host ?? input.host;
    if (
      typeof host !== 'string' ||
      host
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '') !== target.hostname.replace(/^\[|\]$/g, '')
    )
      return null;
    if (operation !== 'resolve_dns') {
      const port = output.port ?? input.port ?? 443;
      if (port !== Number(target.port || (target.protocol === 'https:' ? 443 : 80))) return null;
      if (operation === 'inspect_tls' && target.protocol !== 'https:') return null;
    }
  }
  const observed = row.createdAt.getTime();
  if (!Number.isFinite(observed) || observed > now.getTime()) return null;
  const facts: TopologyEndpointEvidence['probes'][number]['facts'] = {};
  if (row.outcome === 'data') {
    if (operation === 'resolve_dns' && Array.isArray(output.addresses))
      facts.addresses = output.addresses
        .slice(0, 20)
        .flatMap((value) =>
          typeof obj(value).ip === 'string' && isIP(String(obj(value).ip))
            ? [String(obj(value).ip)]
            : [],
        );
    if (operation === 'check_reachable') {
      if (typeof output.reachable === 'boolean') facts.reachable = output.reachable;
      if (
        typeof output.latencyMs === 'number' &&
        Number.isFinite(output.latencyMs) &&
        output.latencyMs >= 0
      )
        facts.latencyMs = output.latencyMs;
    }
    if (operation === 'inspect_tls') {
      if (typeof output.authorized === 'boolean') facts.authorized = output.authorized;
      if (typeof output.valid_to === 'string' && Number.isFinite(Date.parse(output.valid_to)))
        facts.expiresAt = new Date(output.valid_to).toISOString();
    }
    if (
      operation === 'http_meta' &&
      typeof output.status === 'number' &&
      Number.isInteger(output.status) &&
      output.status >= 100 &&
      output.status <= 599
    ) {
      // A withheld target means the status is for `/`, not this URL.
      if (output.targetWithheld !== true) facts.status = output.status;
      // An https status from an unverified peer is unproven; keep the verdict beside it.
      if (typeof output.tlsAuthorized === 'boolean') facts.authorized = output.tlsAuthorized;
    }
  }
  return {
    kind: operations[operation],
    state: Object.keys(facts).length ? 'observed' : 'unavailable',
    evidenceId: row.id,
    incidentId: row.incidentId,
    tool: row.tool,
    observedAt: row.createdAt.toISOString(),
    stale: now.getTime() - observed > 300_000,
    facts,
  };
}
