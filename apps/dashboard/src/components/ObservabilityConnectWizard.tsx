import { ObservabilityVerificationResult } from './ObservabilityVerificationResult';
import { NativeAlertEventFields } from './NativeAlertEventFields';
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
    eventToken?: string;
    insecureTlsAcknowledged?: boolean;
    insecureHttpAcknowledged?: boolean;
  }) => Promise<{ connectorId: string; webhookPath?: string }>;
  onRunTest: (id: string) => Promise<ConnectorTestResult>;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}) {
  const label = type === 'datadog' ? 'Datadog' : 'Grafana';
  const [step, setStep] = useState(1);
  const [persisted, setPersisted] = useState({ connectorId, webhookPath: '' });
  const [name, setName] = useState(initialName ?? label);
  const [site, setSite] = useState(
    typeof initialSettings?.site === 'string' ? initialSettings.site : 'datadoghq.com',
  );
  const [collectApm, setCollectApm] = useState(
    typeof initialSettings?.collectApm === 'boolean'
      ? initialSettings.collectApm
      : Boolean(connectorId),
  );
  const [collectLogs, setCollectLogs] = useState(initialSettings?.collectLogs === true);
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
  const [eventDelivery, setEventDelivery] = useState(initialSettings?.eventTransport === 'direct');
  const [alertChannel, setAlertChannel] = useState(String(initialSettings?.alertChannel ?? ''));
  const [eventToken, setEventToken] = useState('');
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
          ...(persisted.connectorId ? { id: persisted.connectorId } : {}),
          name: name.trim(),
          settings:
            type === 'datadog'
              ? {
                  site,
                  collectApm,
                  collectLogs,
                  eventTransport: eventDelivery ? 'direct' : 'none',
                  alertChannel: alertChannel.trim(),
                }
              : {
                  baseUrl: baseUrl.trim(),
                  eventTransport: eventDelivery ? 'direct' : 'none',
                  alertChannel: alertChannel.trim(),
                  ...(usesHttps && trust === 'ca'
                    ? caCert.trim()
                      ? { caCert: caCert.trim() }
                      : {}
                    : { caCert: '' }),
                  insecureSkipTLSVerify: usesHttps && trust === 'insecure',
                },
          ...(credential ? { credential } : {}),
          ...(eventToken.trim() ? { eventToken: eventToken.trim() } : {}),
          ...(usesHttps && trust === 'insecure' ? { insecureTlsAcknowledged: true } : {}),
          ...(usesHttp && httpAcknowledged ? { insecureHttpAcknowledged: true } : {}),
        });
        setPersisted({ ...saved, webhookPath: saved.webhookPath ?? '' });
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
            <h2 className="font-medium">Connect {label} for incident investigation</h2>
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
            <>
              <label className="text-sm font-medium">
                Datadog site
                <select
                  value={site}
                  onChange={(event) => setSite(event.target.value)}
                  className="sre-field mt-1 w-full"
                >
                  {DATADOG_SITES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={collectLogs}
                  onChange={(event) => setCollectLogs(event.target.checked)}
                />
                <span>
                  Discover traffic from logs (optional)
                  <span className="mt-1 block text-xs text-ink-muted">
                    Sample ingress and gRPC request logs for this workspace’s verified Kubernetes
                    clusters. No APM required. Needs log-read permission; sampled traffic is not a
                    complete dependency inventory.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={collectApm}
                  onChange={(event) => setCollectApm(event.target.checked)}
                />
                <span>
                  Collect APM service-call evidence (optional)
                  <span className="mt-1 block text-xs text-ink-muted">
                    Enable only if this organization has indexed APM spans. Hosts, monitors and
                    catalog declarations are collected independently; metrics and logs remain
                    available for investigations.
                  </span>
                </span>
              </label>
            </>
          ) : (
            <>
              <label className="text-sm font-medium">
                Grafana base URL
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://127.0.0.1:3000 or https://grafana.example.com"
                  className="sre-field mt-1 w-full"
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
                    className="sre-field mt-1 h-24 w-full font-instrument text-xs"
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
          <NativeAlertEventFields
            eventDelivery={eventDelivery}
            setEventDelivery={setEventDelivery}
            alertChannel={alertChannel}
            setAlertChannel={setAlertChannel}
            eventToken={eventToken}
            setEventToken={setEventToken}
            credentialConfigured={Boolean(initialSettings?.eventCredentialConfigured)}
          />
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              onClick={reviewConnection}
              className="sre-action sre-action-primary self-start"
            >
              Credentials
            </button>
          </SetupActions>
        </div>
      )}
      {step === 2 && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="font-medium">Paste read-only credentials</h2>
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
                  className="sre-field mt-1 w-full"
                />
              </label>
              <label className="text-sm font-medium">
                Application key
                <input
                  type="password"
                  value={appKey}
                  onChange={(event) => setAppKey(event.target.value)}
                  className="sre-field mt-1 w-full"
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
                className="sre-field mt-1 w-full"
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
              className="sre-action sre-action-primary"
            >
              Review
            </button>
          </SetupActions>
        </div>
      )}
      {step === 3 && (
        <div className="flex flex-col gap-4">
          <h2 className="font-medium">Review {name}</h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 rounded border border-line p-3 text-sm">
            <dt className="font-medium">Provider</dt>
            <dd>{label}</dd>
            <dt className="font-medium">Endpoint</dt>
            <dd>{type === 'datadog' ? site : baseUrl}</dd>
            <dt className="font-medium">Access</dt>
            <dd>On-demand, read-only investigation tools</dd>
            {type === 'datadog' && (
              <>
                <dt className="font-medium">Traffic discovery</dt>
                <dd>
                  {collectLogs
                    ? 'Enabled for verified Kubernetes clusters, bounded log samples'
                    : 'Disabled'}
                </dd>
                <dt className="font-medium">APM discovery</dt>
                <dd>{collectApm ? 'Enabled' : 'Disabled'}</dd>
              </>
            )}
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
              className="sre-action sre-action-primary"
            >
              {busy ? 'Verifying…' : 'Save and verify'}
            </button>
          </SetupActions>
        </div>
      )}
      {step === 4 && result && (
        <ObservabilityVerificationResult
          result={result}
          name={name}
          onClose={onClose}
          type={type}
          webhookPath={eventDelivery ? persisted.webhookPath : undefined}
        />
      )}
    </SetupDialog>
  );
}
