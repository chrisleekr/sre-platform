import { KubernetesConnectWizard } from '../../src/components/KubernetesConnectWizard';
import { saveKubernetesConnector, testKubernetesConnector } from '../../src/lib/useConnectors';

const credentials = async () => ({ kind: 'cookie' as const });

export function KubernetesErrorsFixture() {
  return (
    <KubernetesConnectWizard
      mode="connect"
      onSave={(body) => saveKubernetesConnector(location.origin, credentials, body)}
      onRunTest={(id) => testKubernetesConnector(location.origin, credentials, id)}
      onFetchManifest={async () => ''}
      onClose={() => {}}
    />
  );
}
