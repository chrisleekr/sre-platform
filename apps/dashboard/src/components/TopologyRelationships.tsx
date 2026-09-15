import { useRef, useState } from 'react';
import type { TopologyGraph } from '../lib/topology';
import type { CredentialGetter } from '../lib/request-credentials';
import { deleteTopologyDependency, saveTopologyDependency } from '../lib/useTopology';
import { formatAbsoluteTime } from '../lib/time';

type Save = (work: () => Promise<void>, success: string) => Promise<void>;

/** Edit declared calls, keeping caller-to-dependency direction explicit. */
export function TopologyRelationships({
  graph,
  apiBaseUrl,
  getCredentials,
  busy,
  save,
}: {
  graph: TopologyGraph;
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  busy: boolean;
  save: Save;
}) {
  const registered = graph.nodes.filter((node) => node.sources?.includes('catalog'));
  const [upstream, setUpstream] = useState('');
  const [downstream, setDownstream] = useState('');
  const [syncType, setSyncType] = useState<'sync' | 'async'>('sync');
  const [circuitBreaker, setCircuitBreaker] = useState(false);
  const [protocol, setProtocol] = useState('');
  const [environment, setEnvironment] = useState('');
  const [rationale, setRationale] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const editorRef = useRef<HTMLFormElement>(null);
  const existing = graph.edges.find(
    (edge) =>
      edge.upstream === upstream &&
      edge.downstream === downstream &&
      (edge.environment ?? '') === environment,
  );
  const selectEdge = (caller: string, dependency: string, scope = environment) => {
    setEnvironment(scope);
    setUpstream(caller);
    setDownstream(dependency);
    const edge = graph.edges.find(
      (item) =>
        item.upstream === caller &&
        item.downstream === dependency &&
        (item.environment ?? '') === scope,
    );
    if (edge) {
      setSyncType(edge.syncType === 'async' ? 'async' : 'sync');
      setCircuitBreaker(edge.circuitBreaker);
      setProtocol(edge.protocol ?? '');
      setRationale(edge.rationale ?? '');
    } else if (existing) {
      setSyncType('sync');
      setCircuitBreaker(false);
      setProtocol('');
      setRationale('');
    }
  };
  const fieldClass =
    'min-h-11 w-full min-w-0 rounded-md border border-line-strong bg-surface px-3 py-2';
  return (
    <section className="mt-4 rounded-lg border border-line p-4" aria-label="Manage relationships">
      <h3 className="font-semibold text-ink">Service relationships</h3>
      <p className="mt-1 text-sm text-ink-muted">
        Caller → dependency. If the dependency fails, its callers may be affected. Only add calls
        you can confirm.
      </p>
      {graph.edges.length > 0 && (
        <ul aria-label="Registered relationships" className="mt-3 space-y-2">
          {graph.edges.map((edge) => {
            const key = JSON.stringify([edge.upstream, edge.downstream, edge.environment ?? '']);
            return (
              <li key={key} className="rounded border border-line p-3">
                <p className="break-words font-medium">
                  {edge.upstream} → {edge.downstream}
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  {edge.syncType === 'async' ? 'Asynchronous' : 'Synchronous'}
                  {edge.circuitBreaker ? ' · Circuit breaker' : ''}
                  {edge.protocol ? ` · ${edge.protocol}` : ''}
                  {' · '}
                  {edge.environment || 'Environment unspecified'}
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  Manually declared
                  {edge.lastConfirmedAt
                    ? ` · confirmed ${formatAbsoluteTime(edge.lastConfirmedAt)}`
                    : ' · no recorded confirmation'}
                  . No live call evidence is attached.
                </p>
                {edge.rationale && <p className="mt-1 text-xs">{edge.rationale}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Edit ${edge.upstream} to ${edge.downstream}`}
                    className="sre-hit-target rounded border border-line-strong px-3 py-1"
                    onClick={() => {
                      selectEdge(edge.upstream, edge.downstream, edge.environment ?? '');
                      editorRef.current?.querySelector('select')?.focus();
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove ${edge.upstream} to ${edge.downstream}`}
                    className="sre-hit-target rounded border border-line-strong px-3 py-1"
                    onClick={() => setRemoving(key)}
                  >
                    Remove
                  </button>
                </div>
                {removing === key && (
                  <div className="mt-2 text-sm">
                    <p>Remove this relationship from impact analysis? Both services will remain.</p>
                    <button
                      type="button"
                      disabled={busy}
                      className="sre-hit-target mr-3 text-critical"
                      onClick={() =>
                        void save(async () => {
                          await deleteTopologyDependency(apiBaseUrl, getCredentials, {
                            upstream: edge.upstream,
                            downstream: edge.downstream,
                            environment: edge.environment ?? '',
                          });
                          setRemoving(null);
                        }, 'Relationship removed.')
                      }
                    >
                      Confirm removal
                    </button>
                    <button type="button" disabled={busy} onClick={() => setRemoving(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {registered.length < 2 ? (
        <p className="mt-3 rounded-md bg-info-soft p-3 text-sm text-info">
          Register at least two services above, then return here to connect them. Discovered runtime
          entries are not yet catalog entries.
        </p>
      ) : (
        <form
          ref={editorRef}
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !upstream || !downstream || upstream === downstream || !rationale.trim())
              return;
            void save(
              () =>
                saveTopologyDependency(apiBaseUrl, getCredentials, {
                  upstream,
                  downstream,
                  syncType,
                  circuitBreaker,
                  protocol: protocol.trim() || null,
                  environment,
                  rationale: rationale.trim(),
                }),
              `${upstream} → ${downstream} is registered.`,
            );
          }}
        >
          <h4 className="font-medium">{existing ? 'Edit relationship' : 'Add a relationship'}</h4>
          <fieldset disabled={busy} className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="grid min-w-0 gap-1 text-sm">
              Environment (optional)
              <input
                className={fieldClass}
                maxLength={200}
                value={environment}
                onChange={(event) => selectEdge(upstream, downstream, event.target.value)}
                placeholder="Unspecified, included conservatively in every scope"
              />
            </label>
            <label className="grid min-w-0 gap-1 text-sm">
              Evidence or reason for this dependency
              <input
                required
                className={fieldClass}
                maxLength={1000}
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                placeholder="Where you confirmed this call"
              />
            </label>
            <label className="grid min-w-0 gap-1 text-sm">
              Caller (upstream)
              <select
                required
                className={fieldClass}
                value={upstream}
                onChange={(event) => selectEdge(event.target.value, downstream)}
              >
                <option value="">Choose caller</option>
                {registered.map((node) => (
                  <option key={node.name} value={node.name}>
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1 text-sm">
              Dependency (downstream)
              <select
                required
                className={fieldClass}
                value={downstream}
                onChange={(event) => selectEdge(upstream, event.target.value)}
              >
                <option value="">Choose dependency</option>
                {registered.map((node) => (
                  <option key={node.name} value={node.name}>
                    {node.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1 text-sm">
              Call type
              <select
                className={fieldClass}
                value={syncType}
                onChange={(event) => setSyncType(event.target.value as 'sync' | 'async')}
              >
                <option value="sync">Synchronous</option>
                <option value="async">Asynchronous</option>
              </select>
            </label>
            <label className="grid min-w-0 gap-1 text-sm">
              Protocol (optional)
              <input
                className={fieldClass}
                value={protocol}
                onChange={(event) => setProtocol(event.target.value)}
                placeholder="HTTPS, gRPC, AMQP"
              />
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={circuitBreaker}
                onChange={(event) => setCircuitBreaker(event.target.checked)}
              />
              A circuit breaker is declared on this call
            </label>
          </fieldset>
          {upstream && downstream && (
            <p className="mt-2 text-sm text-ink-muted">
              {upstream === downstream
                ? 'Choose two different services.'
                : `${upstream} depends on ${downstream}. ${circuitBreaker ? 'A breaker does not prove a working fallback. Callers remain potentially exposed.' : syncType === 'async' ? 'Async processing may delay impact; callers remain potentially exposed.' : 'A synchronous failure can propagate to the caller.'}`}
            </p>
          )}
          <button
            type="submit"
            disabled={
              busy || !upstream || !downstream || upstream === downstream || !rationale.trim()
            }
            className="sre-hit-target mt-3 rounded-md bg-strong px-4 py-2 text-sm font-semibold text-on-strong disabled:opacity-50"
          >
            {existing ? 'Update relationship' : 'Save relationship'}
          </button>
        </form>
      )}
    </section>
  );
}
