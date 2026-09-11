import { requestErrorMessage } from '../lib/request-error';
import type { PrepareDelivery } from '../lib/connector-delivery';
import { usePreparedDelivery } from './connector-setup/usePreparedDelivery';
import { DeliveryPreparationStatus } from './connector-setup/DeliveryPreparationStatus';
import { useEffect, useState } from 'react';
import type {
  ConnectorTestResult,
  PrometheusAuthType,
  PrometheusSettings,
} from '../lib/connectors';
import { SetupDialog } from './SetupDialog';
import { SetupProgress } from './SetupProgress';
import {
  PUBLIC_API_CONFIGURATION_ERROR,
  publicApiOrigin,
  publicWebhookUrl,
} from './connector-setup/event-delivery';
import { PublicDeliveryNotice } from './connector-setup/WebhookInstructions';
import { PrometheusDeliverySteps } from './prometheus-connect/DeliverySteps';
import { PrometheusSetupSteps } from './prometheus-connect/SetupSteps';
import { generateEventToken } from './prometheus-connect/support';
import type { PrometheusWizardViewModel } from './prometheus-connect/view-model';

const STEPS = [
  'Metrics endpoint',
  'Metrics credential',
  'Alertmanager delivery',
  'Review',
  'Verify',
];

export function PrometheusConnectWizard({
  mode,
  connectorId,
  initialName,
  initialSettings,
  credentialConfigured = false,
  initialWebhookPath,
  apiBaseUrl = '',
  loadChannels = async () => [],
  onPrepareDelivery,
  onSave,
  onRunTest,
  returnFocusTo,
  onClose,
}: {
  mode: 'connect' | 'edit';
  connectorId?: string;
  initialName?: string;
  initialSettings?: Partial<PrometheusSettings>;
  credentialConfigured?: boolean;
  initialWebhookPath?: string;
  apiBaseUrl?: string;
  loadChannels?: () => Promise<Array<{ id: string; name: string }>>;
  onPrepareDelivery: PrepareDelivery;
  onSave: (body: {
    setupId?: string;
    id?: string;
    name: string;
    settings: PrometheusSettings;
    credential?: string;
    eventToken?: string;
    insecureTlsAcknowledged?: boolean;
    insecureHttpAcknowledged?: boolean;
  }) => Promise<{ connectorId: string; webhookPath?: string }>;
  onRunTest: (id: string) => Promise<ConnectorTestResult>;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState(1);
  const [dataSourceId, setDataSourceId] = useState(connectorId);
  const [dataSourceName, setDataSourceName] = useState(initialName ?? 'Prometheus');
  const [baseUrl, setBaseUrl] = useState(initialSettings?.baseUrl ?? '');
  const [authType, setAuthType] = useState<PrometheusAuthType>(initialSettings?.authType ?? 'none');
  const initialTrust = initialSettings?.insecureSkipTLSVerify
    ? 'insecure'
    : initialSettings?.caConfigured
      ? 'ca'
      : 'system';
  const [trust, setTrust] = useState<'system' | 'ca' | 'insecure'>(initialTrust);
  const [insecureAcknowledged, setInsecureAcknowledged] = useState(false);
  const [httpAcknowledged, setHttpAcknowledged] = useState(false);
  const [caCert, setCaCert] = useState('');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [clientCert, setClientCert] = useState('');
  const [clientKey, setClientKey] = useState('');

  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ConnectorTestResult | null>(null);
  const defaultTransport =
    initialSettings?.eventTransport ??
    (!apiBaseUrl
      ? 'none'
      : apiBaseUrl.includes('localhost') || apiBaseUrl.includes('127.0.0.1')
        ? 'smee'
        : 'direct');
  const [eventTransport, setEventTransport] = useState<'direct' | 'smee' | 'none'>(
    defaultTransport,
  );
  const [alertChannel, setAlertChannel] = useState(initialSettings?.alertChannel ?? '');
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [channelsError, setChannelsError] = useState('');
  const [smeeUrl, setSmeeUrl] = useState('');
  const [eventToken, setEventToken] = useState(mode === 'connect' ? generateEventToken() : '');
  const [eventTokenVisible, setEventTokenVisible] = useState(false);
  const [webhookPath, setWebhookPath] = useState(initialWebhookPath ?? '');
  const preparation = usePreparedDelivery({
    transport: step >= 3 ? eventTransport : 'none',
    hasSmeeUrl: Boolean(smeeUrl.trim()),
    existing: Boolean(dataSourceId),
    storedSmee:
      initialSettings?.eventTransport === 'smee' && Boolean(initialSettings.smeeConfigured),
    initialPath: initialWebhookPath,
    prepare: onPrepareDelivery,
  });
  useEffect(() => {
    if (preparation.smeeUrl) setSmeeUrl((current) => current || preparation.smeeUrl!);
  }, [preparation.smeeUrl]);

  useEffect(() => {
    if (step !== 3 || channels.length > 0) return;
    let active = true;
    void loadChannels().then(
      (loaded) => {
        if (!active) return;
        setChannels(loaded);
        setChannelsError('');
      },
      (cause) => {
        if (active)
          setChannelsError(
            requestErrorMessage(
              cause,
              'Slack channels could not be loaded. Verify the Slack connection.',
            ),
          );
      },
    );
    return () => {
      active = false;
    };
  }, [channels.length, loadChannels, step]);

  const authChanged = mode === 'edit' && initialSettings?.authType !== authType;
  const canKeepCredential = mode === 'edit' && credentialConfigured && !authChanged;
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
  const needsCa =
    usesHttps && trust === 'ca' && !(mode === 'edit' && initialSettings?.caConfigured);

  const continueFromEndpoint = (): void => {
    if (!dataSourceName.trim()) {
      setError('Data source name is required.');
      return;
    }
    let url: URL;
    try {
      url = new URL(baseUrl.trim());
    } catch {
      setError('Enter a valid Prometheus base URL.');
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      setError('The Prometheus base URL must use HTTP or HTTPS.');
      return;
    }
    if (url.protocol === 'http:' && authType === 'mtls') {
      setError('Mutual TLS requires an HTTPS Prometheus URL.');
      return;
    }
    if (url.protocol === 'http:' && !httpAcknowledged) {
      setError('Acknowledge the unencrypted HTTP transport before continuing.');
      return;
    }
    if (url.protocol === 'https:' && trust === 'insecure' && !insecureAcknowledged) {
      setError('Acknowledge the insecure TLS risk before continuing.');
      return;
    }
    if (needsCa && !caCert.trim()) {
      setError('Paste the CA certificate used by this Prometheus endpoint.');
      return;
    }
    setError('');
    setStep(2);
  };

  const credential = (): string | undefined => {
    if (authType === 'none') return JSON.stringify({ type: 'none' });
    if (authType === 'bearer' && token.trim())
      return JSON.stringify({ type: 'bearer', token: token.trim() });
    if (authType === 'basic' && username.trim() && password)
      return JSON.stringify({ type: 'basic', username: username.trim(), password });
    if (authType === 'header' && headerName.trim() && headerValue)
      return JSON.stringify({ type: 'header', name: headerName.trim(), value: headerValue });
    if (authType === 'mtls' && clientCert.trim() && clientKey.trim())
      return JSON.stringify({ type: 'mtls', cert: clientCert.trim(), key: clientKey.trim() });
    return undefined;
  };

  const continueFromCredentials = (): void => {
    if (
      authType === 'header' &&
      (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName.trim()) ||
        [
          'authorization',
          'connection',
          'content-length',
          'cookie',
          'host',
          'keep-alive',
          'proxy-authenticate',
          'proxy-authorization',
          'proxy-connection',
          'te',
          'trailer',
          'transfer-encoding',
          'upgrade',
        ].includes(headerName.trim().toLowerCase()))
    ) {
      setError('Enter a safe custom authentication header name, such as X-Scope-OrgID.');
      return;
    }
    if (!credential() && !canKeepCredential) {
      setError(`Enter the ${authType} credential required for this connection.`);
      return;
    }
    setError('');
    setStep(3);
  };

  const continueFromAlertDelivery = (): void => {
    if (eventTransport === 'direct' && !publicApiOrigin(apiBaseUrl)) {
      setError(PUBLIC_API_CONFIGURATION_ERROR);
      return;
    }
    if (eventTransport !== 'none' && !alertChannel) {
      setError('Choose the Slack channel where Alertmanager incidents should start.');
      return;
    }
    const canKeepStoredSmeeUrl =
      mode === 'edit' && initialSettings?.smeeConfigured && !smeeUrl && !eventToken;
    if (eventTransport === 'smee' && !canKeepStoredSmeeUrl) {
      try {
        const url = new URL(smeeUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'smee.io') throw new Error();
      } catch {
        setError('Enter the https://smee.io channel URL used by Alertmanager.');
        return;
      }
    }
    if (eventTransport !== 'none' && !eventToken && !initialSettings?.eventCredentialConfigured) {
      setError('Generate an Alertmanager bearer token before continuing.');
      return;
    }
    setError('');
    setStep(4);
  };

  const saveAndVerify = (): void => {
    if (
      eventTransport !== 'none' &&
      (preparation.busy || preparation.error || (!dataSourceId && !preparation.setupId))
    ) {
      setError('Wait for webhook preparation, or retry it before continuing.');
      return;
    }

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
            baseUrl: baseUrl.trim(),
            authType,
            ...(usesHttps && trust === 'ca'
              ? caCert.trim()
                ? { caCert: caCert.trim() }
                : {}
              : { caCert: '' }),
            insecureSkipTLSVerify: usesHttps && trust === 'insecure',
            eventTransport,
            ...(eventTransport !== 'none' ? { alertChannel } : {}),
            cohortWindowSec: 120,
            ...(eventTransport === 'smee' && smeeUrl ? { smeeUrl } : {}),
          },
          ...(credential() ? { credential: credential() } : {}),
          ...(eventTransport !== 'none' && eventToken ? { eventToken } : {}),
          insecureTlsAcknowledged: usesHttps && trust === 'insecure' && insecureAcknowledged,
          ...(usesHttp && httpAcknowledged ? { insecureHttpAcknowledged: true } : {}),
        });
        if (saved.webhookPath) setWebhookPath(saved.webhookPath);
        setDataSourceId(saved.connectorId);
        setResult(await onRunTest(saved.connectorId));
        setStep(5);
      } catch (cause) {
        setError(
          requestErrorMessage(
            cause,
            'Save or verification failed. The disabled draft may exist; review the values and retry.',
          ),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  const directPath = publicWebhookUrl(
    publicApiOrigin(apiBaseUrl),
    webhookPath || preparation.webhookPath || '',
  );
  const deliveryUrl =
    eventTransport === 'smee'
      ? smeeUrl
      : directPath
        ? new URL(directPath, window.location.origin).toString()
        : '';
  const webhookYaml =
    deliveryUrl && eventToken
      ? `webhook_configs:\n  - url: ${deliveryUrl}\n    send_resolved: true\n    http_config:\n      authorization:\n        type: Bearer\n        credentials: ${eventToken}`
      : '';

  const view: PrometheusWizardViewModel = {
    mode,
    initialSettings,
    credentialConfigured,
    step,
    setStep,
    dataSourceName,
    setDataSourceName,
    baseUrl,
    setBaseUrl,
    authType,
    setAuthType,
    trust,
    setTrust,
    insecureAcknowledged,
    setInsecureAcknowledged,
    httpAcknowledged,
    setHttpAcknowledged,
    caCert,
    setCaCert,
    token,
    setToken,
    username,
    setUsername,
    password,
    setPassword,
    headerName,
    setHeaderName,
    headerValue,
    setHeaderValue,
    clientCert,
    setClientCert,
    clientKey,
    setClientKey,
    busy,
    submitted,
    error,
    result,
    eventTransport,
    setEventTransport,
    alertChannel,
    setAlertChannel,
    channels,
    channelsError,
    smeeUrl,
    setSmeeUrl,
    eventToken,
    setEventToken,
    eventTokenVisible,
    setEventTokenVisible,
    canKeepCredential,
    usesHttp,
    usesHttps,
    showTls,
    needsCa,
    continueFromEndpoint,
    continueFromCredentials,
    continueFromAlertDelivery,
    saveAndVerify,
    deliveryUrl,
    webhookYaml,
    webhookPath,
    onClose,
  };

  return (
    <SetupDialog
      title={
        mode === 'edit' ? 'Manage Prometheus & Alertmanager' : 'Connect Prometheus & Alertmanager'
      }
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
      <PrometheusSetupSteps view={view} />
      {step === 3 && eventTransport === 'direct' && (
        <div className="mb-4">
          <PublicDeliveryNotice available={Boolean(publicApiOrigin(apiBaseUrl))} />
        </div>
      )}
      <PrometheusDeliverySteps view={view} />
    </SetupDialog>
  );
}
