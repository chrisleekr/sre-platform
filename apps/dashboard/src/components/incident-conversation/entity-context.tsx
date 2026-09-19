import { checkResponse, requestErrorMessage } from '../../lib/request-error';
import type { CredentialGetter } from '../../lib/request-credentials';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SignalSource } from '@sre/contracts';
import { config } from '../../config';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { formatAbsoluteTime } from '../../lib/time';
import type { IncidentWorkspaceData } from '../../lib/types';
import { IncidentTopologyMatches } from './topology-context';

interface CatalogService {
  name: string;
  team: string | null;
  criticality: string | null;
}

export function EntityContextPanel({
  workspace,
  getCredentials,
  onChanged,
}: {
  workspace: IncidentWorkspaceData;
  getCredentials: CredentialGetter;
  onChanged: () => void;
}) {
  const context = workspace.entityContext;
  const candidates = useMemo(
    () => [
      ...new Map(
        (context?.observations ?? [])
          .flatMap((observation) => observation.candidates)
          .map((candidate) => [candidate.key, candidate]),
      ).values(),
    ],
    [context],
  );
  const sources = useMemo(() => {
    const latest = new Map<string, SignalSource>();
    for (const observation of context?.observations ?? []) {
      const source = observation.source;
      if (!source) continue;
      const key = JSON.stringify([source.provider, source.dataSourceId, source.externalId]);
      const current = latest.get(key);
      if (!current || source.observedAt > current.observedAt) latest.set(key, source);
    }
    return [...latest.values()];
  }, [context]);
  const [services, setServices] = useState<CatalogService[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [serviceName, setServiceName] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing || services.length > 0) return;
    void authenticatedFetch(`${config.apiBaseUrl}/topology/services`, getCredentials)
      .then(async (response) => {
        await checkResponse(response, 'catalog unavailable');
        const body = (await response.json()) as { services?: CatalogService[] };
        setServices(body.services ?? []);
      })
      .catch(() => setError('Service catalog could not be loaded.'));
  }, [editing, getCredentials, services.length]);

  if (
    !context ||
    (sources.length === 0 &&
      candidates.length === 0 &&
      context.services.length === 0 &&
      context.capabilityGaps.length === 0)
  )
    return null;

  const mappings = new Map(context.mappings.map((mapping) => [mapping.candidateKey, mapping]));
  async function saveMapping() {
    if (!editing || !serviceName || !reason.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/incidents/${workspace.incident.id}/entity-mapping`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ candidateKey: editing, serviceName, rationale: reason.trim() }),
        },
      );
      await checkResponse(response, 'Entity mapping could not be confirmed. Refresh and retry.');
      setEditing(null);
      setServiceName('');
      setReason('');
      onChanged();
    } catch (cause) {
      setError(
        requestErrorMessage(
          cause,
          'Entity mapping could not be confirmed. Review the catalog service and try again.',
        ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="entity-context-title"
      className="min-w-0 rounded-lg border border-line bg-surface p-4"
    >
      <h2 id="entity-context-title" className="font-medium text-ink">
        Affected entity
      </h2>
      <IncidentTopologyMatches context={context.topology} />
      {context.mappings.some((mapping) => mapping.candidateKey.startsWith('incident-service:')) && (
        <p className="mt-2 text-sm text-info">
          A responder assigned this incident to{' '}
          {context.services.map((service) => service.name).join(', ')}. These assignments take
          precedence over provider candidates.{' '}
          <Link
            className="underline"
            to={`/w/topology?incident=${encodeURIComponent(workspace.incident.id)}`}
          >
            Edit affected services
          </Link>
        </p>
      )}
      <p className="mt-1 text-xs text-ink-muted">
        Producers are shown separately from resources that may be affected. Confirm mappings before
        treating ownership or code as fact.
      </p>

      <div className="mt-3 space-y-2">
        {sources.map((source) => (
          <div
            key={JSON.stringify([source.provider, source.dataSourceId, source.externalId])}
            className="rounded border border-line p-3 text-xs"
          >
            <span className="font-semibold text-ink">Source</span>{' '}
            <span className="text-ink-secondary">{source.displayName}</span>
            <p className="mt-1 text-ink-muted">
              {source.provider} · {source.kind.replaceAll('_', ' ')} ·{' '}
              {formatAbsoluteTime(source.observedAt)}
            </p>
          </div>
        ))}
      </div>

      <ul className="mt-3 space-y-2" aria-label="Affected entity candidates">
        {candidates.map((candidate) => {
          const mapping = mappings.get(candidate.key);
          const isEditing = editing === candidate.key;
          return (
            <li key={candidate.key} className="rounded border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="mr-2 rounded bg-assessment-soft px-2 py-0.5 text-[10px] font-semibold uppercase text-assessment">
                    {candidate.kind}
                  </span>
                  <span className="break-words font-semibold text-ink">
                    {candidate.displayName}
                  </span>
                </div>
                <span className="text-xs text-ink-muted">{candidate.confidence}% confidence</span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                {candidate.provenance.kind.replaceAll('_', ' ')}: {candidate.provenance.source} ·{' '}
                {candidate.completeness} · {formatAbsoluteTime(candidate.observedAt)}
              </p>
              <p className="mt-1 break-all font-mono text-[11px] text-ink-muted">
                Identity: {candidate.stableId}
              </p>
              {Object.keys(candidate.scope).length > 0 && (
                <p className="mt-1 break-words text-xs text-ink-muted">
                  Scope:{' '}
                  {Object.entries(candidate.scope)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, value]) => `${key}=${value}`)
                    .join(' · ')}
                </p>
              )}
              {mapping ? (
                <p className="mt-2 text-xs text-positive">
                  Catalog service: <strong>{mapping.serviceName}</strong> ·{' '}
                  {mapping.method === 'human' ? 'human confirmed' : 'exact catalog match'}
                </p>
              ) : (
                <p className="mt-2 text-xs text-warning">No catalog service mapping</p>
              )}
              {!isEditing ? (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(candidate.key);
                    setServiceName(mapping?.serviceName ?? '');
                    setReason('');
                    setError(null);
                  }}
                  className="sre-action mt-2 min-h-9 text-xs"
                >
                  {mapping ? 'Correct mapping' : 'Map to service'}
                </button>
              ) : (
                <div className="mt-3 grid gap-2">
                  <label className="text-xs font-medium text-ink-secondary">
                    Catalog service
                    <select
                      value={serviceName}
                      onChange={(event) => setServiceName(event.target.value)}
                      className="sre-field mt-1 min-h-10 w-full"
                    >
                      <option value="">Select a service</option>
                      {services.map((service) => (
                        <option key={service.name} value={service.name}>
                          {service.name}
                          {service.team ? ` · ${service.team}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-medium text-ink-secondary">
                    Why is this mapping correct?
                    <input
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      maxLength={1_000}
                      className="sre-field mt-1 min-h-10 w-full"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={!serviceName || !reason.trim() || pending}
                      onClick={() => void saveMapping()}
                      className="sre-action sre-action-primary min-h-9 text-xs"
                    >
                      {pending ? 'Saving…' : 'Save mapping'}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setEditing(null)}
                      className="min-h-9 rounded border border-line-strong px-3 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {context.services.map((service) => (
        <div
          key={service.name}
          className="mt-3 rounded border border-positive-line bg-positive-soft p-3 text-xs"
        >
          <p className="font-semibold text-positive">{service.name}</p>
          <p className="mt-1 text-ink-secondary">
            Owner: {service.team ?? 'not assigned'} · Criticality:{' '}
            {service.criticality ?? 'not set'}
          </p>
          <p className="mt-1 text-ink-muted">
            {service.dependencies.length} dependencies · {service.repositories.length} repositories
            · {service.deployments.length} recent deployments · {service.runbooks.length} runbooks
          </p>
          {(service.dependencies.length > 0 ||
            service.repositories.length > 0 ||
            service.deployments.length > 0 ||
            service.runbooks.length > 0) && (
            <details className="mt-2 text-ink-secondary">
              <summary className="cursor-pointer font-semibold">View resolved context</summary>
              <div className="mt-2 space-y-2">
                {service.dependencies.length > 0 && (
                  <div>
                    <p className="font-semibold">Dependencies</p>
                    <ul className="mt-1 list-disc pl-4">
                      {service.dependencies.map((dependency) => (
                        <li
                          key={`${dependency.direction}:${dependency.service}:${dependency.protocol ?? ''}`}
                        >
                          {dependency.direction} · {dependency.service}
                          {dependency.protocol ? ` · ${dependency.protocol}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {service.repositories.length > 0 && (
                  <div>
                    <p className="font-semibold">Repositories</p>
                    <ul className="mt-1 list-disc pl-4">
                      {service.repositories.map((repository) => (
                        <li
                          key={`${repository.provider}:${repository.fullName}:${repository.path}`}
                        >
                          {repository.provider} · {repository.fullName}
                          {repository.path ? ` · ${repository.path}` : ''}
                          {repository.confirmed ? ' · confirmed' : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {service.deployments.length > 0 && (
                  <div>
                    <p className="font-semibold">Recent deployments</p>
                    <ul className="mt-1 list-disc pl-4">
                      {service.deployments.map((deployment) => (
                        <li
                          key={`${deployment.source}:${deployment.repository}:${deployment.revision}:${deployment.deployedAt}`}
                        >
                          {deployment.source} · {deployment.repository} ·{' '}
                          {deployment.revision.slice(0, 12)} · {deployment.status}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {service.runbooks.length > 0 && (
                  <div>
                    <p className="font-semibold">Runbooks</p>
                    <ul className="mt-1 list-disc pl-4">
                      {service.runbooks.map((runbook) => (
                        <li key={runbook.id}>
                          {runbook.title ?? runbook.source}
                          {runbook.verified ? ' · verified' : ' · unverified'}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      ))}

      {context.capabilityGaps.length > 0 && (
        <div className="mt-3 rounded border border-warning-line bg-warning-soft p-3 text-xs text-warning">
          <p className="font-semibold">Evidence access gaps</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {context.capabilityGaps.map((gap) => (
              <li key={`${gap.entityKey}:${gap.capability}`}>
                {gap.summary}{' '}
                <Link to={gap.action.href} className="font-semibold underline">
                  {gap.action.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-critical">
          {error}
        </p>
      )}
    </section>
  );
}
