import { useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { useTopology } from '../lib/useTopology';
import { PageHeader } from './PageHeader';
import { TopologyCatalogPanel } from './TopologyCatalogPanel';
import { TopologyExplorer } from './TopologyExplorer';

/** Automatic discovery is the entry point; catalog corrections never gate exploration. */
export function TopologyPanel() {
  const { getCredentials } = useSession();
  const [at, setAt] = useState('');
  const topology = useTopology({ apiBaseUrl: config.apiBaseUrl, getCredentials, at });
  const [catalogOpen, setCatalogOpen] = useState(() =>
    new URLSearchParams(window.location.search).has('catalogService'),
  );
  return (
    <section className="min-w-0 space-y-5">
      <PageHeader title="Service topology" />
      <p className="max-w-4xl text-sm text-ink-muted">
        Follow the evidence from services to workloads, deployments and source code. Each
        relationship shows what was observed and where it came from.
      </p>
      {!at && (
        <TopologyExplorer
          graph={topology.graph.discovery}
          incidentGraph={topology.graph}
          loading={topology.loading}
          error={topology.error}
          onRefresh={topology.refetch}
          access={{ apiBaseUrl: config.apiBaseUrl, getCredentials }}
        />
      )}
      {!topology.loading &&
        !(topology.error && !topology.graph.discovery && !topology.graph.nodes.length) && (
          <details
            className="rounded-lg border border-line bg-surface p-4"
            open={catalogOpen || Boolean(at) || !topology.graph.discovery}
            onToggle={(event) => {
              if (topology.graph.discovery) setCatalogOpen(event.currentTarget.open);
            }}
          >
            <summary className="cursor-pointer text-sm font-semibold">
              Catalog and corrections
            </summary>
            <p className="my-3 text-sm text-ink-muted">
              Review declared dependencies, ownership and incident assignments. Runtime mappings
              here are explicit corrections, not a requirement for automatic discovery.
            </p>
            {(catalogOpen || Boolean(at) || !topology.graph.discovery) && (
              <TopologyCatalogPanel
                {...topology}
                graph={
                  topology.graph.discovery
                    ? {
                        ...topology.graph,
                        incidents: [],
                        incidentMappings: [],
                        nodes: topology.graph.nodes.map((node) => ({
                          ...node,
                          sources: node.sources?.filter((source) => source !== 'incident'),
                        })),
                      }
                    : topology.graph
                }
                at={at}
                setAt={setAt}
              />
            )}
          </details>
        )}
    </section>
  );
}
