import { useMe } from '../lib/me-store';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { requestErrorMessage } from '../lib/request-error';
import { prepareConnectorDelivery } from '../lib/connector-delivery';
import { gitLabManagementApi } from '../lib/connector-api/gitlab-management';
import { listStatusCakeUptimeTests, runStatusCakeSetup } from '../lib/connector-api/statuscake';
import type {
  ArgoCdSettings,
  ConnectorSummary,
  GitHubSettings,
  GitLabSettings,
  KubernetesSettings,
  PrometheusSettings,
} from '../lib/connectors';
import { type InvestigationSubject } from '../lib/investigations';
import {
  completeGitHubManifest,
  disconnectArgoCdConnector,
  disconnectGitHubConnector,
  disconnectGitLabConnector,
  disconnectKubernetesConnector,
  disconnectObservabilityConnector,
  disconnectPrometheusConnector,
  disconnectStatusCakeConnector,
  discoverGitHubInstallations,
  discoverGitLabProjects,
  fetchArgoCdAccess,
  fetchKubernetesManifest,
  saveArgoCdConnector,
  saveGitHubConnector,
  saveGitLabConnector,
  saveKubernetesConnector,
  saveObservabilityConnector,
  savePrometheusConnector,
  saveStatusCakeConnector,
  startGitHubManifest,
  testArgoCdConnector,
  testGitHubConnector,
  testGitLabConnector,
  testKubernetesConnector,
  testObservabilityConnector,
  testPrometheusConnector,
  testStatusCakeConnector,
  useConnectors,
} from '../lib/useConnectors';
import { useInvestigationWorkspaces } from '../lib/useInvestigationWorkspaces';
import { listAvailableChannels } from '../lib/useSurfaces';
import { ArgoCdConnectWizard } from './ArgoCdConnectWizard';
import { ConnectionsContent } from './connections/ConnectionsContent';
import { GitHubConnectWizard } from './GitHubConnectWizard';
import { GitLabConnectWizard } from './GitLabConnectWizard';
import { KubernetesConnectWizard } from './KubernetesConnectWizard';
import { ObservabilityConnectWizard } from './ObservabilityConnectWizard';
import { InlineAlert } from './PageState';
import { PrometheusConnectWizard } from './PrometheusConnectWizard';
import { StatusCakeConnectWizard } from './StatusCakeConnectWizard';

import { CONNECTOR_CATALOG, connectorState, isManagedConnector } from './connectorPresentation';

