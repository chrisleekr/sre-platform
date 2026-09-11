import { requestErrorMessage } from '../lib/request-error';
import { SetupActions } from './SetupDialogSlots';
import { useState } from 'react';
import type { ConnectorTestResult } from '../lib/connectors';
import { DataSourceNameField } from './DataSourceNameField';
import { SetupDialog } from './SetupDialog';
import { SetupProgress } from './SetupProgress';
import { ConnectorSetupGuide } from './connector-setup/ConnectorSetupGuide';

const DATADOG_SITES = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'uk1.datadoghq.com',
  'ddog-gov.com',
  'us2.ddog-gov.com',
] as const;

type Provider = 'datadog' | 'grafana';

export function ObservabilityConnectWizard({
  type,
  mode,
  connectorId,
  initialName,
  initialSettings,
  credentialConfigured = false,
  onSave,
  onRunTest,
  returnFocusTo,
  onClose,
}: {
  type: Provider;
  mode: 'connect' | 'edit';
  connectorId?: string;
  initialName?: string;
  initialSettings?: Record<string, unknown>;
  credentialConfigured?: boolean;
  onSave: (body: {
    id?: string;
    name: string;
    settings: Record<string, unknown>;
    credential?: string;
    insecureTlsAcknowledged?: boolean;
    insecureHttpAcknowledged?: boolean;
  }) => Promise<{ connectorId: string }>;
  onRunTest: (id: string) => Promise<ConnectorTestResult>;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}) {
  const label = type === 'datadog' ? 'Datadog' : 'Grafana';
  const [step, setStep] = useState(1);
  const [savedConnectorId, setSavedConnectorId] = useState(connectorId);
  const [name, setName] = useState(initialName ?? label);
  const [site, setSite] = useState(
    typeof initialSettings?.site === 'string' ? initialSettings.site : 'datadoghq.com',
  );
  const [baseUrl, setBaseUrl] = useState(
    typeof initialSettings?.baseUrl === 'string' ? initialSettings.baseUrl : '',
  );
  const initialTrust = initialSettings?.insecureSkipTLSVerify
    ? 'insecure'
    : initialSettings?.caConfigured
      ? 'ca'
      : 'system';
  const [trust, setTrust] = useState<'system' | 'ca' | 'insecure'>(initialTrust);
  const [caCert, setCaCert] = useState('');
  const [insecureAcknowledged, setInsecureAcknowledged] = useState(false);
  const [httpAcknowledged, setHttpAcknowledged] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [appKey, setAppKey] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ConnectorTestResult | null>(null);
  const endpointProtocol = (() => {
    try {
      return new URL(baseUrl.trim()).protocol;
    } catch {
      return null;
    }
  })();
  const usesHttp = endpointProtocol === 'http:';
  const usesHttps = endpointProtocol === 'https:';
  const showTls = !baseUrl.trim() || usesHttps;

  const reviewConnection = (): void => {
    if (!name.trim()) {
      setError('Data source name is required.');
      return;
    }
    if (type === 'grafana') {
      try {
        const url = new URL(baseUrl.trim());
        if (
          (url.protocol !== 'http:' && url.protocol !== 'https:') ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error('invalid');
      } catch {
        setError('Enter a Grafana HTTP or HTTPS URL without credentials, query, or fragment.');
        return;
      }
      if (usesHttp && !httpAcknowledged) {
        setError('Acknowledge the unencrypted HTTP transport before continuing.');
        return;
      }
      if (usesHttps && trust === 'ca' && !caCert.trim() && !initialSettings?.caConfigured) {
        setError('Paste the Grafana CA certificate or use system trust.');
        return;
      }
      if (usesHttps && trust === 'insecure' && !insecureAcknowledged) {
        setError('Acknowledge the insecure TLS risk before continuing.');
        return;
      }
    }
    setError('');
    setStep(2);
  };

  const reviewCredentials = (): void => {
    if (type === 'datadog' && Boolean(apiKey.trim()) !== Boolean(appKey.trim())) {
      setError(
        'Enter both Datadog keys to replace the credential, or leave both blank to keep it.',
      );
      return;
    }
    const supplied = type === 'datadog' ? apiKey.trim() && appKey.trim() : token.trim();
    if (!supplied && !(mode === 'edit' && credentialConfigured)) {
      setError(
        type === 'datadog' ? 'Both Datadog keys are required.' : 'A Grafana token is required.',
      );
      return;
    }
    setError('');
    setStep(3);
  };

  const saveAndVerify = (): void => {
    setBusy(true);
    setSubmitted(true);
    setError('');
    void (async () => {
      try {
        const credential =
          type === 'datadog'
            ? apiKey.trim() && appKey.trim()
              ? JSON.stringify({ apiKey: apiKey.trim(), appKey: appKey.trim() })
              : undefined
            : token.trim() || undefined;
        const saved = await onSave({
          ...(savedConnectorId ? { id: savedConnectorId } : {}),
          name: name.trim(),
          settings:
            type === 'datadog'
              ? { site }
              : {
                  baseUrl: baseUrl.trim(),
                  ...(usesHttps && trust === 'ca'
                    ? caCert.trim()
                      ? { caCert: caCert.trim() }
                      : {}
                    : { caCert: '' }),
                  insecureSkipTLSVerify: usesHttps && trust === 'insecure',
                },
          ...(credential ? { credential } : {}),
          ...(usesHttps && trust === 'insecure' ? { insecureTlsAcknowledged: true } : {}),
          ...(usesHttp && httpAcknowledged ? { insecureHttpAcknowledged: true } : {}),
        });
        setSavedConnectorId(saved.connectorId);
        setResult(await onRunTest(saved.connectorId));
        setStep(4);
      } catch (cause) {
        setError(
          requestErrorMessage(
            cause,
            'Save or verification failed. The disabled draft may already exist; review the endpoint and read-only credential, then retry.',
          ),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <SetupDialog
      size="standard"
      title={`${mode === 'edit' ? 'Manage' : 'Connect'} ${label}`}
      closeLabel={submitted || mode === 'edit' ? 'Close' : 'Cancel'}
      busy={busy}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    >
      <SetupProgress steps={['Connection', 'Credentials', 'Review', 'Verify']} current={step} />
      {(step === 1 || step === 2) && (
        <div className="mb-4">
          <ConnectorSetupGuide provider={type} />
        </div>
      )}
      {step === 1 && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="font-semibold">Connect {label} for incident investigation</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Each named connection has isolated credentials, health, and investigator tools.
            </p>
          </div>
          <DataSourceNameField
            value={name}
            onChange={setName}
            placeholder={`Production ${label}`}
          />
          {type === 'datadog' ? (
            <label className="text-sm font-medium">
              Datadog site
              <select
                value={site}
                onChange={(event) => setSite(event.target.value)}
                className="mt-1 w-full rounded border border-line-strong px-2 py-1.5"
              >
                {DATADOG_SITES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label className="text-sm font-medium">
                Grafana base URL
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://127.0.0.1:3000 or https://grafana.example.com"
                  className="mt-1 w-full rounded border border-line-strong px-2 py-1.5"
                />
              </label>
              {showTls ? (
                <fieldset className="space-y-2 text-sm">
                  <legend className="font-medium">HTTPS certificate trust</legend>
                  {(['system', 'ca', 'insecure'] as const).map((value) => (
                    <label key={value} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="grafana-trust"
                        checked={trust === value}
                        onChange={() => setTrust(value)}
                      />
                      {value === 'system'
                        ? 'Use system trust'
                        : value === 'ca'
                          ? 'Pin a CA certificate'
                          : 'Disable verification (development only)'}
                    </label>
                  ))}
                </fieldset>
              ) : usesHttp ? (
                <label className="flex items-start gap-2 rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
                  <input
                    type="checkbox"
                    checked={httpAcknowledged}
                    onChange={(event) => setHttpAcknowledged(event.target.checked)}
                  />
                  I understand HTTP does not encrypt credentials or monitoring data. Use it only on
                  a trusted private network or through the supervised local tunnel.
                </label>
              ) : null}
              {usesHttps && trust === 'ca' && (
                <label className="text-sm font-medium">
                  CA certificate (PEM)
                  <textarea
                    value={caCert}
                    onChange={(event) => setCaCert(event.target.value)}
                    placeholder={
                      initialSettings?.caConfigured ? 'Leave blank to keep the stored CA' : ''
                    }
                    className="mt-1 h-24 w-full rounded border border-line-strong px-2 py-1.5 font-instrument text-xs"
                  />
                </label>
              )}
              {usesHttps && trust === 'insecure' && (
                <label className="flex items-start gap-2 text-sm text-critical">
                  <input
                    type="checkbox"
                    checked={insecureAcknowledged}
                    onChange={(event) => setInsecureAcknowledged(event.target.checked)}
                  />
                  I understand this disables server identity verification.
                </label>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              onClick={reviewConnection}
              className="self-start rounded bg-strong px-3 py-1.5 font-medium text-on-strong"
            >
              Credentials
            </button>
          </SetupActions>
        </div>
      )}
      {step === 2 && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="font-semibold">Paste read-only credentials</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Use existing credentials with the required read permissions. Create new credentials
              only if needed. Credentials are encrypted and never returned.
            </p>
          </div>
          {type === 'datadog' ? (
            <>
              <label className="text-sm font-medium">
                API key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="mt-1 w-full rounded border border-line-strong px-2 py-1.5"
                />
              </label>
              <label className="text-sm font-medium">
                Application key
                <input
                  type="password"
                  value={appKey}
                  onChange={(event) => setAppKey(event.target.value)}
                  className="mt-1 w-full rounded border border-line-strong px-2 py-1.5"
                />
              </label>
            </>
          ) : (
            <label className="text-sm font-medium">
              Service account token
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                className="mt-1 w-full rounded border border-line-strong px-2 py-1.5"
              />
            </label>
          )}
          {mode === 'edit' && credentialConfigured && (
            <p className="text-xs text-ink-muted">
              Leave credential fields blank to keep the stored credential.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button type="button" onClick={() => setStep(1)} className="rounded border px-3 py-1.5">
              Back
            </button>
            <button
              type="button"
              onClick={reviewCredentials}
              className="rounded bg-strong px-3 py-1.5 font-medium text-on-strong"
            >
              Review
            </button>
          </SetupActions>
        </div>
      )}
      {step === 3 && (
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold">Review {name}</h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 rounded border border-line p-3 text-sm">
            <dt className="font-medium">Provider</dt>
            <dd>{label}</dd>
            <dt className="font-medium">Endpoint</dt>
            <dd>{type === 'datadog' ? site : baseUrl}</dd>
            <dt className="font-medium">Access</dt>
            <dd>On-demand, read-only investigation tools</dd>
          </dl>
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button type="button" onClick={() => setStep(2)} className="rounded border px-3 py-1.5">
              Back
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={saveAndVerify}
              className="rounded bg-strong px-3 py-1.5 font-medium text-on-strong disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Save and verify'}
            </button>
          </SetupActions>
        </div>
      )}
      {step === 4 && result && (
        <div className="flex flex-col gap-4">
          <h2
            className={`font-semibold ${result.status === 'healthy' ? 'text-success' : 'text-critical'}`}
          >
            {result.status === 'healthy'
              ? `${name} enabled.`
              : 'Verification failed; this connection remains disabled.'}
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>Endpoint reachable: {result.reachable ? 'yes' : 'no'}</li>
            <li>Credential authorized: {result.authorized ? 'yes' : 'no'}</li>
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <SetupActions>
            <button
              type="button"
              onClick={onClose}
              className="self-start rounded bg-strong px-3 py-1.5 font-medium text-on-strong"
            >
              Finish
            </button>
          </SetupActions>
        </div>
      )}
    </SetupDialog>
  );
}
