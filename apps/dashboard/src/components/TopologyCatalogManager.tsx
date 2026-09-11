import type { CredentialGetter } from '../lib/request-credentials';
import { useMemo, useState } from 'react';
import type { TopologyGraph } from '../lib/topology';
import { saveTopologyDependency, saveTopologyService } from '../lib/useTopology';
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
  const [upstream, setUpstream] = useState('');
  const [downstream, setDownstream] = useState('');
  const [syncType, setSyncType] = useState<'sync' | 'async'>('sync');
  const [circuitBreaker, setCircuitBreaker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const registered = useMemo(
    () => graph.nodes.filter((node) => node.sources?.includes('catalog')),
    [graph.nodes],
  );

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
          setOpen(true);
        }}
        className="sre-hit-target rounded-md bg-strong px-4 py-2 text-sm font-semibold text-on-strong hover:bg-strong-hover"
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
              if (!name) return;
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
            <h3 className="font-semibold text-ink">Register or update a service</h3>
            <p className="mt-1 text-xs text-ink-muted">
              Pick a discovered service or enter a stable service name, then add ownership context.
            </p>
            <div className="sre-filter-grid mt-3">
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
                    const existing = graph.nodes.find((node) => node.name === normalizedName);
                    setTeam(existing?.team ?? '');
                    setCriticality(existing?.criticality ?? '');
                  }}
                  className="min-h-11 rounded-md border border-line-strong bg-surface px-3 py-2"
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
                  className="min-h-11 rounded-md border border-line-strong bg-surface px-3 py-2"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium text-ink-secondary">
                Criticality
                <select
                  value={criticality}
                  onChange={(event) => setCriticality(event.target.value)}
                  className="min-h-11 rounded-md border border-line-strong bg-surface px-3 py-2"
                >
                  <option value="">Not set</option>
                  <option value="tier1">Tier 1, critical</option>
                  <option value="tier2">Tier 2, important</option>
                  <option value="tier3">Tier 3, standard</option>
                </select>
              </label>
            </div>
            <button
              type="submit"
              disabled={busy || !serviceName.trim()}
              className="sre-hit-target mt-3 rounded-md bg-strong px-4 py-2 text-sm font-semibold text-on-strong disabled:opacity-50"
            >
              Save service
            </button>
          </form>

          <form
            className="mt-4 rounded-lg border border-line p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!upstream || !downstream || upstream === downstream) return;
              void save(
                () =>
                  saveTopologyDependency(apiBaseUrl, getCredentials, {
                    upstream,
                    downstream,
                    syncType,
                    circuitBreaker,
                  }),
                `${upstream} → ${downstream} is registered.`,
              );
            }}
          >
            <h3 className="font-semibold text-ink">Add a relationship</h3>
            <p className="mt-1 text-xs text-ink-muted">Upstream calls or depends on downstream.</p>
            {registered.length < 2 ? (
              <p className="mt-3 rounded-md bg-info-soft p-3 text-sm text-info">
                Register at least two services before adding a relationship.
              </p>
            ) : (
              <>
                <div className="sre-filter-grid mt-3">
                  <label className="grid gap-1 text-sm font-medium text-ink-secondary">
                    Upstream
                    <select
                      value={upstream}
                      required
                      onChange={(event) => setUpstream(event.target.value)}
                      className="min-h-11 rounded-md border border-line-strong bg-surface px-3 py-2"
                    >
                      <option value="">Choose service</option>
                      {registered.map((node) => (
                        <option key={node.name} value={node.name}>
                          {node.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-medium text-ink-secondary">
                    Downstream
                    <select
                      value={downstream}
                      required
                      onChange={(event) => setDownstream(event.target.value)}
                      className="min-h-11 rounded-md border border-line-strong bg-surface px-3 py-2"
                    >
                      <option value="">Choose service</option>
                      {registered.map((node) => (
                        <option key={node.name} value={node.name}>
                          {node.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-medium text-ink-secondary">
                    Call type
                    <select
                      value={syncType}
                      onChange={(event) => setSyncType(event.target.value as 'sync' | 'async')}
                      className="min-h-11 rounded-md border border-line-strong bg-surface px-3 py-2"
                    >
                      <option value="sync">Synchronous</option>
                      <option value="async">Asynchronous</option>
                    </select>
                  </label>
                </div>
                <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={circuitBreaker}
                    onChange={(event) => setCircuitBreaker(event.target.checked)}
                  />
                  A circuit breaker limits blast radius
                </label>
                {upstream && downstream && upstream === downstream && (
                  <p className="text-sm text-critical">Choose two different services.</p>
                )}
                <button
                  type="submit"
                  disabled={busy || !upstream || !downstream || upstream === downstream}
                  className="sre-hit-target mt-3 rounded-md bg-strong px-4 py-2 text-sm font-semibold text-on-strong disabled:opacity-50"
                >
                  Save relationship
                </button>
              </>
            )}
          </form>
        </SetupDialog>
      )}
    </>
  );
}
