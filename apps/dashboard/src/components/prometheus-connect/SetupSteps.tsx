import { SetupActions } from '../SetupDialogSlots';
import type { PrometheusAuthType } from '../../lib/connectors';
import { DataSourceNameField } from '../DataSourceNameField';
import { ConnectorSetupGuide } from '../connector-setup/ConnectorSetupGuide';
import type { PrometheusWizardViewModel } from './view-model';

export function PrometheusSetupSteps({ view }: { view: PrometheusWizardViewModel }) {
  const {
    mode,
    initialSettings,
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
    error,
    canKeepCredential,
    usesHttp,
    usesHttps,
    showTls,
    continueFromEndpoint,
    continueFromCredentials,
  } = view;
  return (
    <>
      {step === 1 && (
        <div className="flex flex-col gap-4">
          <ConnectorSetupGuide provider="prometheus" />
          <div>
            <h3 className="font-medium">Choose the endpoint and authentication method</h3>
            <p className="mt-1 text-ink-muted">
              Investigations query the Prometheus HTTP API on demand. This connector does not poll
              or copy metrics into SRE Platform.
            </p>
          </div>
          <DataSourceNameField
            value={dataSourceName}
            onChange={setDataSourceName}
            placeholder="Production Prometheus"
          />
          <label className="font-medium">
            Prometheus base URL
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://127.0.0.1:9090 or https://prometheus.example.com"
              className="sre-field mt-1 w-full"
            />
          </label>
          <label className="font-medium">
            Authentication
            <select
              value={authType}
              onChange={(event) => setAuthType(event.target.value as PrometheusAuthType)}
              className="sre-field mt-1 w-full"
            >
              <option value="none">No authentication</option>
              <option value="bearer">Bearer token</option>
              <option value="basic">Basic authentication</option>
              <option value="header">Custom header</option>
              <option value="mtls" disabled={usesHttp}>
                Mutual TLS (HTTPS only)
              </option>
            </select>
          </label>
          {showTls ? (
            <fieldset className="space-y-2">
              <legend className="font-medium">HTTPS certificate trust</legend>
              {(['system', 'ca', 'insecure'] as const).map((option) => (
                <label key={option} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="prometheus-tls"
                    checked={trust === option}
                    onChange={() => setTrust(option)}
                  />
                  {option === 'system'
                    ? 'Use system trust'
                    : option === 'ca'
                      ? 'Pin a CA certificate'
                      : 'Disable certificate verification'}
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
              I understand HTTP does not encrypt credentials or monitoring data. Use it only on a
              trusted private network or through the supervised local tunnel.
            </label>
          ) : null}
          {usesHttps && trust === 'ca' && (
            <label className="font-medium">
              CA certificate (PEM)
              <textarea
                value={caCert}
                onChange={(event) => setCaCert(event.target.value)}
                rows={5}
                className="sre-field mt-1 w-full resize-y font-instrument text-xs"
              />
              <span className="mt-1 block text-xs font-normal text-ink-muted">
                {mode === 'edit' && initialSettings?.caConfigured
                  ? 'Leave blank to keep the stored CA. The PEM is never prefilled.'
                  : 'Required when the server certificate is signed by a private CA.'}
              </span>
            </label>
          )}
          {usesHttps && trust === 'insecure' && (
            <label className="flex items-start gap-2 rounded border border-critical-line bg-critical-soft p-3 text-critical">
              <input
                type="checkbox"
                checked={insecureAcknowledged}
                onChange={(event) => setInsecureAcknowledged(event.target.checked)}
              />
              I understand that disabling TLS verification permits server impersonation.
            </label>
          )}
          {error && (
            <p role="alert" className="text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              onClick={continueFromEndpoint}
              className="sre-action sre-action-primary self-start"
            >
              Continue
            </button>
          </SetupActions>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="font-medium">Enter the read credential</h3>
            <p className="mt-1 text-ink-muted">
              Credentials are encrypted at rest, write-only here, and never returned by the API.
            </p>
          </div>
          {authType === 'none' && <p>No credential is sent to Prometheus.</p>}
          {authType === 'bearer' && (
            <SecretInput label="Bearer token" value={token} onChange={setToken} />
          )}
          {authType === 'basic' && (
            <>
              <label className="font-medium">
                Username
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className="sre-field mt-1 w-full"
                />
              </label>
              <SecretInput label="Password" value={password} onChange={setPassword} />
            </>
          )}
          {authType === 'header' && (
            <>
              <label className="font-medium">
                Header name
                <input
                  value={headerName}
                  onChange={(event) => setHeaderName(event.target.value)}
                  placeholder="X-Scope-OrgID"
                  className="sre-field mt-1 w-full"
                />
              </label>
              <SecretInput label="Header value" value={headerValue} onChange={setHeaderValue} />
            </>
          )}
          {authType === 'mtls' && (
            <>
              <PemInput
                label="Client certificate (PEM)"
                value={clientCert}
                onChange={setClientCert}
              />
              <PemInput
                label="Client private key (PEM)"
                value={clientKey}
                onChange={setClientKey}
              />
            </>
          )}
          {canKeepCredential && authType !== 'none' && (
            <p className="text-xs text-ink-muted">
              Leave all credential fields blank to keep the stored {authType} credential.
            </p>
          )}
          {error && (
            <p role="alert" className="text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button type="button" onClick={() => setStep(1)} className="sre-action">
              Back
            </button>
            <button
              type="button"
              onClick={continueFromCredentials}
              className="sre-action sre-action-primary"
            >
              Continue
            </button>
          </SetupActions>
        </div>
      )}
    </>
  );
}

function SecretInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="font-medium">
      {label}
      <input
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="sre-field mt-1 w-full"
      />
    </label>
  );
}

function PemInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="font-medium">
      {label}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={5}
        className="sre-field mt-1 w-full resize-y font-instrument text-xs"
      />
    </label>
  );
}
