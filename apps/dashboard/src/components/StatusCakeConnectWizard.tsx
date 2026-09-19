import { requestErrorMessage } from '../lib/request-error';
import { SetupActions } from './SetupDialogSlots';
import { useState } from 'react';
import type { ConnectorTestResult } from '../lib/connectors';
import { SetupDialog } from './SetupDialog';
import { SetupProgress } from './SetupProgress';
import { ConnectorSetupGuide } from './connector-setup/ConnectorSetupGuide';
import { DataSourceNameField } from './DataSourceNameField';

const STEPS = ['API token', 'Review', 'Verify'];

export function StatusCakeConnectWizard({
  mode,
  connectorId,
  initialName,
  credentialConfigured = false,
  onSave,
  onRunTest,
  returnFocusTo,
  onClose,
}: {
  mode: 'connect' | 'edit';
  connectorId?: string;
  initialName?: string;
  credentialConfigured?: boolean;
  onSave: (body: {
    id?: string;
    name: string;
    credential?: string;
  }) => Promise<{ connectorId: string }>;
  onRunTest: (id: string) => Promise<ConnectorTestResult>;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState(1);
  const [savedConnectorId, setSavedConnectorId] = useState(connectorId);
  const [dataSourceName, setDataSourceName] = useState(initialName ?? 'StatusCake');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ConnectorTestResult | null>(null);

  const review = (): void => {
    if (!dataSourceName.trim()) {
      setError('Data source name is required.');
      return;
    }
    if (!token.trim() && !(mode === 'edit' && credentialConfigured)) {
      setError('Paste a StatusCake API token.');
      return;
    }
    setError('');
    setStep(2);
  };

  const saveAndVerify = (): void => {
    setBusy(true);
    setSubmitted(true);
    setError('');
    void (async () => {
      try {
        const saved = await onSave({
          ...(savedConnectorId ? { id: savedConnectorId } : {}),
          name: dataSourceName.trim(),
          ...(token.trim() ? { credential: token.trim() } : {}),
        });
        setSavedConnectorId(saved.connectorId);
        setResult(await onRunTest(saved.connectorId));
        setStep(3);
      } catch (cause) {
        setError(
          requestErrorMessage(
            cause,
            'Save or verification failed. The disabled draft may exist; review the token and retry.',
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
      title={mode === 'edit' ? 'Manage StatusCake' : 'Connect StatusCake'}
      closeLabel={submitted || mode === 'edit' ? 'Close' : 'Cancel'}
      busy={busy}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    >
      <SetupProgress steps={STEPS} current={step} />
      {step === 1 && (
        <div className="mb-4">
          <ConnectorSetupGuide provider="statuscake" />
        </div>
      )}
      {step === 1 && (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="font-medium">Use a StatusCake API token</h3>
            <p className="mt-1 text-ink-muted">
              Use a token that can read uptime tests, history, alerts, maintenance windows, and
              contact groups. Investigations call StatusCake on demand; this connector does not
              poll.
            </p>
          </div>
          <DataSourceNameField
            value={dataSourceName}
            onChange={setDataSourceName}
            placeholder="Global uptime"
          />
          <ol className="list-decimal space-y-1 pl-5 text-ink-secondary">
            <li>Open StatusCake, then go to Integrations and API.</li>
            <li>Reuse an existing valid API token, or create one if needed.</li>
            <li>Paste it below. It is encrypted at rest and never shown again.</li>
          </ol>
          <label className="font-medium">
            API token
            <input
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="sre-field mt-1 w-full"
            />
            {mode === 'edit' && credentialConfigured && (
              <span className="mt-1 block text-xs font-normal text-ink-muted">
                Leave blank to keep the stored token.
              </span>
            )}
          </label>
          {error && (
            <p role="alert" className="text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              onClick={review}
              className="sre-action sre-action-primary self-start"
            >
              Review
            </button>
          </SetupActions>
        </div>
      )}
      {step === 2 && (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="font-medium">Review and verify StatusCake</h3>
            <p className="mt-1 text-ink-muted">
              Saving creates a disabled draft. A successful read of one uptime test enables
              on-demand investigation tools.
            </p>
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 rounded border border-line p-3">
            <dt className="font-medium">API</dt>
            <dd>api.statuscake.com</dd>
            <dt className="font-medium">Credential</dt>
            <dd>{token.trim() ? 'New write-only token' : 'Keep stored token'}</dd>
            <dt className="font-medium">Data mode</dt>
            <dd>On-demand, read-only investigation</dd>
          </dl>
          {error && (
            <p role="alert" className="text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button type="button" disabled={busy} onClick={() => setStep(1)} className="sre-action">
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
      {step === 3 && result && (
        <div className="flex flex-col gap-4">
          <h3
            className={`font-medium ${result.status === 'healthy' ? 'text-success' : 'text-critical'}`}
          >
            {result.status === 'healthy'
              ? 'StatusCake connector enabled.'
              : 'Verification failed; the connector remains disabled.'}
          </h3>
          <ul className="list-disc space-y-1 pl-5">
            <li>API reachable: {result.reachable ? 'yes' : 'no'}</li>
            <li>Token authorized: {result.authorized ? 'yes' : 'no'}</li>
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
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
    </SetupDialog>
  );
}
