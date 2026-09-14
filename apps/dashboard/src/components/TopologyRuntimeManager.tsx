import { useMemo, useState } from 'react';
import type { CredentialGetter } from '../lib/request-credentials';
import type { RuntimeBinding, TopologyGraph } from '../lib/topology';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { checkResponse } from '../lib/request-error';

const field =
  'mt-1 block w-full min-w-0 rounded border border-line-strong bg-surface px-3 py-2 text-sm';

/** Connect runtime evidence to a service only after a responder confirms its scope. */
export function TopologyRuntimeManager({
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
  const [service, setService] = useState('');
  const [scope, setScope] = useState('');
  const [label, setLabel] = useState('');
  const [environment, setEnvironment] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const scopes = useMemo(() => {
    const rows = new Map<
      string,
      { connectorId: string; namespace: string; name: string; labels: Set<string> }
    >();
    for (const pod of graph.infrastructure ?? []) {
      if (pod.kind !== 'pod' || !pod.namespace) continue;
      const key = JSON.stringify([pod.dataSourceId, pod.namespace]);
      const row = rows.get(key) ?? {
        connectorId: pod.dataSourceId,
        namespace: pod.namespace,
        name: pod.dataSourceName,
        labels: new Set<string>(),
      };
      for (const pair of Object.entries(pod.labels ?? {})) row.labels.add(JSON.stringify(pair));
      rows.set(key, row);
    }
    for (const binding of graph.runtimeBindings ?? []) {
      const key = JSON.stringify([binding.connectorId, binding.namespace]);
      const row = rows.get(key) ?? {
        connectorId: binding.connectorId,
        namespace: binding.namespace,
        name: `${graph.coverage?.find((source) => source.dataSourceId === binding.connectorId)?.dataSourceName ?? 'Unavailable connection'} (saved scope, no current pods)`,
        labels: new Set<string>(),
      };
      if (binding.labelKey) row.labels.add(JSON.stringify([binding.labelKey, binding.labelValue]));
      rows.set(key, row);
    }
    return rows;
  }, [graph.infrastructure, graph.runtimeBindings, graph.coverage]);
  const selected = scopes.get(scope);
  const bindings = graph.runtimeBindings ?? [];
  async function mutate(path: string, method: 'PUT' | 'DELETE', body?: unknown) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await authenticatedFetch(`${apiBaseUrl}/topology/${path}`, getCredentials, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      await checkResponse(
        response,
        'Runtime mapping could not be saved. Review the fields and try again.',
      );
      setNotice(
        method === 'DELETE'
          ? 'Runtime mapping removed. No cluster resources were changed.'
          : 'Runtime mapping saved.',
      );
      setRemoveId(null);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Runtime mapping failed.');
    } finally {
      setBusy(false);
    }
  }
  function edit(binding: RuntimeBinding) {
    setEditing(true);
    setService(binding.serviceName);
    setEnvironment(binding.environment);
    setReason(binding.rationale);
    setScope(JSON.stringify([binding.connectorId, binding.namespace]));
    setLabel(binding.labelKey ? JSON.stringify([binding.labelKey, binding.labelValue]) : '');
    setNotice('');
    setError('');
  }
  return (
    <details
      className="mb-4 rounded-md border border-line bg-surface p-4"
      open={
        (bindings.length === 0 && scopes.size > 0) || editing || Boolean(notice) || Boolean(error)
      }
    >
      <summary className="cursor-pointer text-sm font-semibold">
        Runtime mapping · {bindings.length} confirmed · {scopes.size} namespace scopes
      </summary>
      <p className="mt-2 text-xs text-ink-muted">
        A namespace is not a service. Select the connection, environment and pods belonging to a
        registered service. This changes only the platform mapping, never your cluster.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-warning">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-sm text-success">
          {notice}
        </p>
      )}
      {bindings.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm" aria-label="Confirmed runtime mappings">
          {bindings.map((binding) => (
            <li key={binding.id} className="rounded border border-line p-3">
              <p className="break-words">
                <strong>{binding.serviceName}</strong> · {binding.environment} ·{' '}
                {graph.coverage?.find((source) => source.dataSourceId === binding.connectorId)
                  ?.dataSourceName ?? 'Unavailable connection'}{' '}
                / {binding.namespace} ·{' '}
                {binding.labelKey
                  ? `${binding.labelKey}=${binding.labelValue}`
                  : 'All pods in namespace'}
              </p>
              <p className="mt-1 text-xs text-ink-muted">{binding.rationale}</p>
              <div className="mt-2 flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => edit(binding)}
                  className="text-info underline"
                >
                  Edit mapping
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setRemoveId(binding.id)}
                  className="text-warning underline"
                >
                  Remove mapping
                </button>
                {removeId === binding.id && (
                  <>
                    <span>Stop associating this runtime with {binding.serviceName}?</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void mutate(`runtime-bindings/${binding.id}`, 'DELETE')}
                      className="text-warning underline"
                    >
                      Confirm removal
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setRemoveId(null)}
                      className="underline"
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {scopes.size === 0 ? (
        <p className="mt-3 text-sm">
          No current pod inventory is available. Check Runtime evidence and the Kubernetes
          connection before adding a mapping.
        </p>
      ) : (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selected || busy) return;
            const [labelKey, labelValue] = label
              ? (JSON.parse(label) as [string, string])
              : ['', ''];
            void mutate('runtime-bindings', 'PUT', {
              serviceName: service,
              createService: !graph.nodes.some((node) => node.name === service.trim()),
              replaceExisting: editing,
              connectorId: selected.connectorId,
              namespace: selected.namespace,
              labelKey,
              labelValue,
              environment,
              rationale: reason,
            });
          }}
        >
          <label className="text-xs">
            Service name
            <input
              required
              maxLength={200}
              list="topology-catalog-services"
              className={field}
              value={service}
              onChange={(event) => setService(event.target.value)}
              placeholder="Choose an existing service or name a new one"
            />
            <datalist id="topology-catalog-services">
              {graph.nodes.map((node) => (
                <option key={node.name} value={node.name} />
              ))}
            </datalist>
          </label>
          <label className="text-xs">
            Connection and namespace
            <select
              disabled={editing}
              required
              className={field}
              value={scope}
              onChange={(event) => {
                setScope(event.target.value);
                setLabel('');
              }}
            >
              <option value="">Select runtime scope</option>
              {[...scopes].map(([key, value]) => (
                <option key={key} value={key}>
                  {value.name} / {value.namespace}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            Environment
            <input
              required
              maxLength={200}
              className={field}
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
              placeholder="Your environment name"
            />
          </label>
          <label className="text-xs">
            Pods to associate
            <select
              disabled={editing}
              className={field}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            >
              <option value="">All pods in this namespace</option>
              {[...(selected?.labels ?? [])].sort().map((value) => (
                <option key={value} value={value}>
                  {(JSON.parse(value) as string[]).join('=')}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs sm:col-span-2">
            Why these resources belong to this service
            <input
              required
              maxLength={1000}
              className={field}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {!label && selected && (
            <p className="text-xs text-warning sm:col-span-2">
              Only choose all pods if the entire namespace belongs to this service. For a shared
              namespace, choose an application label.
            </p>
          )}
          <button
            disabled={busy || !selected}
            className="justify-self-start rounded bg-strong px-4 py-2 text-sm text-on-strong"
          >
            {busy
              ? 'Saving…'
              : service.trim() && !graph.nodes.some((node) => node.name === service.trim())
                ? 'Register service and map runtime'
                : 'Confirm runtime mapping'}
          </button>
          {editing && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setScope('');
                setLabel('');
              }}
              className="justify-self-start text-sm underline"
            >
              Cancel editing
            </button>
          )}
        </form>
      )}
    </details>
  );
}
