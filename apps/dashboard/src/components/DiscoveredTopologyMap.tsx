import { useEffect, useState, type ReactNode } from 'react';
import type { TopologySubject, OperationalTopology } from '@sre/contracts';
import { isTopologyDependency } from '@sre/contracts';
import { topologyMapProjection, mapRelationLabel, type TopologyMapMode } from '../lib/topology-map';
import { useTopologyMapLayout } from '../lib/useTopologyMapLayout';
import { TopologyMapCanvas } from './TopologyMapCanvas';
import { evidenceLabels } from './TopologyEvidence';
import { formatAbsoluteTime } from '../lib/time';
import { datadogEvidenceUrl } from '../lib/datadog-evidence';

const button =
  'rounded-md border border-line-strong px-3 py-2 text-sm font-medium hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-focus';

/** Explore typed relationships without treating resource management as service calls. */
export function DiscoveredTopologyMap({
  subjects,
  relations,
  selected,
  onSelect,
  onClear,
  inspector,
  unresolvedTrafficCount = 0,
}: {
  subjects: TopologySubject[];
  relations: OperationalTopology['relations'];
  selected: string | null;
  onSelect: (key: string) => void;
  onClear: () => void;
  inspector?: ReactNode;
  unresolvedTrafficCount?: number;
}) {
  const [mode, setMode] = useState<TopologyMapMode>(() =>
    relations.some(
      (edge) =>
        isTopologyDependency(edge.kind) &&
        subjects.some((subject) => subject.key === edge.from && subject.kind !== 'service'),
    )
      ? 'traffic'
      : relations.some((edge) => isTopologyDependency(edge.kind))
        ? 'dependencies'
        : 'resources',
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(20);
  const [edgeKey, setEdgeKey] = useState<string | null>(null);
  const [disconnectedSearch, setDisconnectedSearch] = useState('');
  useEffect(() => {
    if (selected && subjects.find((subject) => subject.key === selected)?.kind !== 'service')
      setMode((previous) => (previous === 'dependencies' ? 'traffic' : previous));
    setLimit(20);
    setEdgeKey(null);
  }, [selected]);
  const model = topologyMapProjection(subjects, relations, {
    mode,
    expanded,
    focus: selected,
    limit,
  });
  const result = useTopologyMapLayout(model);
  const edge = model.edges.find((item) => item.key === edgeKey);
  const expandedExists = model.groups.some((group) => group.key === expanded);
  useEffect(() => {
    if (expanded && !expandedExists) setExpanded(null);
    if (edgeKey && !edge) setEdgeKey(null);
  }, [expanded, expandedExists, edgeKey, edge?.key]);
  const identities = new Map(subjects.map((subject) => [subject.key, subject]));
  const endpoint = (key: string) => {
    const subject = identities.get(key);
    if (!subject) return <span className="text-warning">Resource no longer available</span>;
    const scope = Object.entries(subject.scope)
      .map(([name, value]) => `${name}: ${value}`)
      .join(' · ');
    return (
      <button className="block min-w-0 text-left text-accent" onClick={() => onSelect(key)}>
        <span className="font-medium underline">{subject.name}</span>
        <span className="block break-words text-xs text-ink-muted">
          {subject.kind} · {scope || 'Scope not reported'}
        </span>
      </button>
    );
  };
  const openGroup = (key: string) => {
    setExpanded(key);
    setLimit(20);
    setEdgeKey(null);
    onClear();
  };
  const reset = () => {
    setExpanded(null);
    setLimit(20);
    setEdgeKey(null);
    onClear();
  };
  const disconnected = model.disconnected.filter((node) =>
    [node.name, node.scope].join(' ').toLowerCase().includes(disconnectedSearch.toLowerCase()),
  );
  return (
    <section
      className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface"
      aria-label="Discovered topology map"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-3">
        <div className="flex flex-wrap gap-1" aria-label="Relationship view">
          {(['traffic', 'dependencies', 'resources'] as const).map((value) => (
            <button
              key={value}
              className={`${button} aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent`}
              aria-pressed={mode === value}
              onClick={() => {
                reset();
                setMode(value);
              }}
            >
              {value === 'traffic'
                ? 'Runtime traffic'
                : value === 'dependencies'
                  ? 'Service dependencies'
                  : 'Resource context'}
            </button>
          ))}
        </div>
        {(model.active || selected) && (
          <button className={button} onClick={reset}>
            All groups
          </button>
        )}
      </header>
      <div className="border-b border-line px-4 py-3">
        <h3 className="text-base font-medium">
          {model.focused
            ? `${model.focused.name} · direct relationships`
            : model.active
              ? `${model.active.name} · resource relationships`
              : mode === 'traffic'
                ? 'Observed runtime traffic'
                : mode === 'dependencies'
                  ? 'Service dependencies'
                  : 'Topology overview'}
        </h3>
        <p className="mt-1 text-xs text-ink-muted">
          {model.active
            ? model.active.scope
            : mode === 'traffic'
              ? 'Caller → destination. Workloads and endpoints keep their types; routing metadata does not prove which replica handled a request.'
              : mode === 'dependencies'
                ? 'Service → dependency. Calls and declared dependencies retain their evidence type.'
                : 'Deployment, runtime, source and monitoring relationships. These are not service calls.'}
        </p>
        <p className="mt-1 text-xs text-ink-muted">
          {model.nodes.length} visible{' '}
          {mode === 'traffic'
            ? 'components / endpoints'
            : mode === 'dependencies'
              ? 'services'
              : 'resources / groups'}{' '}
          · {model.edges.length} visible connections
          {model.internal > 0 ? ` · ${model.internal} relationships inside collapsed groups` : ''}
        </p>
      </div>
      <div
        className={`grid min-w-0 items-start ${inspector || edge ? 'lg:grid-cols-[minmax(0,1fr)_minmax(18rem,20rem)]' : ''}`}
      >
        <div className="min-w-0">
          {selected && !model.focused ? (
            <p role="status" className="p-6 text-sm text-warning">
              This resource is outside the current view or is no longer available. Return to the
              overview or change the filters.
            </p>
          ) : !model.nodes.length ? (
            <div className="space-y-3 p-8">
              <h4 className="font-semibold">
                {mode === 'traffic'
                  ? 'No resolved traffic in this view'
                  : mode === 'dependencies'
                    ? 'No dependency relationships in this view'
                    : 'No connected resources in this view'}
              </h4>
              <p className="max-w-xl text-sm text-ink-muted">
                {mode === 'traffic'
                  ? unresolvedTrafficCount > 0
                    ? `${unresolvedTrafficCount} sampled relationships lack time-valid endpoint identity. A new connection needs another inventory observation; missing or ambiguous endpoints remain unresolved. Review discovery coverage for gaps.`
                    : 'Review discovery coverage and the current filters. Optional Datadog traffic discovery uses request logs and time-valid Kubernetes inventory. Missing evidence does not prove there is no traffic.'
                  : mode === 'dependencies'
                    ? 'Discovered workloads and deployment links do not establish service dependencies. Change filters or review discovery coverage for call evidence and dependency declarations.'
                    : 'Other discovered groups are listed below. Open a group to inspect its internal relationships. Missing links do not prove independence.'}
              </p>
              {mode === 'dependencies' && (
                <button
                  className={button}
                  onClick={() => {
                    reset();
                    setMode('resources');
                  }}
                >
                  Explore resource context
                </button>
              )}
            </div>
          ) : result?.error ? (
            <p role="alert" className="p-6 text-sm text-warning">
              The map could not be laid out. Use List to inspect the same resources and evidence.
            </p>
          ) : result?.layout ? (
            <TopologyMapCanvas
              model={model}
              layout={result.layout}
              selected={selected}
              edgeKey={edgeKey}
              onNode={(node) => (node.group ? openGroup(node.key) : onSelect(node.key))}
              onEdge={(item) => setEdgeKey(item.key)}
            />
          ) : (
            <div
              role="status"
              className="flex h-[35rem] items-center justify-center text-sm text-ink-muted"
            >
              Arranging connected resources…
            </div>
          )}
          {(model.more > 0 || model.omitted > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-3 text-sm">
              <p className="text-ink-muted">
                {model.more} more connected resources / groups · {model.omitted} connections extend
                beyond this view
              </p>
              {model.more > 0 && (
                <button className={button} onClick={() => setLimit((value) => value + 20)}>
                  Show more connected resources
                </button>
              )}
            </div>
          )}
          <div
            className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line p-3 text-xs text-ink-muted"
            aria-label="Relationship evidence legend"
          >
            <span>— Observed / provider reference</span>
            <span>– – Declared</span>
            <span>··· Inferred</span>
            <span>Faded edge: all evidence stale</span>
          </div>
        </div>
        {(inspector || edge) && (
          <aside
            className="min-w-0 space-y-3 border-t border-line bg-surface-subtle p-3 lg:max-h-[48rem] lg:overflow-y-auto lg:border-l lg:border-t-0"
            aria-label="Topology inspector"
          >
            {edge && (
              <section
                className="space-y-3 rounded-lg border border-line bg-surface p-4 text-sm"
                aria-label="Map relationship details"
              >
                <div className="flex items-start justify-between gap-3">
                  <h4 className="font-semibold">
                    {mapRelationLabel(edge.kind)} · {evidenceLabels[edge.evidence]}
                  </h4>
                  <button className="text-accent underline" onClick={() => setEdgeKey(null)}>
                    Close
                  </button>
                </div>
                <p className="text-xs text-ink-muted">
                  {edge.relations.length} underlying relationships
                  {edge.staleCount ? ` · ${edge.staleCount} stale` : ''}. Open a resource to inspect
                  the source evidence.
                </p>
                <ul className="max-h-72 space-y-3 overflow-y-auto">
                  {edge.relations.map((relation, index) => (
                    <li key={index} className="break-words">
                      {endpoint(relation.from)}
                      <p className="my-1 text-xs text-ink-muted">
                        ↓ {mapRelationLabel(relation.kind)}
                      </p>
                      {endpoint(relation.to)}
                      {relation.attributes?.parser && (
                        <p className="mt-2 text-xs text-ink-muted">
                          {relation.attributes.parser} ·{' '}
                          {relation.attributes.outcome === 'response_recorded'
                            ? 'Response recorded'
                            : 'Connection attempt recorded'}
                          {relation.observedAt
                            ? ` · Last observed ${formatAbsoluteTime(relation.observedAt)}`
                            : ''}
                          <span className="block">
                            Sampled log evidence, not total traffic or availability.
                          </span>
                        </p>
                      )}
                      {relation.stale && (
                        <span className="block text-xs text-warning">Stale evidence</span>
                      )}
                      {datadogEvidenceUrl(relation.attributes) && (
                        <a
                          className="mt-1 block text-xs text-accent underline"
                          target="_blank"
                          rel="noopener noreferrer"
                          href={datadogEvidenceUrl(relation.attributes)!}
                        >
                          Open Datadog log evidence
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {inspector}
          </aside>
        )}
      </div>
      {model.disconnected.length > 0 && (
        <details className="border-t border-line p-4">
          <summary className="cursor-pointer text-sm font-medium">
            {mode !== 'resources' ? 'Without dependency relationships' : 'Other discovered groups'}{' '}
            · {model.disconnected.length}{' '}
            {mode === 'traffic'
              ? 'components / endpoints'
              : mode === 'dependencies'
                ? 'services'
                : 'groups'}
          </summary>
          <p className="mt-2 text-xs text-ink-muted">
            {mode !== 'resources'
              ? 'Subjects with no recorded calls or dependency declarations in this view. Missing evidence does not prove isolation.'
              : 'Groups without cross-scope links in the overview. Open a group to inspect its resources and internal relationships.'}
          </p>
          <input
            type="search"
            aria-label="Search other discovered resources"
            value={disconnectedSearch}
            onChange={(event) => setDisconnectedSearch(event.target.value)}
            placeholder="Find a resource or scope"
            className="sre-field mt-3 w-full"
          />
          <ul className="mt-3 grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
            {disconnected.map((node) => (
              <li key={node.key}>
                <button
                  className={`${button} w-full text-left`}
                  onClick={() => (node.group ? openGroup(node.key) : onSelect(node.key))}
                >
                  <span className="block">{node.name}</span>
                  <span className="block break-words text-xs text-ink-muted">{node.scope}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
