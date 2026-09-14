import { useEffect, useMemo, useRef, useState } from 'react';
import type { TopologyDiscoveryGraph, TopologyGraph } from '../lib/topology';
import { TopologyDiscoveryCoverage } from './TopologyEvidence';
import { TopologySubjectDetail } from './TopologySubjectDetail';
import { StatePanel } from './PageState';
import { TopologySubjectImpact, type TopologyAccess } from './TopologySubjectImpact';
import { TopologySubjectRuntime } from './TopologySubjectRuntime';
import { TopologyEndpointEvidence } from './TopologyEndpointEvidence';
import { TopologyIncidentSelection } from './TopologyIncidentSelection';
import { DiscoveredTopologyMap } from './DiscoveredTopologyMap';

const field =
  'mt-1 block w-full min-w-0 rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink';
const pageSize = 20;

/** Explore collected identities without requiring a service catalog or manual runtime mapping. */
export function TopologyExplorer({
  graph,
  loading,
  error,
  onRefresh,
  access,
  incidentGraph,
}: {
  graph?: TopologyDiscoveryGraph;
  loading: boolean;
  error: boolean;
  onRefresh: () => void;
  access?: TopologyAccess;
  incidentGraph?: TopologyGraph;
}) {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [source, setSource] = useState('');
  const [scope, setScope] = useState('');
  const [page, setPage] = useState(0);
  const [view, setView] = useState<'map' | 'list'>(() =>
    new URLSearchParams(window.location.search).get('view') === 'list' ? 'list' : 'map',
  );
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('subject'),
  );
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selected) url.searchParams.set('subject', selected);
    else url.searchParams.delete('subject');
    url.searchParams.set('view', view);
    window.history.replaceState(window.history.state, '', url);
  }, [selected, view]);
  const results = useRef<HTMLDivElement>(null);
  const resultList = useRef<HTMLUListElement>(null);
  const subjects = graph?.operational.subjects ?? [];
  const options = useMemo(
    () => ({
      kinds: [...new Set(subjects.map((subject) => subject.kind))].sort(),
      sources: [
        ...new Map(
          subjects.flatMap((subject) =>
            subject.sources.map((item) => [item.connectorId, item.connectorName] as const),
          ),
        ).entries(),
      ].sort((a, b) => a[1].localeCompare(b[1])),
      scopes: [
        ...new Set(
          subjects.flatMap((subject) =>
            Object.entries(subject.scope).map((pair) => JSON.stringify(pair)),
          ),
        ),
      ].sort(),
    }),
    [subjects],
  );
  const filtered = subjects.filter((subject) => {
    const scopePair = scope ? (JSON.parse(scope) as [string, string]) : null;
    return (
      (!kind || subject.kind === kind) &&
      (!source || subject.sources.some((item) => item.connectorId === source)) &&
      (!scopePair || subject.scope[scopePair[0]] === scopePair[1]) &&
      [subject.name, subject.kind, ...Object.values(subject.scope)]
        .join(' ')
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    );
  });
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  useEffect(() => {
    const index = filtered.findIndex((item) => item.key === selected);
    if (index >= 0 && Math.floor(index / pageSize) !== currentPage) {
      setPage(Math.floor(index / pageSize));
    }
  }, [selected, Boolean(graph)]);
  useEffect(() => {
    const list = resultList.current;
    const button = list?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!list || !button) return;
    const bounds = list.getBoundingClientRect(),
      target = button.getBoundingClientRect();
    if (target.top < bounds.top) list.scrollTop += target.top - bounds.top;
    else if (target.bottom > bounds.bottom) list.scrollTop += target.bottom - bounds.bottom;
  }, [selected, graph, currentPage]);
  const subject = selected ? subjects.find((item) => item.key === selected) : null;
  const filterChanged = () => {
    setPage(0);
    setSelected(null);
  };
  const clearFilters = () => {
    setSearch('');
    setKind('');
    setSource('');
    setScope('');
    filterChanged();
  };
  const selectRelated = (key: string) => {
    const candidates = filtered.some((item) => item.key === key) ? filtered : subjects;
    if (candidates === subjects) clearFilters();
    setPage(Math.max(0, Math.floor(candidates.findIndex((item) => item.key === key) / pageSize)));
    setSelected(key);
  };

  const inspector =
    subject && graph ? (
      <TopologySubjectDetail
        key={subject.key}
        preserveMap={view === 'map'}
        graph={graph}
        subject={subject}
        onSelect={selectRelated}
        onBack={() => {
          setSelected(null);
          results.current?.focus();
        }}
        impact={
          access && (
            <TopologySubjectImpact
              graph={graph}
              subject={subject}
              access={access}
              onSelect={selectRelated}
            />
          )
        }
        runtime={
          access &&
          (subject.kind === 'endpoint' ? (
            <TopologyEndpointEvidence key={subject.key} subjectKey={subject.key} access={access} />
          ) : (
            <TopologySubjectRuntime subject={subject} access={access} />
          ))
        }
      />
    ) : undefined;

  return (
    <section className="min-w-0 space-y-4" aria-label="Automatic topology discovery">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Discovered topology</h2>
          {graph && (
            <p className="mt-1 text-xs text-ink-muted">
              {subjects.length} subjects · {graph.operational.relations.length} resolved
              relationships · Collected automatically
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={onRefresh}
          className="rounded-md border border-line-strong px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          Refresh view
        </button>
      </div>
      {loading && !graph && (
        <StatePanel state="loading" title="Loading topology…" skeleton="topology" />
      )}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-warning-line bg-warning-soft p-3 text-sm text-warning"
        >
          {graph
            ? 'Refresh failed. Showing the last successful discovery snapshot.'
            : 'Failed to load topology. Retry using Refresh view.'}
        </p>
      )}
      {!loading && !error && !subjects.length && (
        <div className="rounded-lg border border-line bg-surface p-5">
          <h3 className="font-semibold">No discovery evidence yet</h3>
          <p className="mt-2 max-w-2xl text-sm text-ink-muted">
            Supported inventory sources are collected in the background. No manual mapping is
            required. Check connection access and discovery coverage if evidence is missing.
          </p>
          <a
            href="/w/connectors"
            className="mt-3 inline-block text-sm font-medium text-info underline"
          >
            Review connections
          </a>
        </div>
      )}
      {graph && <TopologyDiscoveryCoverage graph={graph} />}
      {graph && access && incidentGraph && (
        <details
          className="rounded-lg border border-line p-3"
          open={new URLSearchParams(window.location.search).has('incident') || undefined}
        >
          <summary className="cursor-pointer text-sm font-medium">Incident overlay</summary>
          <div className="mt-3">
            <TopologyIncidentSelection
              graph={incidentGraph}
              access={access}
              onSelect={selectRelated}
              onRefresh={onRefresh}
            />
          </div>
        </details>
      )}
      {subjects.length > 0 && graph && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              className="inline-flex rounded-md border border-line-strong p-1"
              aria-label="Topology view"
            >
              {(['map', 'list'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={view === value}
                  onClick={() => setView(value)}
                  className="rounded px-4 py-2 text-sm font-medium aria-pressed:bg-accent-soft aria-pressed:text-accent focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {value === 'map' ? 'Map' : 'List'}
                </button>
              ))}
            </div>
            {view === 'map' && (search || kind || source || scope) && (
              <button type="button" onClick={clearFilters} className="text-sm text-info underline">
                Clear filters
              </button>
            )}
          </div>
          <div className="grid min-w-0 gap-3 rounded-lg border border-line bg-surface-subtle p-3 sm:grid-cols-2 xl:grid-cols-[2fr_1fr_1fr_1.5fr]">
            <label className="min-w-0 text-xs font-medium text-ink-muted">
              Search discovered topology
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  filterChanged();
                }}
                className={field}
                placeholder="Service, workload, repository or scope"
              />
            </label>
            <label className="min-w-0 text-xs font-medium text-ink-muted">
              Kind
              <select
                aria-label="Kind"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value);
                  filterChanged();
                }}
                className={field}
              >
                <option value="">All kinds</option>
                {options.kinds.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="min-w-0 text-xs font-medium text-ink-muted">
              Connection
              <select
                aria-label="Connection"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  filterChanged();
                }}
                className={field}
              >
                <option value="">All connections</option>
                {options.sources.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 text-xs font-medium text-ink-muted">
              Scope
              <select
                aria-label="Scope"
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value);
                  filterChanged();
                }}
                className={field}
              >
                <option value="">All scopes (identities remain separate)</option>
                {options.scopes.map((value) => (
                  <option key={value} value={value}>
                    {(JSON.parse(value) as string[]).join(': ')}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {view === 'map' && (
            <DiscoveredTopologyMap
              key={JSON.stringify([search, kind, source, scope])}
              subjects={filtered}
              relations={graph.operational.relations}
              unresolvedTrafficCount={
                graph.relations.filter(
                  (relation) => relation.kind === 'calls' && (!relation.fromKey || !relation.toKey),
                ).length
              }
              selected={selected}
              onSelect={selectRelated}
              onClear={() => setSelected(null)}
              inspector={inspector}
            />
          )}
          <div
            className={`grid min-w-0 items-start gap-4 ${view === 'list' ? 'lg:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]' : ''}`}
          >
            {view === 'list' && (
              <div
                ref={results}
                tabIndex={-1}
                aria-label="Discovery results"
                className="min-w-0 rounded-lg border border-line bg-surface"
              >
                <div className="flex flex-wrap justify-between gap-2 border-b border-line px-4 py-3 text-xs text-ink-muted">
                  <span>{filtered.length} matching subjects</span>
                  {(search || kind || source || scope) && (
                    <button type="button" onClick={clearFilters} className="text-info underline">
                      Clear filters
                    </button>
                  )}
                </div>
                {!filtered.length && (
                  <p className="p-4 text-sm text-ink-muted">No subjects match these filters.</p>
                )}
                <ul
                  ref={resultList}
                  className="max-h-[28rem] divide-y divide-line overflow-y-auto"
                  aria-label="Discovered subjects"
                >
                  {visible.map((item) => {
                    const sourceCount = new Set(item.sources.map((entry) => entry.connectorId))
                      .size;
                    const sourceNames = [
                      ...new Set(item.sources.map((entry) => entry.connectorName)),
                    ].join(' · ');
                    return (
                      <li key={item.key}>
                        <button
                          type="button"
                          aria-pressed={item.key === selected}
                          onClick={() => setSelected(item.key)}
                          className="w-full min-w-0 border-l-2 border-transparent px-4 py-3 text-left hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-focus aria-pressed:border-accent aria-pressed:bg-accent-soft"
                        >
                          <span className="block break-words text-sm font-semibold">
                            {item.name}
                          </span>
                          <span className="mt-1 block break-words text-xs text-ink-muted">
                            {item.kind} ·{' '}
                            {Object.entries(item.scope)
                              .map(([key, value]) => `${key}: ${value}`)
                              .join(' · ') || 'Scope not reported'}
                          </span>
                          <span
                            className={`mt-1 block text-xs ${item.stale ? 'text-warning' : 'text-ink-muted'}`}
                          >
                            {sourceNames} ·{' '}
                            {item.stale
                              ? 'Stale evidence'
                              : `${sourceCount} evidence ${sourceCount === 1 ? 'source' : 'sources'}`}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {filtered.length > pageSize && (
                  <nav
                    aria-label="Discovery result pages"
                    className="flex items-center justify-between gap-2 border-t border-line p-3 text-xs"
                  >
                    <button
                      type="button"
                      disabled={currentPage === 0}
                      onClick={() => setPage(currentPage - 1)}
                      className="px-2 py-2 text-info disabled:text-ink-muted disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <span>
                      {currentPage + 1} / {Math.ceil(filtered.length / pageSize)}
                    </span>
                    <button
                      type="button"
                      disabled={(currentPage + 1) * pageSize >= filtered.length}
                      onClick={() => setPage(currentPage + 1)}
                      className="px-2 py-2 text-info disabled:text-ink-muted disabled:opacity-50"
                    >
                      Next
                    </button>
                  </nav>
                )}
              </div>
            )}
            {subject ? (
              view === 'list' ? (
                inspector
              ) : null
            ) : view === 'list' ? (
              <div className="rounded-lg border border-dashed border-line-strong p-6 text-sm text-ink-muted">
                <h3 className="font-semibold text-ink">
                  {selected
                    ? 'This subject is no longer in the current discovery.'
                    : 'Select a subject to follow its relationships'}
                </h3>
                <p className="mt-2">
                  Inspect runtime ownership, deployment sources and observed calls with their
                  evidence. Similar names alone do not join services across environments or
                  clusters.
                </p>
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
