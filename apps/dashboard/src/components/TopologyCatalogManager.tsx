import type { CredentialGetter } from '../lib/request-credentials';
import { useState } from 'react';
import type { TopologyGraph } from '../lib/topology';
import { deleteTopologyService, saveTopologyService } from '../lib/useTopology';
import { TopologyRelationships } from './TopologyRelationships';
import { SetupDialog } from './SetupDialog';

export function TopologyCatalogManager({
  graph,
  apiBaseUrl,
  getCredentials,
  onSaved,
}: {
  graph: TopologyGraph;
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [serviceName, setServiceName] = useState('');
  const [team, setTeam] = useState('');
  const [criticality, setCriticality] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const registeredService = graph.nodes.find(
    (node) => node.name === serviceName.trim() && node.sources?.includes('catalog'),
  );
  const hasRelationships = graph.edges.some(
    (edge) => edge.upstream === serviceName.trim() || edge.downstream === serviceName.trim(),
  );
  const hasRuntime =
    graph.runtimeBindings?.some((binding) => binding.serviceName === serviceName.trim()) ?? false;

  const save = async (work: () => Promise<void>, success: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(success);
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Topology update failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          setTrigger(event.currentTarget);
          setNotice(null);
          setError(null);
          setConfirmRemove(false);
          setOpen(true);
        }}
        className="sre-action sre-action-primary sre-hit-target"
      >
        Edit catalog
      </button>
      {open && (
        <SetupDialog
          title="Edit service catalog"
          closeLabel="Close"
          busy={busy}
          returnFocusTo={trigger}
          onClose={() => setOpen(false)}
        >
          <p className="text-sm text-ink-muted">
            Register ownership before adding call relationships. Relationships are explicit
            evidence; the platform never infers them from cluster co-location.
          </p>
          {(notice || error) && (
            <p
              role={error ? 'alert' : 'status'}
              className={`mt-3 rounded-md border p-3 text-sm ${error ? 'border-critical-line bg-critical-soft text-critical' : 'border-success-line bg-success-soft text-success'}`}
            >
              {error ?? notice}
            </p>
          )}

          <form
            className="mt-5 rounded-lg border border-line p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const name = serviceName.trim();
              if (!name || busy) return;
              void save(
                () =>
                  saveTopologyService(apiBaseUrl, getCredentials, {
                    name,
                    team: team.trim() || null,
                    criticality: criticality || null,
                  }),
                `${name} is registered in the service catalog.`,
              );
            }}
          >
            <h3 className="font-medium text-ink">Register or update a service</h3>
            <p className="mt-1 text-xs text-ink-muted">
              Choose a registered service or enter a new service name, then add ownership context.
            </p>
            <fieldset disabled={busy} className="sre-filter-grid mt-3">
              <label className="grid gap-1 text-sm font-medium text-ink-secondary">
                Service
                <input
                  list="topology-service-options"
                  required
                  value={serviceName}
                  onChange={(event) => {
                    const rawName = event.target.value;
                    const normalizedName = rawName.trim();
                    setServiceName(rawName);
                    setConfirmRemove(false);
                    const existing = graph.nodes.find((node) => node.name === normalizedName);
                    setTeam(existing?.team ?? '');
                    setCriticality(existing?.criticality ?? '');
                  }}
                  className="sre-field min-h-11"
                />
                <datalist id="topology-service-options">
                  {graph.nodes.map((node) => (
                    <option key={node.name} value={node.name} />
                  ))}
                </datalist>
              </label>
              <label className="grid gap-1 text-sm font-medium text-ink-secondary">
                Owning team
                <input
                  value={team}
                  onChange={(event) => setTeam(event.target.value)}
                  placeholder="Platform"
                  className="sre-field min-h-11"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium text-ink-secondary">
                Criticality
                <select
                  value={criticality}
                  onChange={(event) => setCriticality(event.target.value)}
                  className="sre-field min-h-11"
                >
                  <option value="">Not set</option>
                  <option value="tier1">Tier 1, critical</option>
                  <option value="tier2">Tier 2, important</option>
                  <option value="tier3">Tier 3, standard</option>
                </select>
              </label>
            </fieldset>
            <button
              type="submit"
              disabled={busy || !serviceName.trim()}
              className="sre-action sre-action-primary sre-hit-target mt-3"
            >
              Save service
            </button>
          </form>

          {registeredService && (
            <div className="mt-3 rounded-lg border border-line p-3 text-sm">
              <button
                type="button"
                disabled={busy || hasRelationships || hasRuntime}
                className="sre-hit-target text-critical disabled:opacity-50"
                onClick={() => setConfirmRemove(true)}
              >
                Remove service from catalog
              </button>
              <p className="text-xs text-ink-muted">
                {hasRelationships || hasRuntime
                  ? 'Remove its relationships and runtime mappings first.'
                  : 'Original incident and deployment records are retained. Explicit incident assignments also prevent deletion.'}
              </p>
              {confirmRemove && !hasRelationships && !hasRuntime && (
                <div>
                  <p>Remove {registeredService.name} and its catalog ownership?</p>
                  <button
                    type="button"
                    disabled={busy}
                    className="sre-hit-target mr-3 text-critical"
                    onClick={() =>
                      void save(async () => {
                        await deleteTopologyService(
                          apiBaseUrl,
                          getCredentials,
                          registeredService.name,
                        );
                        setConfirmRemove(false);
                      }, 'Service removed from catalog.')
                    }
                  >
                    Confirm service removal
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
          <TopologyRelationships
            graph={graph}
            apiBaseUrl={apiBaseUrl}
            getCredentials={getCredentials}
            busy={busy}
            save={save}
          />
        </SetupDialog>
      )}
    </>
  );
}
