import { requestErrorMessage } from '../lib/request-error';
import type { PrepareDelivery } from '../lib/connector-delivery';
import { usePreparedDelivery } from './connector-setup/usePreparedDelivery';
import { DeliveryPreparationStatus } from './connector-setup/DeliveryPreparationStatus';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  GitHubInstallationSummary,
  GitHubSettings,
  GitHubTestResult,
} from '../lib/connectors';
import type { GitHubManifestComplete, GitHubManifestStart } from '../lib/useConnectors';
import { SetupDialog } from './SetupDialog';
import { SetupProgress } from './SetupProgress';
import { GitHubAppStep } from './github-connect/AppStep';
import { GitHubRemainingSteps } from './github-connect/RemainingSteps';
import {
  PUBLIC_API_CONFIGURATION_ERROR,
  publicApiOrigin,
  publicWebhookUrl,
} from './connector-setup/event-delivery';
import type { GitHubWizardViewModel } from './github-connect/view-model';

const STEPS = ['App', 'Installation', 'Coverage', 'Review', 'Verify'];
type Owner = 'personal' | 'organization';
type SetupPath = 'dedicated' | 'existing';
type DeliveryMode = 'smee' | 'direct';

export interface GitHubConnectWizardProps {
  mode: 'connect' | 'edit';
  connectorId?: string;
  initialName?: string;
  apiBaseUrl: string;
  initialSettings?: Partial<GitHubSettings>;
  initialWebhookPath?: string;
  eventFailureCategory?: string | null;
  manifestCallback?: { code: string; state: string };
  onStartManifest: (body: {
    setupId?: string;
    name: string;
    ownerType: Owner;
    organization?: string;
    deliveryMode: DeliveryMode;
    deliveryUrl: string;
    dashboardUrl: string;
  }) => Promise<GitHubManifestStart>;
  onCompleteManifest: (body: { code: string; state: string }) => Promise<GitHubManifestComplete>;
  onDiscoverInstallations: (body: {
    dataSourceId?: string;
    appId: string;
    credential?: string;
  }) => Promise<GitHubInstallationSummary[]>;
  onPrepareDelivery: PrepareDelivery;
  onSave: (body: {
    setupId?: string;
    id?: string;
    name: string;
    settings: GitHubSettings;
    credential?: string;
    webhookSecret?: string;
  }) => Promise<{
    connectorId: string;
    name: string;
    webhookPath?: string;
    relayStatus?: 'connected' | 'stopped' | 'failed';
  }>;
  onRunTest: (id: string) => Promise<GitHubTestResult>;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}

function permission(installation: GitHubInstallationSummary | undefined, name: string): string {
  return installation?.permissions[name] ?? 'not granted';
}

