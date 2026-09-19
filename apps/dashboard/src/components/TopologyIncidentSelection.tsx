import { useState } from 'react';
import type { TopologyIncidentSelection as Selection } from '@sre/contracts';
import { topologyIncidentTitle, type TopologyGraph } from '../lib/topology';
import { useFetchResource } from '../lib/useFetchResource';
import type { TopologyAccess } from './TopologySubjectImpact';
import { TopologyIncidentMapping } from './TopologyIncidentMapping';

const select = (body: unknown) => body as Selection;
const field =
  'mt-1 block w-full min-w-0 rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink';

/** Inspect scoped incident matches without requiring catalog assignments or guessing service names. */
export function TopologyIncidentSelection({
  graph,
  access,
  onSelect,
  onRefresh,
}: {
  graph: TopologyGraph;
  access: TopologyAccess;
  onSelect: (key: string) => void;
  onRefresh: () => void;
}) {
  const [incidentId, setIncidentId] = useState(
    () => new URLSearchParams(window.location.search).get('incident') ?? '',
  );
  const incidents = graph.incidents ?? [];
  const incident = incidents.find((item) => item.id === incidentId);
  return (
    <section
      aria-label="Incident scope"
      className="min-w-0 rounded-lg border border-line bg-surface p-3"
    >
      <label className="block min-w-0 text-xs font-medium text-ink-muted">
        Incident scope
        <select
          className={field}
          value={incidentId}
          onChange={(event) => {
            const id = event.target.value;
            setIncidentId(id);
            const url = new URL(window.location.href);
            if (id) url.searchParams.set('incident', id);
            else url.searchParams.delete('incident');
            window.history.replaceState({}, '', url);
          }}
        >
          <option value="">Explore all topology</option>
          {incidentId && !incident && (
            <option value={incidentId}>Previously selected incident</option>
          )}
          {incidents.map((item) => (
            <option key={item.id} value={item.id}>
              {item.severity.toUpperCase()} · {topologyIncidentTitle(item)} · {item.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      {!incidentId && (
        <p className="mt-2 text-xs text-ink-muted">
          Choose an active incident to inspect its exact topology matches and known dependency
          paths.
        </p>
      )}
      {incidentId && (
        <SelectedIncident
          key={incidentId}
          incidentId={incidentId}
          graph={graph}
          access={access}
          onSelect={onSelect}
          onRefresh={onRefresh}
        />
      )}
    </section>
  );
}

function SelectedIncident({
  incidentId,
  graph,
  access,
  onSelect,
  onRefresh,
}: {
  incidentId: string;
  graph: TopologyGraph;
  access: TopologyAccess;
  onSelect: (key: string) => void;
  onRefresh: () => void;
}) {
  const [nonce, setNonce] = useState(0);
  const { data, loading, error, errorStatus } = useFetchResource<Selection | null>({
    ...access,
    path: `/topology/incidents/${encodeURIComponent(incidentId)}/context`,
    initial: null,
    select,
    pollMs: 30000,
    nonce,
  });
  const refresh = () => {
    setNonce((value) => value + 1);
    onRefresh();
  };
  const selected = data?.incidentId === incidentId ? data : null;
  const resolved = new Set(
    selected?.topology.resolutions.flatMap((item) =>
      item.status === 'resolved' && item.subjectKey ? [item.subjectKey] : [],
    ) ?? [],
  );
  const possible = new Set(
    selected?.topology.resolutions.flatMap((item) => item.candidateSubjectKeys) ?? [],
  );
  const matches =
    selected?.topology.subjects.filter(
      (subject) => resolved.has(subject.key) || possible.has(subject.key),
    ) ?? [];
  const unresolved = selected?.topology.resolutions.some((item) => item.status !== 'resolved');
  return (
    <div className="mt-3 border-l-2 border-accent pl-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          className="font-medium text-accent underline"
          href={`/w/incidents/${encodeURIComponent(incidentId)}`}
        >
          Open incident
        </a>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-xs text-accent underline disabled:opacity-50"
        >
          Refresh incident matches
        </button>
      </div>
      {loading && !selected && (
        <p className="mt-2 text-ink-muted" role="status">
          Finding topology matches…
        </p>
      )}
      {error && (
        <p className="mt-2 text-warning" role="alert">
          {errorStatus === 404
            ? 'This incident is unavailable in this workspace. Choose another incident.'
            : errorStatus === 403
              ? 'You no longer have access to this incident. Choose another incident or ask your workspace administrator.'
              : errorStatus === 429
                ? 'Too many requests. Wait before refreshing incident matches again.'
                : selected
                  ? 'Refresh failed. These are the last successfully loaded matches.'
                  : 'Incident matches could not be loaded. Try refreshing.'}
        </p>
      )}
      {selected && (
        <>
          <p className="mt-2 text-ink-secondary">
            {matches.length
              ? `${resolved.size} matched ${resolved.size === 1 ? 'subject' : 'subjects'}${possible.size ? ` · ${possible.size} possible matches` : ''}. Inspect a subject to see its scope and evidence.`
              : 'No exact topology match yet. The incident evidence remains available; no service was guessed from its conversation.'}
          </p>
          {unresolved && matches.length > 0 && (
            <p className="mt-1 text-xs text-ink-muted">
              Some affected identities remain unresolved. Possible matches are candidates, not
              confirmed impact.
            </p>
          )}
          <ul
            aria-label="Incident topology matches"
            className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2"
          >
            {matches.map((subject) => {
              const present = graph.discovery?.operational.subjects.some(
                (item) => item.key === subject.key,
              );
              return (
                <li key={subject.key} className="min-w-0 rounded-md border border-line p-3">
                  <p className="break-words font-medium">{subject.name}</p>
                  <p className="mt-1 break-words text-xs text-ink-muted">
                    {subject.kind} ·{' '}
                    {Object.entries(subject.scope)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(' · ') || 'Scope not reported'}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {resolved.has(subject.key) ? 'Matched identity' : 'Possible match'}
                    {subject.stale ? ' · Stale evidence' : ''}
                  </p>
                  <button
                    type="button"
                    disabled={!present || error}
                    onClick={() => onSelect(subject.key)}
                    className="mt-2 text-xs font-medium text-accent underline disabled:opacity-50"
                  >
                    Inspect {subject.name}
                  </button>
                  {!present && (
                    <p className="mt-1 text-xs text-warning">
                      Not in the current topology view. Refresh to check its availability.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {!error && (
            <details className="mt-3 text-xs text-ink-muted">
              <summary className="cursor-pointer">Catalog correction</summary>
              <p className="mt-2">
                Optional: explicitly assign a registered service. This overrides provider
                candidates; it is not required to explore discovered topology.
              </p>
              <TopologyIncidentMapping
                incidentId={incidentId}
                services={selected.assignedServices}
                graph={graph}
                {...access}
                onSaved={refresh}
              />
            </details>
          )}
        </>
      )}
    </div>
  );
}
