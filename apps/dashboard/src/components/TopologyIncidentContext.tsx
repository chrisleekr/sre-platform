import type { CredentialGetter } from '../lib/request-credentials';
import { topologyIncidentTitle, type TopologyGraph, type TopologyIncident } from '../lib/topology';
import { TopologyIncidentMapping } from './TopologyIncidentMapping';

/** Incident selection stays separate from inferred impact and offers direct identity recovery. */
export function TopologyIncidentContext({
  incident,
  services,
  graph,
  apiBaseUrl,
  getCredentials,
  onSaved,
  onSelect,
}: {
  incident: TopologyIncident;
  services: string[];
  graph: TopologyGraph;
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  onSaved: () => void;
  onSelect: (name: string) => void;
}) {
  return (
    <section
      aria-label="Selected incident context"
      className="rounded-md border border-line bg-surface p-3 text-sm text-ink-secondary"
    >
      <p className="font-semibold">
        {incident.severity.toUpperCase()} · {incident.status} ·{' '}
        {services.length ? services.join(', ') : 'Affected service not linked'}
      </p>
      <p>{topologyIncidentTitle(incident)}</p>
      <TopologyIncidentMapping
        key={incident.id}
        incidentId={incident.id}
        services={services}
        graph={graph}
        apiBaseUrl={apiBaseUrl}
        getCredentials={getCredentials}
        onSaved={onSaved}
      />
      {!services.length && (
        <p className="mt-2 text-xs">
          Dependency impact is unavailable until an affected service is linked. The incident
          conversation and evidence are still available.
        </p>
      )}
      {services.length > 1 && (
        <div className="mt-2">
          <p>Choose an affected service to inspect its impact:</p>
          {services.map((name) => (
            <button
              key={name}
              type="button"
              className="sre-hit-target mr-3 underline"
              onClick={() => onSelect(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <a className="mt-2 inline-block text-accent underline" href={`/w/incidents/${incident.id}`}>
        Open incident
      </a>
    </section>
  );
}
