import { useState } from 'react';
import type { TopologyGraph } from '../lib/topology';
import type { CredentialGetter } from '../lib/request-credentials';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { checkResponse } from '../lib/request-error';

/** A direct recovery path for incidents without provider entity candidates. */
export function TopologyIncidentMapping({
  incidentId,
  services,
  graph,
  apiBaseUrl,
  getCredentials,
  onSaved,
}: {
  incidentId: string;
  services: string[];
  graph: TopologyGraph;
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(
    services.filter((name) => graph.nodes.some((node) => node.name === name)),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(names: string[]) {
    if (!reason.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await authenticatedFetch(
        `${apiBaseUrl}/topology/incidents/${encodeURIComponent(incidentId)}/services`,
        getCredentials,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ services: names, rationale: reason.trim() }),
        },
      );
      await checkResponse(response, 'Affected services could not be saved.');
      setOpen(false);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Service assignment failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3">
      <button
        type="button"
        className="text-info underline"
        onClick={() => {
          if (!open)
            setSelected(services.filter((name) => graph.nodes.some((node) => node.name === name)));
          setError('');
          setOpen(!open);
        }}
      >
        {services.length ? 'Edit affected services' : 'Link affected service'}
      </button>
      {open && (
        <form
          className="mt-2 rounded border border-line p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save(selected);
          }}
        >
          <p className="text-xs">
            Your selection takes precedence over provider candidates for this incident. Original
            signals are preserved.
          </p>
          {graph.nodes.length === 0 ? (
            <p className="mt-2">Register a service using Edit catalog or Runtime mapping first.</p>
          ) : (
            <fieldset
              disabled={busy}
              className="my-3 grid max-h-48 gap-2 overflow-auto sm:grid-cols-2"
            >
              <legend className="mb-2 font-medium">Affected services</legend>
              {graph.nodes.map((node) => (
                <label key={node.name} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(node.name)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, node.name]
                          : selected.filter((name) => name !== node.name),
                      )
                    }
                  />
                  {node.name}
                </label>
              ))}
            </fieldset>
          )}
          <label className="block text-xs">
            Reason for this change
            <input
              required
              maxLength={1000}
              className="mt-1 block w-full rounded border border-line-strong bg-surface p-2 text-sm"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="mt-2 text-warning">
              {error}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              disabled={busy || !selected.length || !reason.trim()}
              className="rounded bg-strong px-3 py-2 text-on-strong"
            >
              Save affected services
            </button>
            <button
              type="button"
              disabled={busy || !reason.trim()}
              className="underline"
              onClick={() => void save([])}
            >
              Restore provider mapping
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
