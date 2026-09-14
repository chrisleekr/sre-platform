import { createRoot } from 'react-dom/client';
import { useTopology } from '../../src/lib/useTopology';
import { TopologyExplorer } from '../../src/components/TopologyExplorer';
import '../../src/index.css';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono';

const getCredentials = async () => ({
  kind: 'bearer' as const,
  token: sessionStorage.getItem('topology-test-token') ?? '',
});
function Fixture() {
  const topology = useTopology({
    apiBaseUrl: `${location.origin}/__api`,
    getCredentials,
    pollMs: 60_000,
  });
  return (
    <main className="min-h-dvh bg-canvas p-4 text-ink sm:p-8">
      <div className="mx-auto max-w-7xl">
        <h1 className="mb-2 text-2xl font-semibold">Service topology</h1>
        <p className="mb-6 text-sm text-ink-muted">
          Isolated discovery verification. Real adapters, worker, database and authenticated API;
          simulated provider responses.
        </p>
        <TopologyExplorer
          graph={topology.graph.discovery}
          incidentGraph={topology.graph}
          loading={topology.loading}
          error={topology.error}
          onRefresh={topology.refetch}
          access={{ apiBaseUrl: `${location.origin}/__api`, getCredentials }}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
