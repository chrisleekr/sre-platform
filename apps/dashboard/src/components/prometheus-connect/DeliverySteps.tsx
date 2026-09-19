import { SetupActions } from '../SetupDialogSlots';
import { generateEventToken } from './support';
import { WebhookInstructions } from '../connector-setup/WebhookInstructions';
import { SetupCommand } from '../SetupCommand';
import type { PrometheusWizardViewModel } from './view-model';

export function PrometheusDeliverySteps({ view }: { view: PrometheusWizardViewModel }) {
  const {
    mode,
    initialSettings,
    step,
    setStep,
    baseUrl,
    authType,
    trust,
    busy,
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
    usesHttps,
    continueFromAlertDelivery,
    saveAndVerify,
    webhookYaml,
    webhookPath,
    deliveryUrl,
    onClose,
  } = view;
  return (
    <>
      {step === 3 && (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="font-medium">Connect Alertmanager lifecycle events</h3>
            <p className="mt-1 text-ink-muted">
              Prometheus supplies investigation metrics. Alertmanager separately supplies exact
              firing and resolved episodes so Slack and the dashboard can follow the real lifecycle.
            </p>
          </div>
          <fieldset className="space-y-2 rounded border border-line p-3">
            <legend className="font-medium">Delivery mode</legend>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                checked={eventTransport === 'smee'}
                onChange={() => setEventTransport('smee')}
              />
              <span>
                <strong>Smee relay</strong>
                <br />
                <span className="text-sm text-ink-muted">
                  Local development. No restart is required after saving.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                checked={eventTransport === 'direct'}
                onChange={() => setEventTransport('direct')}
              />
              <span>
                <strong>Public HTTPS API</strong>
                <br />
                <span className="text-sm text-ink-muted">
                  Deployed environments with a reachable API endpoint.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                checked={eventTransport === 'none'}
                onChange={() => setEventTransport('none')}
              />
              <span>
                <strong>Configure later</strong>
                <br />
                <span className="text-sm text-ink-muted">
                  Prometheus investigation works, but alerts will not open incidents.
                </span>
              </span>
            </label>
          </fieldset>
          {eventTransport === 'direct' && (
            <WebhookInstructions provider="Alertmanager" url={deliveryUrl} />
          )}
          {eventTransport !== 'none' && (
            <>
              <label className="font-medium">
                Incident Slack channel
                <select
                  aria-label="Incident Slack channel"
                  value={alertChannel}
                  onChange={(event) => setAlertChannel(event.target.value)}
                  className="sre-field mt-1 w-full"
                >
                  <option value="">Choose a channel</option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name}
                    </option>
                  ))}
                </select>
              </label>
              {channelsError && (
                <p role="alert" className="text-critical">
                  {channelsError}
                </p>
              )}
              <div className="rounded border border-info-line bg-info-soft p-3 text-sm text-info">
                <p className="font-medium">Independent provider episodes</p>
                <p className="mt-1">
                  Each Alertmanager fingerprint and start time opens its own incident and Slack
                  thread. Time-adjacent episodes are compared later without automatic grouping.
                </p>
              </div>
              {eventTransport === 'smee' && (
                <div>
                  <div className="mb-2 rounded border border-info-line bg-info-soft p-3 text-sm text-info">
                    <p>
                      A Smee channel is generated automatically. You can also enter an existing
                      channel. The API starts the local relay after Save and verify; no restart is
                      required.
                    </p>
                  </div>
                  <label className="font-medium">
                    Smee channel URL
                    <input
                      type="url"
                      aria-label="Smee channel URL"
                      value={smeeUrl}
                      onChange={(event) => setSmeeUrl(event.target.value)}
                      placeholder="https://smee.io/your-channel"
                      className="sre-field mt-1 w-full"
                    />
                    {mode === 'edit' && initialSettings?.smeeConfigured && !smeeUrl && (
                      <span className="mt-1 block text-xs font-normal text-ink-muted">
                        {eventToken
                          ? 'Enter the Smee URL again so the rotated token can be copied into a complete replacement configuration.'
                          : 'Leave blank to keep the stored Smee URL.'}
                      </span>
                    )}
                  </label>
                  {smeeUrl && (
                    <SetupCommand command={smeeUrl} copyLabel="Copy Alertmanager webhook URL" />
                  )}
                  <p className="mt-1 text-xs text-warning">
                    Development only. Anyone with this unauthenticated channel URL can observe or
                    forge relayed requests. Treat it as a secret and rotate the channel and bearer
                    token if exposed.
                  </p>
                </div>
              )}
              <label className="font-medium">
                Alertmanager bearer token
                <input
                  type={eventTokenVisible ? 'text' : 'password'}
                  aria-label="Alertmanager bearer token"
                  readOnly
                  value={eventToken}
                  placeholder={
                    initialSettings?.eventCredentialConfigured ? 'Stored and write-only' : ''
                  }
                  className="sre-field mt-1 w-full bg-surface-subtle font-instrument text-xs"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {eventToken && (
                  <>
                    <button
                      type="button"
                      onClick={() => setEventTokenVisible((visible) => !visible)}
                      className="sre-action"
                    >
                      {eventTokenVisible ? 'Hide token' : 'Show token'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(eventToken)}
                      className="sre-action"
                    >
                      Copy token
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setEventToken(generateEventToken());
                    setEventTokenVisible(false);
                  }}
                  className="sre-action"
                >
                  {eventToken ? 'Rotate token' : 'Generate new token'}
                </button>
              </div>
              <p className="text-xs text-ink-muted">
                This write-only token is available only during setup. Rotate it if it is copied into
                a screenshot, log, or untrusted channel.
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button type="button" onClick={() => setStep(2)} className="sre-action">
              Back
            </button>
            <button
              type="button"
              onClick={continueFromAlertDelivery}
              className="sre-action sre-action-primary"
            >
              Review
            </button>
          </SetupActions>
          <p className="text-xs text-ink-muted">
            Review does not save. The connector and local relay change only after Save and verify.
          </p>
        </div>
      )}

      {step === 4 && (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="font-medium">Review and verify Prometheus</h3>
            <p className="mt-1 text-ink-muted">
              Saving creates a disabled draft. A successful instant query enables on-demand
              investigation tools.
            </p>
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 rounded border border-line p-3">
            <dt className="font-medium">Endpoint</dt>
            <dd className="break-all">{baseUrl.trim()}</dd>
            <dt className="font-medium">Authentication</dt>
            <dd>{authType}</dd>
            <dt className="font-medium">Transport</dt>
            <dd>
              {usesHttps
                ? trust === 'ca'
                  ? 'HTTPS, pinned CA'
                  : trust === 'insecure'
                    ? 'HTTPS, verification disabled'
                    : 'HTTPS, system trust'
                : 'HTTP, private network only'}
            </dd>
            <dt className="font-medium">Data mode</dt>
            <dd>On-demand, read-only investigation</dd>
            <dt className="font-medium">Alert delivery</dt>
            <dd>
              {eventTransport === 'none'
                ? 'Not configured'
                : eventTransport === 'smee'
                  ? 'Smee relay'
                  : 'Public HTTPS API'}
            </dd>
            {eventTransport !== 'none' && (
              <>
                <dt className="font-medium">Slack channel</dt>
                <dd>
                  {channels.find((channel) => channel.id === alertChannel)?.name ?? alertChannel}
                </dd>
                <dt className="font-medium">Episode policy</dt>
                <dd>Independent incident per provider episode</dd>
              </>
            )}
          </dl>
          {error && (
            <p role="alert" className="text-critical">
              {error}
            </p>
          )}
          <SetupActions>
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
        <div className="flex flex-col gap-4">
          <h3
            className={`font-medium ${result.status === 'healthy' ? 'text-success' : 'text-critical'}`}
          >
            {result.status === 'healthy'
              ? 'Prometheus metrics verified.'
              : 'Verification failed; the connector remains disabled.'}
          </h3>
          <ul className="list-disc space-y-1 pl-5">
            <li>Endpoint reachable: {result.reachable ? 'yes' : 'no'}</li>
            <li>Query authorized: {result.authorized ? 'yes' : 'no'}</li>
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          {result.status === 'healthy' &&
            eventTransport !== 'none' &&
            result.relayStatus !== 'failed' && (
              <div className="rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
                Alertmanager delivery is configured and awaiting its first authenticated event.
                Apply the webhook configuration below, then verify the first delivery on the
                connector card.
              </div>
            )}
          {result.status === 'healthy' &&
            eventTransport === 'smee' &&
            result.relayStatus === 'failed' && (
              <p className="rounded border border-critical-line bg-critical-soft p-3 text-sm font-medium text-critical">
                Prometheus metrics are ready, but the local Smee relay could not connect. Retry this
                setup after checking the API logs and Smee channel URL.
              </p>
            )}
          {eventTransport !== 'none' && webhookYaml && webhookPath && (
            <div className="space-y-2 rounded border border-line p-3">
              <h4 className="font-semibold">
                Add this webhook to your existing Alertmanager receiver
              </h4>
              <p className="text-sm text-ink-muted">
                Merge this block into the receiver that already sends these alerts to Slack. Keep
                its <code>slack_configs</code>, receiver name, and routing tree unchanged. Do not
                create a duplicate receiver.
              </p>
              <pre className="overflow-x-auto rounded bg-code p-3 text-xs text-code-ink">
                {webhookYaml}
              </pre>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(webhookYaml)}
                className="sre-action"
              >
                Copy webhook config
              </button>
              <p className="text-xs text-warning">
                {eventTransport === 'smee'
                  ? 'The Smee URL and bearer token are development secrets.'
                  : 'The Alertmanager bearer token is a deployment secret.'}{' '}
                Inject secrets through your infrastructure secret mechanism; do not commit them
                literally.
              </p>
            </div>
          )}
          {eventTransport !== 'none' && !eventToken && (
            <p className="rounded border border-line bg-surface-subtle p-3 text-sm text-ink-secondary">
              The stored bearer token remains write-only. Rotate it in Alertmanager delivery if you
              need a new copyable webhook configuration.
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              onClick={onClose}
              className="sre-action sre-action-primary self-start"
            >
              Finish
            </button>
          </SetupActions>
        </div>
      )}
    </>
  );
}
