import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GitLabConnectWizard } from '../../src/components/GitLabConnectWizard';
import { GitLabPollingCoverage } from '../../src/components/gitlab-connect/PollingCoverage';
import { GitLabManagementPanel } from '../../src/components/gitlab-connect/ManagementPanel';
import { gitLabManagementApi } from '../../src/lib/connector-api/gitlab-management';
import {
  discoverGitLabProjects,
  saveGitLabConnector,
  testGitLabConnector,
} from '../../src/lib/connector-api/gitlab';
import { prepareConnectorDelivery } from '../../src/lib/connector-delivery';
import type { ConnectorSummary } from '../../src/lib/connectors';
import type { CredentialGetter } from '../../src/lib/request-credentials';
import '../../src/index.css';

const apiBase = 'https://api.fixture.example';
const credentials: CredentialGetter = async () => ({
  kind: 'bearer',
  token: (window as unknown as { integrationToken: string }).integrationToken,
});
const management = gitLabManagementApi(apiBase, credentials);

function Fixture() {
  const [open, setOpen] = useState(true);
  const [savedId, setSavedId] = useState('');
  const [managed, setManaged] = useState(false);
  const [coverage, setCoverage] =
    useState<NonNullable<ConnectorSummary['polling']>['gitlabCoverage']>();
  return (
    <main className="mx-auto max-w-5xl p-6">
      {open ? (
        <GitLabConnectWizard
          managementApi={management}
          mode="connect"
          apiBaseUrl={apiBase}
          onClose={() => setOpen(false)}
          onDiscover={(body) => discoverGitLabProjects(apiBase, credentials, body)}
          onSave={async (body) => {
            const saved = await saveGitLabConnector(apiBase, credentials, body);
            setSavedId(saved.connectorId);
            setManaged(body.settings.eventStrategy === 'managed_projects');
            return saved;
          }}
          onRunTest={(id) => testGitLabConnector(apiBase, credentials, id)}
          onPrepareDelivery={(body) =>
            prepareConnectorDelivery(apiBase, credentials, 'gitlab', body)
          }
        />
      ) : managed ? (
        <GitLabManagementPanel
          api={management}
          connectorId={savedId}
          destination={`${apiBase}/webhooks/gitlab/${savedId}`}
        />
      ) : (
        <button
          onClick={async () => {
            const credential = await credentials();
            if (credential.kind !== 'bearer') throw new Error('Missing isolated test identity');
            const response = await fetch(`${apiBase}/connectors`, {
              headers: { authorization: `Bearer ${credential.token}` },
            });
            if (!response.ok) throw new Error('Could not load connector coverage');
            const data = (await response.json()) as { connectors: ConnectorSummary[] };
            setCoverage(data.connectors.find((c) => c.id === savedId)?.polling?.gitlabCoverage);
          }}
        >
          Refresh coverage
        </button>
      )}
      {coverage && <GitLabPollingCoverage coverage={coverage} />}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