export function GitHubConnectWizard({
  mode,
  connectorId,
  initialName,
  apiBaseUrl,
  initialSettings,
  initialWebhookPath,
  eventFailureCategory,
  manifestCallback,
  onStartManifest,
  onCompleteManifest,
  onDiscoverInstallations,
  onPrepareDelivery,
  onSave,
  onRunTest,
  returnFocusTo,
  onClose,
}: GitHubConnectWizardProps) {
  const [step, setStep] = useState(1);
  const [dataSourceId, setDataSourceId] = useState(connectorId);
  const [dataSourceName, setDataSourceName] = useState(initialName ?? 'GitHub');
  const [setupPath, setSetupPath] = useState<SetupPath>('dedicated');
  const [owner, setOwner] = useState<Owner>('personal');
  const [organization, setOrganization] = useState('');
  const [deliveryMode, updateDeliveryMode] = useState<DeliveryMode>(
    initialSettings?.eventTransport ??
      (typeof window !== 'undefined' && window.location.hostname === 'localhost'
        ? 'smee'
        : 'direct'),
  );
  const [smeeUrl, setDeliveryUrl] = useState('');
  const deliveryUrl = deliveryMode === 'direct' ? publicApiOrigin(apiBaseUrl) : smeeUrl;
  const setDeliveryMode = (next: DeliveryMode): void => {
    updateDeliveryMode(next);
  };
  const [appId, setAppId] = useState(initialSettings?.appId ?? '');
  const [appSlug, setAppSlug] = useState(initialSettings?.appSlug ?? '');
  const [privateKey, setPrivateKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [installUrl, setInstallUrl] = useState('');
  const [webhookPath, setWebhookPath] = useState(initialWebhookPath ?? '');
  const [manifestSmeeStored, setManifestSmeeStored] = useState(false);

  const preparation = usePreparedDelivery({
    transport: deliveryMode,
    hasSmeeUrl: Boolean(smeeUrl.trim()),
    existing: Boolean(dataSourceId) || Boolean(manifestCallback),
    storedSmee:
      manifestSmeeStored ||
      Boolean(manifestCallback) ||
      (initialSettings?.eventTransport === 'smee' && Boolean(initialSettings.smeeConfigured)),
    initialPath: initialWebhookPath,
    prepare: onPrepareDelivery,
  });
  useEffect(() => {
    if (preparation.smeeUrl) setDeliveryUrl((current) => current || preparation.smeeUrl!);
  }, [preparation.smeeUrl]);
  const [relayStatus, setRelayStatus] = useState<'connected' | 'stopped' | 'failed' | undefined>();
  const [installations, setInstallations] = useState<GitHubInstallationSummary[]>([]);
  const [installationId, setInstallationId] = useState(
    String(initialSettings?.installationId ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<GitHubTestResult | null>(null);
  const completionStarted = useRef(false);

  const selectedInstallation = useMemo(
    () => installations.find((item) => String(item.id) === installationId),
    [installationId, installations],
  );
  const writePermissions = selectedInstallation?.writePermissions ?? [];

  useEffect(() => {
    if (!manifestCallback || completionStarted.current) return;
    completionStarted.current = true;
    setBusy(true);
    setError('');
    void onCompleteManifest(manifestCallback)
      .then((completed) => {
        setSetupPath('dedicated');
        setDataSourceId(completed.connectorId);
        setDataSourceName(completed.name);
        setAppId(completed.appId);
        setAppSlug(completed.appSlug);
        setInstallUrl(completed.installUrl);
        updateDeliveryMode(completed.eventTransport);
        setManifestSmeeStored(completed.eventTransport === 'smee');
        setWebhookPath(completed.localWebhookPath);
        setRelayStatus(completed.relayStatus);
        window.history.replaceState({}, '', window.location.pathname);
      })
      .catch((cause) =>
        setError(
          requestErrorMessage(
            cause,
            'GitHub created the App, but SRE Platform could not import its credentials.',
          ),
        ),
      )
      .finally(() => setBusy(false));
  }, [manifestCallback, onCompleteManifest, apiBaseUrl]);

  const startManifest = (): void => {
    if (preparation.busy || preparation.error || (!dataSourceId && !preparation.setupId)) {
      setError('Wait for webhook preparation, or retry it before continuing.');
      return;
    }

    if (!dataSourceName.trim()) {
      setError('Data source name is required.');
      return;
    }
    if (owner === 'organization' && !organization.trim()) {
      setError('Enter the organization that should own the dedicated App.');
      return;
    }
    if (!deliveryUrl.trim()) {
      setError(
        deliveryMode === 'smee'
          ? 'Create a Smee channel and paste its HTTPS URL.'
          : PUBLIC_API_CONFIGURATION_ERROR,
      );
      return;
    }
    setBusy(true);
    setError('');
    void onStartManifest({
      ...(preparation.setupId ? { setupId: preparation.setupId } : {}),
      name: dataSourceName.trim(),
      ownerType: owner,
      ...(owner === 'organization' ? { organization: organization.trim() } : {}),
      deliveryMode,
      deliveryUrl: deliveryUrl.trim(),
      dashboardUrl: window.location.origin,
    })
      .then((started) => {
        const form = document.createElement('form');
        form.method = 'post';
        form.action = started.actionUrl;
        const manifest = document.createElement('input');
        manifest.type = 'hidden';
        manifest.name = 'manifest';
        manifest.value = JSON.stringify(started.manifest);
        form.append(manifest);
        document.body.append(form);
        form.submit();
      })
      .catch((cause) => {
        setBusy(false);
        setError(
          requestErrorMessage(cause, 'Could not start the dedicated GitHub App registration.'),
        );
      });
  };

  const discoverInstallations = (): void => {
    if (!dataSourceName.trim()) {
      setError('Data source name is required.');
      return;
    }
    if (!appId.trim()) {
      setError('A GitHub App ID is required.');
      return;
    }
    if (webhookSecret.trim() && webhookSecret.trim().length < 16) {
      setError(
        'The replacement webhook secret must contain at least 16 characters. Leave it blank to keep the saved secret.',
      );
      return;
    }
    if (setupPath === 'existing' && mode === 'connect' && !privateKey.trim()) {
      setError('Paste the existing dedicated App private key.');
      return;
    }
    if (setupPath === 'existing' && mode === 'connect' && webhookSecret.trim().length < 16) {
      setError('Enter the dedicated App webhook secret.');
      return;
    }
    if (deliveryMode === 'direct' && !deliveryUrl) {
      setError(PUBLIC_API_CONFIGURATION_ERROR);
      return;
    }
    const deliveryChanged = mode === 'edit' && initialSettings?.eventTransport !== deliveryMode;
    if (
      ((setupPath === 'existing' && mode === 'connect') || deliveryChanged) &&
      !deliveryUrl.trim()
    ) {
      setError(
        deliveryMode === 'smee'
          ? "Enter the existing App's Smee channel URL."
          : PUBLIC_API_CONFIGURATION_ERROR,
      );
      return;
    }
    if (deliveryUrl.trim()) {
      try {
        const url = new URL(deliveryUrl.trim());
        const valid =
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (deliveryMode === 'smee' ? url.hostname === 'smee.io' : url.pathname === '/');
        if (!valid) throw new Error('invalid event delivery URL');
      } catch {
        setError(
          deliveryMode === 'smee'
            ? 'Use an https://smee.io channel URL.'
            : PUBLIC_API_CONFIGURATION_ERROR,
        );
        return;
      }
    }
    setBusy(true);
    setError('');
    void onDiscoverInstallations({
      ...(dataSourceId ? { dataSourceId } : {}),
      appId: appId.trim(),
      ...(privateKey.trim() ? { credential: privateKey.trim() } : {}),
    })
      .then((items) => {
        if (items.length === 0) {
          setError('Install this GitHub App on an account before continuing.');
          return;
        }
        setInstallations(items);
        const existing = items.find(
          (item) => String(item.id) === String(initialSettings?.installationId ?? ''),
        );
        const selected = existing ?? items[0]!;
        setInstallationId(String(selected.id));
        if (selected.appSlug) setAppSlug(selected.appSlug);
        setStep(2);
      })
      .catch((failure: unknown) =>
        setError(
          requestErrorMessage(
            failure,
            'GitHub installation discovery failed. Check the App installation and key.',
          ),
        ),
      )
      .finally(() => setBusy(false));
  };

  const review = (): void => {
    if (!selectedInstallation) {
      setError('Choose an installation.');
      return;
    }
    if (permission(selectedInstallation, 'contents') === 'not granted') {
      setError('Contents read permission is required for code diagnosis.');
      return;
    }
    if (writePermissions.length > 0) {
      setError(
        `This App can write ${writePermissions.join(', ')}. Use the generated dedicated App so a compromised private key cannot mutate GitHub.`,
      );
      return;
    }
    setError('');
    setStep(4);
  };

  const saveAndVerify = (): void => {
    if (preparation.busy || preparation.error || (!dataSourceId && !preparation.setupId)) {
      setError('Wait for webhook preparation, or retry it before continuing.');
      return;
    }

    if (!selectedInstallation) return;
    setBusy(true);
    setSubmitted(true);
    setError('');
    void (async () => {
      try {
        const saved = await onSave({
          ...(!dataSourceId && preparation.setupId ? { setupId: preparation.setupId } : {}),
          ...(dataSourceId ? { id: dataSourceId } : {}),
          name: dataSourceName.trim(),
          settings: {
            appId: appId.trim(),
            installationId,
            accountLogin: selectedInstallation.accountLogin,
            repositorySelection: selectedInstallation.repositorySelection,
            permissions: selectedInstallation.permissions,
            ...(appSlug ? { appSlug } : {}),
            eventTransport: deliveryMode,
            ...(deliveryMode === 'smee' && deliveryUrl.trim()
              ? { smeeUrl: deliveryUrl.trim() }
              : {}),
          },
          ...(privateKey.trim() ? { credential: privateKey.trim() } : {}),
          ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
        });
        if (saved.webhookPath) setWebhookPath(saved.webhookPath);
        setDataSourceId(saved.connectorId);
        setRelayStatus(saved.relayStatus);
        setResult(await onRunTest(saved.connectorId));
        setStep(5);
      } catch (cause) {
        setError(
          requestErrorMessage(
            cause,
            'Save or verification failed. The disabled connection may already exist; review the values and retry.',
          ),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  const eventEndpoint = publicWebhookUrl(deliveryUrl, webhookPath || preparation.webhookPath || '');
  const view: GitHubWizardViewModel = {
    mode,
    eventFailureCategory,
    initialSettings,
    step,
    setStep,
    dataSourceId,
    dataSourceName,
    setDataSourceName,
    setupPath,
    setSetupPath,
    owner,
    setOwner,
    organization,
    setOrganization,
    deliveryMode,
    setDeliveryMode,
    deliveryUrl,
    setDeliveryUrl,
    appId,
    setAppId,
    appSlug,
    privateKey,
    setPrivateKey,
    webhookSecret,
    setWebhookSecret,
    installUrl,
    relayStatus,
    installations,
    installationId,
    setInstallationId,
    busy,
    submitted,
    error,
    result,
    selectedInstallation,
    writePermissions,
    startManifest,
    discoverInstallations,
    review,
    saveAndVerify,
    eventEndpoint,
    onClose,
  };

  return (
    <SetupDialog
      title={mode === 'edit' ? 'Manage GitHub App' : 'Connect GitHub App'}
      closeLabel={submitted || mode === 'edit' ? 'Close' : 'Cancel'}
      busy={busy}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    >
      <SetupProgress steps={STEPS} current={step} />
      <DeliveryPreparationStatus
        busy={preparation.busy}
        error={preparation.error}
        retry={preparation.retry}
      />
      <GitHubAppStep view={view} />
      <GitHubRemainingSteps view={view} />
    </SetupDialog>
  );
}
