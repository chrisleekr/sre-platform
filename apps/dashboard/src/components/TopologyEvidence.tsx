import type { TopologyFactSource, TopologyRelation } from '@sre/contracts';
import type { TopologyDiscoveryGraph } from '../lib/topology';
import { formatAbsoluteTime } from '../lib/time';

export const evidenceLabels: Record<TopologyRelation['evidence'], string> = {
  provider_reference: 'Provider reference',
  observed: 'Observed',
  declared: 'Declared',
  inferred: 'Inferred',
};

const issues = {
  permission_denied: 'Access denied. Check the connection permissions.',
  unreachable: 'Source could not be reached. Check the connection.',
  rate_limited: 'Provider rate limit reached. Evidence will refresh on a later collection.',
  invalid_response: 'Source returned an unexpected response.',
  request_rejected:
    'Source rejected the discovery query. Check its data availability and connection configuration.',
  limit: 'Collection limit reached. Only part of the configured scope is represented.',
  sampling: 'Sampled telemetry. Missing relationships do not prove that no dependency exists.',
  missing_scope:
    'Connect Kubernetes inventory first. Log discovery needs a verified cluster identity to keep reads scoped to this workspace.',
  no_matches:
    'No matching request logs in this sample window. This does not mean there is no traffic.',
  unsupported_schema:
    'No cross-workload request evidence could be extracted. Logs may use an unsupported format, omit runtime identity or describe local-only calls.',
};
const capabilityLabels = {
  not_connected: 'Not connected',
  disabled: 'Connection disabled',
  pending: 'Awaiting first collection',
  collected: 'Collection attempted',
  on_demand: 'On-demand probe evidence',
  unsupported: 'Not implemented',
};
const providerNames: Record<string, string> = {
  aws: 'AWS',
  confluence: 'Confluence',
  networkprobe: 'Network probe',
  github: 'GitHub',
  gitlab: 'GitLab',
  argocd: 'Argo CD',
  kubernetes: 'Kubernetes',
  prometheus: 'Prometheus',
  datadog: 'Datadog',
  grafana: 'Grafana',
  statuscake: 'StatusCake',
};

/** Display evidence age independently of the most recent collection attempt. */
export function TopologyEvidenceSources({ sources }: { sources: TopologyFactSource[] }) {
  const unique = [
    ...new Map(
      sources.map((source) => [
        JSON.stringify([source.connectorId, source.collection, source.observedAt]),
        source,
      ]),
    ).values(),
  ];
  return (
    <ul className="space-y-1 text-xs text-ink-muted" aria-label="Evidence sources">
      {unique.map((source) => (
        <li key={JSON.stringify([source.connectorId, source.collection, source.observedAt])}>
          {source.connectorName} · {source.collection} · {source.completeness}
          <span className="block">Evidence observed {formatAbsoluteTime(source.observedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Explain collection gaps without presenting them as absent infrastructure or healthy runtime. */
export function TopologyDiscoveryCoverage({ graph }: { graph: TopologyDiscoveryGraph }) {
  const inventoried = new Set(
    graph.coverage
      .filter((source) => source.collection !== '__discovery__')
      .map((source) => source.connectorId),
  );
  const collections = graph.coverage.filter(
    (source) => source.collection !== '__discovery__' || !inventoried.has(source.connectorId),
  );
  const gaps = collections.filter((source) => source.completeness !== 'complete');
  const sources = new Set(graph.coverage.map((source) => source.connectorId));
  return (
    <details className="rounded-lg border border-line bg-surface p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Discovery coverage · {sources.size} sources · {gaps.length} incomplete{' '}
        {gaps.length === 1 ? 'collection' : 'collections'}
      </summary>
      <p className="my-3 text-xs text-ink-muted">
        These are completed collection attempts, not a list of every configured connection. A
        partial or failed read retains earlier evidence within storage limits; it does not confirm
        that resources disappeared.
      </p>
      {graph.capabilities && (
        <details className="mb-3 rounded border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Connection capabilities and pending sources
          </summary>
          <p className="my-2 text-xs text-ink-muted">
            Additional connections are optional. Unsupported capabilities cannot be enabled by
            adding credentials. Network probes contribute existing audited observations, not
            scheduled inventory.
          </p>
          <ul
            className="max-h-64 space-y-2 overflow-y-auto text-xs"
            aria-label="Discovery source capabilities"
          >
            {graph.capabilities.map((source) => (
              <li
                key={source.connectorId ?? source.type}
                className="flex flex-wrap justify-between gap-2 border-t border-line pt-2"
              >
                <span className="break-words">
                  {source.connectorId
                    ? `${source.name} · ${providerNames[source.type] ?? source.type}`
                    : (providerNames[source.type] ?? source.name)}
                </span>
                <span className="text-ink-muted">{capabilityLabels[source.state]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ul className="max-h-80 space-y-3 overflow-y-auto text-sm" aria-label="Discovery collections">
        {collections.map((source) => {
          const paged = source.hasMore && !source.scanHasGaps && source.issue === 'limit';
          return (
            <li
              key={`${source.connectorId}/${source.collection}`}
              className="border-t border-line pt-2"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium">
                  {source.connectorName} ·{' '}
                  {source.collection === '__discovery__' ? 'Collection status' : source.collection}
                </span>
                <span
                  className={source.completeness === 'complete' ? 'text-ink-muted' : 'text-warning'}
                >
                  {paged ? 'More pages available' : source.completeness}
                </span>
              </div>
              {source.issue && (
                <p className={`mt-1 text-xs ${paged ? 'text-info' : 'text-warning'}`}>
                  {paged
                    ? 'The latest batch is saved. More pages remain in this scan; this is not a provider failure.'
                    : issues[source.issue]}
                </p>
              )}
              {source.issue && !paged && source.issue !== 'sampling' && (
                <a
                  className="mt-2 inline-block text-xs text-info underline"
                  href={`/w/connectors?connection=${encodeURIComponent(source.connectorId)}`}
                >
                  Review {source.connectorName} connection
                </a>
              )}
              <p className="mt-1 text-xs text-ink-muted">
                Last attempt {formatAbsoluteTime(source.attemptedAt)}
              </p>
            </li>
          );
        })}
      </ul>
      {graph.conflicts.length > 0 && (
        <p className="mt-3 text-sm text-warning">
          {graph.conflicts.length} identity conflicts remain separate. Relationships with ambiguous
          endpoints are not used as resolved dependencies.
        </p>
      )}
    </details>
  );
}
