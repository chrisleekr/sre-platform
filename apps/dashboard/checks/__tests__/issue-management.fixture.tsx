import { createRoot } from 'react-dom/client';
import { IssueManagementDialog } from '../../src/components/IssueManagement';
import type { CredentialGetter } from '../../src/lib/request-credentials';
import '../../src/index.css';

const state = window as unknown as { integrationToken: string; incidentId: string };
const credentials: CredentialGetter = async () => ({
  kind: 'bearer',
  token: state.integrationToken,
});
createRoot(document.getElementById('root')!).render(
  <IssueManagementDialog
    incidentId={state.incidentId}
    apiBaseUrl="https://api.fixture.example"
    getCredentials={credentials}
    onClose={() => undefined}
  />,
);
