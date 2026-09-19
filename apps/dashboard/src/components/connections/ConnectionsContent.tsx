import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useSearchParams } from 'react-router-dom';
import { config } from '../../config';
import { useSurfaces } from '../../lib/useSurfaces';
import { ConnectorCatalog } from '../ConnectorCatalog';
import type { ManagedConnectorType } from '../connectorPresentation';
import { InboundPanel } from '../InboundPanel';
import { PageHeader } from '../PageHeader';
import { InlineAlert, StatePanel } from '../PageState';
import { SavedConnectors } from '../SavedConnectors';
import { ConnectionInventory, type ConnectionFilters } from './ConnectionInventory';

export function ConnectionsContent({
  loading,
  error,
  refetch,
  onAdd,
  canConfigure,
  ...saved
}: ComponentProps<typeof SavedConnectors> & {
  loading: boolean;
  error: boolean;
  refetch: () => void;
  onAdd: (type: ManagedConnectorType, trigger: HTMLButtonElement) => void;
}) {
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<ConnectionFilters>({
    q: '',
    provider: 'All providers',
    attention: false,
  });
  const chat = useSurfaces({ apiBaseUrl: config.apiBaseUrl, getCredentials: saved.getCredentials });
  const catalog = params.get('view') === 'catalog';
  const selectedId = params.get('connection');
  const selected = saved.connectors.find(
    (c) => c.id === selectedId && c.capabilities?.availability !== 'incomplete',
  );
  const hasConnections =
    saved.connectors.some((c) => c.capabilities?.availability !== 'incomplete') ||
    chat.surfaces.length > 0;
  const pending = loading || chat.loading;
  const failed = error || chat.error;
  const headingRef = useRef<HTMLDivElement>(null);
  const viewKey = catalog ? 'catalog' : (selectedId ?? 'inventory');
  const previousView = useRef(viewKey);
  useEffect(() => {
    if (previousView.current !== viewKey) {
      previousView.current = viewKey;
      headingRef.current?.focus();
    }
  }, [viewKey]);
  const navigate = (view?: 'catalog', id?: string) => {
    const next = new URLSearchParams(params);
    next.delete('view');
    next.delete('connection');
    if (view) next.set('view', view);
    if (id) next.set('connection', id);
    setParams(next);
  };
  return (
    <>
      {(catalog || selectedId) && (
        <button
          type="button"
          onClick={() => navigate()}
          className="mb-4 min-h-10 text-sm font-medium text-ink-secondary underline underline-offset-4"
        >
          Back to connections
        </button>
      )}
      <div ref={headingRef} tabIndex={-1}>
        <PageHeader
          title={
            catalog
              ? 'Add connection'
              : selectedId === 'slack'
                ? 'Slack'
                : selected
                  ? selected.name
                  : 'Connections'
          }
          description={
            catalog
              ? 'Find a tool, then follow its setup guide.'
              : selectedId
                ? 'Review access, data activity and configuration.'
                : 'Manage the tools your AI SRE can access.'
          }
          action={
            canConfigure && !catalog && !selectedId ? (
              <button
                type="button"
                onClick={() => navigate('catalog')}
                className="sre-action sre-action-primary min-h-10"
              >
                Add connection
              </button>
            ) : undefined
          }
        />
      </div>
      {!canConfigure && (
        <p className="mb-4 text-sm text-ink-muted">
          Only workspace owners and admins can change connections.
        </p>
      )}
      {error && (
        <InlineAlert
          message="Could not refresh evidence connections. Previously loaded information may be outdated."
          onRetry={refetch}
        />
      )}
      {chat.error && (
        <InlineAlert
          message="Could not load chat connections. Other connections are still available."
          onRetry={chat.refetch}
        />
      )}
      {catalog ? (
        <ConnectorCatalog
          connectors={saved.connectors}
          unavailable={!canConfigure || loading || error}
          slackConfigured={chat.surfaces.length > 0}
          slackUnavailable={!canConfigure || chat.loading || chat.error}
          onAdd={onAdd}
          onSlack={() => navigate(undefined, 'slack')}
        />
      ) : selectedId === 'slack' ? (
        <InboundPanel embedded onChange={chat.refetch} />
      ) : selected ? (
        <SavedConnectors
          {...saved}
          canConfigure={canConfigure}
          connectors={[selected]}
          onDisconnect={async (connector) => {
            const removed = await saved.onDisconnect(connector);
            if (removed) navigate();
            return removed;
          }}
        />
      ) : selectedId ? (
        loading ? (
          <StatePanel state="loading" title="Loading connection…" />
        ) : error ? null : (
          <StatePanel
            state="empty"
            title="Connection not found."
            description="It may have been disconnected, or you may not have access in this workspace."
          />
        )
      ) : !hasConnections && pending ? (
        <StatePanel state="loading" title="Loading connections…" />
      ) : !hasConnections && !failed ? (
        <StatePanel
          state="empty"
          title="Connect your first tool"
          description="Give your AI SRE access to the systems it needs to investigate. Choose Add connection to get started."
        />
      ) : hasConnections ? (
        <ConnectionInventory
          filters={filters}
          onFiltersChange={setFilters}
          connectors={saved.connectors}
          surfaces={chat.surfaces}
          onSelect={(id) => navigate(undefined, id)}
        />
      ) : null}
      {hasConnections && pending && (
        <p role="status" className="mt-3 text-xs text-ink-muted">
          Refreshing connections…
        </p>
      )}
    </>
  );
}
