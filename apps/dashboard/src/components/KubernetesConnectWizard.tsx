import { RequestError, requestErrorMessage } from '../lib/request-error';
import { SetupActions } from './SetupDialogSlots';
import { useCallback, useState } from 'react';
import type { KubernetesSettings, KubernetesTestResult } from '../lib/connectors';
import { DataSourceNameField } from './DataSourceNameField';
import { KubernetesVerification } from './KubernetesVerification';
import { KubernetesAccessStep } from './KubernetesAccessStep';
import { KubernetesCredentialHelp } from './KubernetesCredentialHelp';
import { SetupCommand } from './SetupCommand';
import { SetupDialog } from './SetupDialog';
import { SetupProgress } from './SetupProgress';
import { ConnectorSetupGuide } from './connector-setup/ConnectorSetupGuide';

import {
  INSTALL_NAMESPACE,
  SERVICE_ACCOUNT,
  STEPS,
  isPrivateApiUrl,
  type KubernetesConnectWizardProps,
} from './KubernetesConnectSupport';

export function KubernetesConnectWizard({
  mode,
  connectorId,
  initialName,
  initialSettings,
  credentialConfigured = false,
  onFetchManifest,
  onSave,
  onRunTest,
  returnFocusTo,
  onClose,
}: KubernetesConnectWizardProps) {
  const [step, setStep] = useState(1);
  const [savedConnectorId, setSavedConnectorId] = useState(connectorId);
  const [accessMode, setAccessMode] = useState<'existing' | 'create'>('existing');
  const [dataSourceName, setDataSourceName] = useState(initialName ?? 'Kubernetes');
  const [accessId] = useState(
    () => initialSettings?.accessId ?? (mode === 'connect' ? crypto.randomUUID().slice(0, 8) : ''),
  );
  const accessSuffix = accessId ? `-${accessId}` : '';
  const installNamespace = `${INSTALL_NAMESPACE}${accessSuffix}`;
  const serviceAccount = `${SERVICE_ACCOUNT}${accessSuffix}`;
  const tokenSecret = `${serviceAccount}-token`;
  const tokenCommand = `kubectl -n ${installNamespace} get secret ${tokenSecret} -o jsonpath='{.data.token}' | base64 -d`;
  const caCommand = `kubectl -n ${installNamespace} get secret ${tokenSecret} -o jsonpath='{.data.ca\\.crt}' | base64 -d`;
  const [name, setName] = useState(initialSettings?.name ?? '');
  const [apiUrl, setApiUrl] = useState(initialSettings?.apiUrl ?? '');
  const [namespace, setNamespace] = useState(initialSettings?.namespace ?? '');
  const initialTrust = initialSettings?.insecureSkipTLSVerify
    ? 'insecure'
    : initialSettings?.caConfigured
      ? 'ca'
      : 'system';
  const [trust, setTrust] = useState<'system' | 'ca' | 'insecure'>(initialTrust);
  const [insecureAcknowledged, setInsecureAcknowledged] = useState(false);
  const [manifest, setManifest] = useState('');
  const [manifestError, setManifestError] = useState('');
  const [token, setToken] = useState('');
  const [caCert, setCaCert] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [duplicateName, setDuplicateName] = useState(false);
  const [result, setResult] = useState<KubernetesTestResult | null>(null);

  const serverChanged =
    mode === 'edit' &&
    initialSettings?.apiUrl !== undefined &&
    apiUrl.trim() !== initialSettings.apiUrl;
  const needsToken =
    accessMode === 'create' || mode === 'connect' || serverChanged || !credentialConfigured;
  const needsCa = trust === 'ca' && !(mode === 'edit' && initialSettings?.caConfigured);
  const privateWithSystemTrust = isPrivateApiUrl(apiUrl) && trust === 'system';
  const passed = result?.status === 'healthy';

  const loadManifest = useCallback((): void => {
    setManifest('');
    setManifestError('');
    void onFetchManifest({
      namespace: installNamespace,
      serviceAccount,
    }).then(setManifest, (cause) =>
      setManifestError(requestErrorMessage(cause, 'Failed to load the RBAC install command.')),
    );
  }, [installNamespace, onFetchManifest, serviceAccount]);

  const continueFromCluster = (): void => {
    if (!dataSourceName.trim()) {
      setError('Data source name is required.');
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(apiUrl.trim());
    } catch {
      setError('Enter a valid Kubernetes API server URL.');
      return;
    }
    if (parsed.protocol !== 'https:') {
      setError('The Kubernetes API server URL must use HTTPS.');
      return;
    }
    if (privateWithSystemTrust) {
      setError('A private API server requires a pinned CA or an explicit insecure opt-in.');
      return;
    }
    if (trust === 'insecure' && !insecureAcknowledged) {
      setError('Acknowledge the insecure TLS risk before continuing.');
      return;
    }
    setError('');
    setStep(2);
    if (accessMode === 'create') loadManifest();
  };

  const continueFromCredentials = (): void => {
    if (needsToken && !token.trim()) {
      setError(
        serverChanged
          ? 'Paste a token from the new cluster because the API server changed.'
          : 'Paste the service account token.',
      );
      return;
    }
    if (needsCa && !caCert.trim()) {
      setError('Paste the CA certificate used by this cluster.');
      return;
    }
    setError('');
    setStep(4);
  };

  const saveAndVerify = (): void => {
    setSubmitted(true);
    setBusy(true);
    setError('');
    setDuplicateName(false);
    void (async () => {
      try {
        const settings: KubernetesSettings = {
          ...(accessId ? { accessId } : {}),
          name: name.trim() || undefined,
          apiUrl: apiUrl.trim(),
          namespace: namespace.trim(),
          ...(trust === 'ca' ? (caCert.trim() ? { caCert: caCert.trim() } : {}) : { caCert: '' }),
          insecureSkipTLSVerify: trust === 'insecure',
        };
        const saved = await onSave({
          ...(savedConnectorId ? { id: savedConnectorId } : {}),
          name: dataSourceName.trim(),
          settings,
          ...(token.trim() ? { credential: token.trim() } : {}),
          enabled: false,
        });
        setSavedConnectorId(saved.connectorId);
        setResult(await onRunTest(saved.connectorId));
        setStep(5);
      } catch (cause) {
        setDuplicateName(
          cause instanceof RequestError && cause.code === 'duplicate_data_source_name',
        );
        setError(
          requestErrorMessage(
            cause,
            'Save or verification failed. The disabled draft may already exist; review the values and retry.',
          ),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <SetupDialog
      title={mode === 'edit' ? 'Manage Kubernetes' : 'Connect Kubernetes'}
      closeLabel={submitted || mode === 'edit' ? 'Close' : 'Cancel'}
      busy={busy}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    >
      <SetupProgress steps={STEPS} current={step} />
      {step === 1 && (
        <div className="mb-4">
          <ConnectorSetupGuide provider="kubernetes" />
        </div>
      )}

      {step === 1 && (
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="font-medium text-ink">Connect to one Kubernetes cluster</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Name the cluster, choose the monitored namespace scope, and define how its API server
              certificate is trusted.
            </p>
          </div>
          <DataSourceNameField
            value={dataSourceName}
            onChange={setDataSourceName}
            placeholder="Production Kubernetes"
          />
          <label className="text-sm font-medium">
            Cluster name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="prod-us-east"
              className="sre-field mt-1 min-w-0 w-full"
            />
          </label>
          <label className="text-sm font-medium">
            API server URL
            <input
              type="url"
              value={apiUrl}
              onChange={(event) => {
                setApiUrl(event.target.value);
                setToken('');
              }}
              placeholder="https://api.k8s.example.com"
              className="sre-field mt-1 min-w-0 w-full"
            />
          </label>
          <label className="text-sm font-medium">
            Namespace to monitor (optional)
            <input
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              placeholder="default"
              className="sre-field mt-1 min-w-0 w-full"
            />
            <span className="mt-1 block text-xs font-normal text-ink-muted">
              Leave blank to monitor all namespaces.
            </span>
          </label>
          <fieldset className="space-y-2">
            <legend className="font-medium">API server certificate trust</legend>
            {(['system', 'ca', 'insecure'] as const).map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="kubernetes-tls"
                  checked={trust === option}
                  onChange={() => setTrust(option)}
                />
                {option === 'system'
                  ? 'Use system trust'
                  : option === 'ca'
                    ? 'Pin the cluster CA certificate'
                    : 'Disable certificate verification'}
              </label>
            ))}
          </fieldset>
          {trust === 'ca' && mode === 'edit' && initialSettings?.caConfigured && (
            <p className="text-xs text-ink-muted">
              A CA is configured. The stored PEM is never prefilled; leave the CA field blank later
              to keep it.
            </p>
          )}
          {trust === 'insecure' && (
            <label className="flex items-start gap-2 rounded border border-critical-line bg-critical-soft p-3 text-sm text-critical">
              <input
                type="checkbox"
                checked={insecureAcknowledged}
                onChange={(event) => setInsecureAcknowledged(event.target.checked)}
              />
              I understand that disabling TLS verification permits API server impersonation.
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              onClick={continueFromCluster}
              className="sre-action sre-action-primary self-start"
            >
              Continue
            </button>
          </SetupActions>
        </div>
      )}

      {step === 2 && (
        <div className="flex min-w-0 flex-col gap-4">
          <KubernetesAccessStep
            accessMode={accessMode}
            onAccessModeChange={(value) => {
              setAccessMode(value);
              if (value === 'create' && !manifest) loadManifest();
            }}
            keepStoredCredential={mode === 'edit' && credentialConfigured && !serverChanged}
            manifest={manifest}
            error={manifestError}
            onRetry={loadManifest}
          />
          <SetupActions>
            <button type="button" onClick={() => setStep(1)} className="sre-action">
              Back
            </button>
            <button
              type="button"
              disabled={accessMode === 'create' && !manifest}
              onClick={() => {
                setError('');
                setStep(3);
              }}
              className="sre-action sre-action-primary"
            >
              Continue
            </button>
          </SetupActions>
        </div>
      )}

      {step === 3 && (
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="font-medium text-ink">
              {accessMode === 'create'
                ? 'Copy the generated credentials'
                : 'Use your existing credentials'}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              {accessMode === 'create'
                ? 'Run each command against the target cluster, then paste its output below.'
                : 'Use the token for your existing read-only service account, not an administrator token or personal kubeconfig.'}{' '}
              Credentials are encrypted at rest, write-only in this UI, and never shown again.
            </p>
          </div>
          {accessMode === 'create' && (
            <SetupCommand command={tokenCommand} copyLabel="Copy token command" />
          )}
          {accessMode === 'existing' && <KubernetesCredentialHelp />}
          <label className="text-sm font-medium">
            Service account token
            <textarea
              value={token}
              onChange={(event) => setToken(event.target.value)}
              rows={3}
              autoComplete="new-password"
              className="sre-field mt-1 min-w-0 w-full resize-y font-instrument text-xs"
            />
            <span className="mt-1 block text-xs font-normal text-ink-muted">
              {needsToken
                ? 'Required for this connection.'
                : 'Leave blank to keep the stored token.'}
            </span>
          </label>
          {trust === 'ca' && (
            <>
              {accessMode === 'create' && (
                <SetupCommand command={caCommand} copyLabel="Copy CA command" />
              )}
              <label className="text-sm font-medium">
                CA certificate (PEM)
                <textarea
                  value={caCert}
                  onChange={(event) => setCaCert(event.target.value)}
                  rows={5}
                  className="sre-field mt-1 min-w-0 w-full resize-y font-instrument text-xs"
                />
                <span className="mt-1 block text-xs font-normal text-ink-muted">
                  {mode === 'edit' && initialSettings?.caConfigured
                    ? 'Leave blank to keep the stored CA. The PEM is never prefilled.'
                    : accessMode === 'create'
                      ? 'Paste the cluster CA returned by the command above.'
                      : 'Paste the CA certificate for this API server, provided by your cluster administrator.'}
                </span>
              </label>
            </>
          )}
          {serverChanged && (
            <p className="rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
              The API server changed. A token from the new cluster is required; the stored token is
              not reused across clusters.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button type="button" onClick={() => setStep(2)} className="sre-action">
              Back
            </button>
            <button
              type="button"
              onClick={continueFromCredentials}
              className="sre-action sre-action-primary"
            >
              Review
            </button>
          </SetupActions>
        </div>
      )}

      {step === 4 && (
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="font-medium text-ink">Review and verify Kubernetes</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Saving creates a disabled draft. Verification checks reachability and pod access, and
              reports whether the credential can read Secrets.
            </p>
          </div>
          <dl className="grid gap-2 rounded border border-line p-3 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="font-medium">Access</dt>
            <dd>
              {accessMode === 'existing'
                ? 'Existing service account and RBAC'
                : 'Dedicated service account installation'}
            </dd>
            <dt className="font-medium">Cluster</dt>
            <dd>{name.trim() || 'Unnamed cluster'}</dd>
            <dt className="font-medium">API server</dt>
            <dd className="break-all">{apiUrl.trim()}</dd>
            <dt className="font-medium">Namespace scope</dt>
            <dd>{namespace.trim() || 'All namespaces'}</dd>
            <dt className="font-medium">TLS trust</dt>
            <dd>
              {trust === 'system'
                ? 'System trust'
                : trust === 'ca'
                  ? 'Pinned cluster CA'
                  : 'Verification disabled'}
            </dd>
            <dt className="font-medium">Token</dt>
            <dd>{token.trim() ? 'Replace stored token' : 'Keep stored token'}</dd>
          </dl>
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            {duplicateName && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setStep(1);
                }}
                className="sre-action"
              >
                Edit data source name
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => setStep(3)} className="sre-action">
              Back
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={saveAndVerify}
              className="sre-action sre-action-primary"
            >
              {busy ? 'Verifying…' : 'Save and verify'}
            </button>
          </SetupActions>
        </div>
      )}

      {step === 5 && result && (
        <KubernetesVerification
          result={result}
          passed={passed}
          onBack={() => setStep(4)}
          onClose={onClose}
        />
      )}
    </SetupDialog>
  );
}