/** The Connectors panel: guide setup and expose the health of saved integrations. */
export function ConnectorsPanel() {
  const [viewParams, setViewParams] = useSearchParams();
  const savedDuringSetup = useRef(false);
  const recordSave = async <T,>(operation: Promise<T>): Promise<T> => {
    const result = await operation;
    savedDuringSetup.current = true;
    return result;
  };
  const session = useSession();
  const { getCredentials } = session;
  const me = useMe(getCredentials, session.status === 'authenticated', session.sessionKey);
  const canConfigure =
    !me.data?.tenant?.impersonation &&
    (me.data?.tenant?.role === 'owner' || me.data?.tenant?.role === 'admin');
  const managementApi = useMemo(
    () => gitLabManagementApi(config.apiBaseUrl, getCredentials),
    [getCredentials],
  );
  const { connectors, loading, error, refetch } = useConnectors({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  });
  const investigationSubjects = useMemo<InvestigationSubject[]>(
    () =>
      connectors.flatMap((connector) =>
        connectorState(connector).label === 'Verification failed'
          ? [{ kind: 'connector_verification' as const, connectorId: connector.id }]
          : [],
      ),
    [connectors],
  );
  const activeInvestigations = useInvestigationWorkspaces({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    subjects: investigationSubjects,
  });
  const [manifestCallback, setManifestCallback] = useState<
    { code: string; state: string } | undefined
  >(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    return code && state ? { code, state } : undefined;
  });
  const [requestedWizardMode, setWizardMode] = useState<
    | 'kubernetes-connect'
    | 'kubernetes-edit'
    | 'gitlab-connect'
    | 'gitlab-edit'
    | 'github-connect'
    | 'github-edit'
    | 'argocd-connect'
    | 'argocd-edit'
    | 'prometheus-connect'
    | 'prometheus-edit'
    | 'statuscake-connect'
    | 'statuscake-edit'
    | 'datadog-connect'
    | 'datadog-edit'
    | 'grafana-connect'
    | 'grafana-edit'
    | null
  >(manifestCallback ? 'github-connect' : null);
  const wizardMode = canConfigure ? requestedWizardMode : null;
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null);
  const wizardTriggerRef = useRef<HTMLButtonElement>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState('');
  const [busyAction, setBusyAction] = useState<{
    connectorId: string;
    kind: 'test' | 'disconnect';
  } | null>(null);

  const closeWizard = useCallback(() => {
    setWizardMode(null);
    setSelectedConnectorId(null);
    if (savedDuringSetup.current && viewParams.get('view') === 'catalog') {
      const next = new URLSearchParams(viewParams);
      next.delete('view');
      setViewParams(next);
    }
    savedDuringSetup.current = false;
    refetch();
  }, [refetch, viewParams, setViewParams]);

  const retestConnector = (connector: ConnectorSummary): void => {
    if (!isManagedConnector(connector.type)) return;
    setBusyAction({ connectorId: connector.id, kind: 'test' });
    setMutationError('');
    let operation: Promise<unknown>;
    if (connector.type === 'kubernetes')
      operation = testKubernetesConnector(config.apiBaseUrl, getCredentials, connector.id);
    else if (connector.type === 'gitlab')
      operation = testGitLabConnector(config.apiBaseUrl, getCredentials, connector.id);
    else if (connector.type === 'github')
      operation = testGitHubConnector(config.apiBaseUrl, getCredentials, connector.id);
    else if (connector.type === 'argocd')
      operation = testArgoCdConnector(config.apiBaseUrl, getCredentials, connector.id);
    else if (connector.type === 'prometheus')
      operation = testPrometheusConnector(config.apiBaseUrl, getCredentials, connector.id);
    else if (connector.type === 'statuscake')
      operation = testStatusCakeConnector(config.apiBaseUrl, getCredentials, connector.id);
    else
      operation = testObservabilityConnector(
        config.apiBaseUrl,
        getCredentials,
        connector.type,
        connector.id,
      );
    void operation
      .then(() => refetch())
      .catch((cause) =>
        setMutationError(
          requestErrorMessage(
            cause,
            `${connector.name} verification could not complete. Refresh its status and retry.`,
          ),
        ),
      )
      .finally(() => setBusyAction(null));
  };

  const disconnectConnector = (connector: ConnectorSummary): Promise<boolean> => {
    if (!isManagedConnector(connector.type)) return Promise.resolve(false);
    setBusyAction({ connectorId: connector.id, kind: 'disconnect' });
    setMutationError('');
    let operation: Promise<void>;
    if (connector.type === 'kubernetes')
      operation = disconnectKubernetesConnector(config.apiBaseUrl, getCredentials, connector.id);
    else if (connector.type === 'gitlab')
      operation = disconnectGitLabConnector(config.apiBaseUrl, getCredentials, connector.id);
    else if (connector.type === 'github')
      operation = disconnectGitHubConnector(config.apiBaseUrl, getCredentials, connector.id);
    else if (connector.type === 'argocd')
      operation = disconnectArgoCdConnector(config.apiBaseUrl, getCredentials, connector.id);
    else if (connector.type === 'prometheus')
      operation = disconnectPrometheusConnector(config.apiBaseUrl, getCredentials, connector.id);
    else if (connector.type === 'statuscake')
      operation = disconnectStatusCakeConnector(config.apiBaseUrl, getCredentials, connector.id);
    else
      operation = disconnectObservabilityConnector(
        config.apiBaseUrl,
        getCredentials,
        connector.type,
        connector.id,
      );
    return operation
      .then(() => {
        setConfirmDisconnect(null);
        refetch();
        return true;
      })
      .catch((cause) => {
        setMutationError(
          requestErrorMessage(
            cause,
            `${connector.name} disconnect could not be confirmed. Refresh its status before retrying.`,
          ),
        );
        return false;
      })
      .finally(() => setBusyAction(null));
  };

  const openCatalogConnector = (
    type: (typeof CONNECTOR_CATALOG)[number]['type'],
    trigger: HTMLButtonElement,
  ): void => {
    wizardTriggerRef.current = trigger;
    savedDuringSetup.current = false;
    setSelectedConnectorId(null);
    if (type === 'kubernetes') {
      setWizardMode('kubernetes-connect');
    } else if (type === 'argocd') {
      setWizardMode('argocd-connect');
    } else if (type === 'github') {
      setWizardMode('github-connect');
    } else if (type === 'gitlab') {
      setWizardMode('gitlab-connect');
    } else if (type === 'prometheus') {
      setWizardMode('prometheus-connect');
    } else if (type === 'datadog') {
      setWizardMode('datadog-connect');
    } else if (type === 'grafana') {
      setWizardMode('grafana-connect');
    } else {
      setWizardMode('statuscake-connect');
    }
  };
  const openSavedConnector = (connector: ConnectorSummary, trigger: HTMLButtonElement): void => {
    wizardTriggerRef.current = trigger;
    savedDuringSetup.current = false;
    setSelectedConnectorId(connector.id);
    setWizardMode(`${connector.type}-edit` as Exclude<typeof wizardMode, null>);
  };
  const selectedConnector = selectedConnectorId
    ? connectors.find((connector) => connector.id === selectedConnectorId)
    : undefined;

  return (
    <section>
      {mutationError && <InlineAlert message={mutationError} />}
      <ConnectionsContent
        canConfigure={canConfigure}
        loading={loading}
        error={error}
        refetch={refetch}
        onAdd={openCatalogConnector}
        connectors={connectors}
        activeInvestigations={activeInvestigations}
        getCredentials={getCredentials}
        busyAction={busyAction}
        confirmDisconnect={confirmDisconnect}
        onManage={openSavedConnector}
        onRetest={retestConnector}
        onRequestDisconnect={setConfirmDisconnect}
        onCancelDisconnect={() => setConfirmDisconnect(null)}
        onDisconnect={disconnectConnector}
      />

      {(wizardMode === 'kubernetes-connect' || wizardMode === 'kubernetes-edit') && (
        <KubernetesConnectWizard
          mode={wizardMode === 'kubernetes-connect' ? 'connect' : 'edit'}
          connectorId={selectedConnector?.id}
          initialName={selectedConnector?.name}
          initialSettings={
            wizardMode === 'kubernetes-edit'
              ? (selectedConnector?.settings as Partial<KubernetesSettings>)
              : undefined
          }
          credentialConfigured={
            wizardMode === 'kubernetes-edit' && selectedConnector?.credentialConfigured === true
          }
          onFetchManifest={(args) =>
            fetchKubernetesManifest(config.apiBaseUrl, getCredentials, args)
          }
          onSave={(body) =>
            recordSave(saveKubernetesConnector(config.apiBaseUrl, getCredentials, body))
          }
          onRunTest={(id) => testKubernetesConnector(config.apiBaseUrl, getCredentials, id)}
          returnFocusTo={wizardTriggerRef.current}
          onClose={closeWizard}
        />
      )}
      {(wizardMode === 'gitlab-connect' || wizardMode === 'gitlab-edit') && (
        <GitLabConnectWizard
          managementApi={managementApi}
          mode={wizardMode === 'gitlab-connect' ? 'connect' : 'edit'}
          connectorId={selectedConnector?.id}
          initialName={selectedConnector?.name}
          apiBaseUrl={config.apiBaseUrl}
          initialSettings={
            wizardMode === 'gitlab-edit'
              ? (selectedConnector?.settings as Partial<GitLabSettings>)
              : undefined
          }
          initialWebhookPath={selectedConnector?.webhookPath}
          credentialConfigured={selectedConnector?.credentialConfigured === true}
          onDiscover={(body) => discoverGitLabProjects(config.apiBaseUrl, getCredentials, body)}
          onPrepareDelivery={(input) =>
            prepareConnectorDelivery(config.apiBaseUrl, getCredentials, 'gitlab', input)
          }
          onSave={(body) =>
            recordSave(saveGitLabConnector(config.apiBaseUrl, getCredentials, body))
          }
          onRunTest={(id) => testGitLabConnector(config.apiBaseUrl, getCredentials, id)}
          returnFocusTo={wizardTriggerRef.current}
          onClose={closeWizard}
        />
      )}
      {(wizardMode === 'github-connect' || wizardMode === 'github-edit') && (
        <GitHubConnectWizard
          eventFailureCategory={selectedConnector?.events?.failureCategory}
          mode={wizardMode === 'github-connect' ? 'connect' : 'edit'}
          connectorId={selectedConnector?.id}
          initialName={selectedConnector?.name}
          apiBaseUrl={config.apiBaseUrl}
          initialSettings={
            wizardMode === 'github-edit' || manifestCallback
              ? (selectedConnector?.settings as Partial<GitHubSettings>)
              : undefined
          }
          initialWebhookPath={selectedConnector?.webhookPath}
          manifestCallback={manifestCallback}
          onStartManifest={(body) => startGitHubManifest(config.apiBaseUrl, getCredentials, body)}
          onPrepareDelivery={(input) =>
            prepareConnectorDelivery(config.apiBaseUrl, getCredentials, 'github', input)
          }
          onCompleteManifest={async (body) => {
            const completed = await completeGitHubManifest(config.apiBaseUrl, getCredentials, body);
            setManifestCallback(undefined);
            return completed;
          }}
          onDiscoverInstallations={(body) =>
            discoverGitHubInstallations(config.apiBaseUrl, getCredentials, body)
          }
          onSave={(body) =>
            recordSave(saveGitHubConnector(config.apiBaseUrl, getCredentials, body))
          }
          onRunTest={(id) => testGitHubConnector(config.apiBaseUrl, getCredentials, id)}
          returnFocusTo={wizardTriggerRef.current}
          onClose={closeWizard}
        />
      )}
      {(wizardMode === 'argocd-connect' || wizardMode === 'argocd-edit') && (
        <ArgoCdConnectWizard
          mode={wizardMode === 'argocd-connect' ? 'connect' : 'edit'}
          connectorId={selectedConnector?.id}
          initialName={selectedConnector?.name}
          initialSettings={
            wizardMode === 'argocd-edit'
              ? (selectedConnector?.settings as Partial<ArgoCdSettings>)
              : undefined
          }
          onGenerateAccess={(body) => fetchArgoCdAccess(config.apiBaseUrl, getCredentials, body)}
          onSave={(body) =>
            recordSave(saveArgoCdConnector(config.apiBaseUrl, getCredentials, body))
          }
          onRunTest={(id) => testArgoCdConnector(config.apiBaseUrl, getCredentials, id)}
          returnFocusTo={wizardTriggerRef.current}
          onClose={closeWizard}
        />
      )}
      {(wizardMode === 'prometheus-connect' || wizardMode === 'prometheus-edit') && (
        <PrometheusConnectWizard
          mode={wizardMode === 'prometheus-connect' ? 'connect' : 'edit'}
          connectorId={selectedConnector?.id}
          initialName={selectedConnector?.name}
          initialSettings={
            wizardMode === 'prometheus-edit'
              ? (selectedConnector?.settings as Partial<PrometheusSettings>)
              : undefined
          }
          credentialConfigured={selectedConnector?.credentialConfigured === true}
          initialWebhookPath={selectedConnector?.webhookPath}
          apiBaseUrl={config.apiBaseUrl}
          loadChannels={() =>
            listAvailableChannels(config.apiBaseUrl, getCredentials).then(
              (result) => result.channels,
            )
          }
          onSave={(body) =>
            recordSave(savePrometheusConnector(config.apiBaseUrl, getCredentials, body))
          }
          onPrepareDelivery={(input) =>
            prepareConnectorDelivery(config.apiBaseUrl, getCredentials, 'prometheus', input)
          }
          onRunTest={(id) => testPrometheusConnector(config.apiBaseUrl, getCredentials, id)}
          returnFocusTo={wizardTriggerRef.current}
          onClose={closeWizard}
        />
      )}
      {(wizardMode === 'statuscake-connect' || wizardMode === 'statuscake-edit') && (
        <StatusCakeConnectWizard
          mode={wizardMode === 'statuscake-connect' ? 'connect' : 'edit'}
          connectorId={selectedConnector?.id}
          initialName={selectedConnector?.name}
          initialSettings={selectedConnector?.settings}
          credentialConfigured={selectedConnector?.credentialConfigured === true}
          onSave={(body) =>
            recordSave(saveStatusCakeConnector(config.apiBaseUrl, getCredentials, body))
          }
          onRunTest={(id) => testStatusCakeConnector(config.apiBaseUrl, getCredentials, id)}
          loadChannels={() =>
            listAvailableChannels(config.apiBaseUrl, getCredentials).then(
              (result) => result.channels,
            )
          }
          onListTests={(id) => listStatusCakeUptimeTests(config.apiBaseUrl, getCredentials, id)}
          onSetup={(id) => runStatusCakeSetup(config.apiBaseUrl, getCredentials, id)}
          returnFocusTo={wizardTriggerRef.current}
          onClose={closeWizard}
        />
      )}
      {(wizardMode === 'datadog-connect' ||
        wizardMode === 'datadog-edit' ||
        wizardMode === 'grafana-connect' ||
        wizardMode === 'grafana-edit') && (
        <ObservabilityConnectWizard
          type={wizardMode.startsWith('datadog') ? 'datadog' : 'grafana'}
          mode={wizardMode.endsWith('connect') ? 'connect' : 'edit'}
          connectorId={selectedConnector?.id}
          initialName={selectedConnector?.name}
          initialSettings={selectedConnector?.settings}
          credentialConfigured={selectedConnector?.credentialConfigured === true}
          onSave={(body) =>
            recordSave(
              saveObservabilityConnector(
                config.apiBaseUrl,
                getCredentials,
                wizardMode.startsWith('datadog') ? 'datadog' : 'grafana',
                body,
              ),
            )
          }
          onRunTest={(id) =>
            testObservabilityConnector(
              config.apiBaseUrl,
              getCredentials,
              wizardMode.startsWith('datadog') ? 'datadog' : 'grafana',
              id,
            )
          }
          returnFocusTo={wizardTriggerRef.current}
          onClose={closeWizard}
        />
      )}
    </section>
  );
}
