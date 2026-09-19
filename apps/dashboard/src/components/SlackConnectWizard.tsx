import { requestErrorMessage } from '../lib/request-error';
import { SetupActions } from './SetupDialogSlots';
import { useState } from 'react';
import type { SaveSlackSurfaceInput, SlackTestResult } from '../lib/surfaces';
import { SetupDialog } from './SetupDialog';
import { SetupProgress } from './SetupProgress';
import { ConnectorSetupGuide } from './connector-setup/ConnectorSetupGuide';

export interface SlackConnectWizardProps {
  mode?: 'connect' | 'edit';
  onSave: (input: SaveSlackSurfaceInput) => Promise<void>;
  onRunTest: () => Promise<SlackTestResult>;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}

const STEP_NAMES = ['Credentials', 'Review', 'Verify'];

/** Collect write-only Socket Mode credentials, review the change, then save and verify it. */
export function SlackConnectWizard({
  mode = 'connect',
  onSave,
  onRunTest,
  returnFocusTo,
  onClose,
}: SlackConnectWizardProps) {
  const [step, setStep] = useState(1);
  const [appToken, setAppToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SlackTestResult | null>(null);

  const passed = result !== null && result.ok;
  const appAction = appToken.trim() ? 'Replace with entered xapp token' : 'Keep current token';
  const botAction = botToken.trim() ? 'Replace with entered xoxb token' : 'Keep current token';

  const goToReview = (): void => {
    const app = appToken.trim();
    const bot = botToken.trim();
    if (mode === 'connect' && (!app || !bot)) {
      setError('Both the app token and bot token are required for a new connection.');
      return;
    }
    if (app && !app.startsWith('xapp-')) {
      setError('The Socket Mode app token must start with xapp-.');
      return;
    }
    if (bot && !bot.startsWith('xoxb-')) {
      setError('The bot token must start with xoxb-.');
      return;
    }
    setError('');
    setStep(2);
  };

  const handleSaveAndVerify = (): void => {
    setSubmitted(true);
    setBusy(true);
    setError('');
    void (async () => {
      try {
        const input: SaveSlackSurfaceInput = {
          appToken: appToken.trim() || undefined,
          botToken: botToken.trim() || undefined,
        };
        await onSave(input);
        const response = await onRunTest();
        setResult(response);
        setStep(3);
      } catch (cause) {
        setError(requestErrorMessage(cause, 'Slack connection failed'));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <SetupDialog
      size="standard"
      title={mode === 'edit' ? 'Edit Slack' : 'Connect Slack'}
      closeLabel={submitted ? 'Close' : 'Cancel'}
      busy={busy}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    >
      <SetupProgress steps={STEP_NAMES} current={step} />
      {step === 1 && (
        <div className="mb-4">
          <ConnectorSetupGuide provider="slack" />
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-3">
          <p className="text-ink-muted">
            Reuse an existing Slack App dedicated to this connection; you do not need to create
            another App. Socket Mode needs an app token and bot token from that same App. Stored
            tokens are never loaded back into this form.
          </p>
          <div className="flex flex-col gap-1">
            <label htmlFor="slack-app-token" className="font-medium">
              App token
            </label>
            <input
              id="slack-app-token"
              type="password"
              value={appToken}
              onChange={(event) => setAppToken(event.target.value)}
              autoComplete="off"
              placeholder={mode === 'edit' ? 'Leave blank to keep current xapp token' : 'xapp-…'}
              className="sre-field min-w-0 w-full font-instrument text-xs"
            />
            <p className="break-words text-xs text-ink-muted">
              From Basic Information → App-Level Tokens, with{' '}
              <code className="font-instrument">connections:write</code>. Socket Mode must be
              enabled.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="slack-bot-token" className="font-medium">
              Bot token
            </label>
            <input
              id="slack-bot-token"
              type="password"
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
              autoComplete="off"
              placeholder={mode === 'edit' ? 'Leave blank to keep current xoxb token' : 'xoxb-…'}
              className="sre-field min-w-0 w-full font-instrument text-xs"
            />
            <p className="break-words text-xs text-ink-muted">
              From OAuth & Permissions after installing the app. Connection validation requires{' '}
              <code className="font-instrument">users:read</code>;{' '}
              <code className="font-instrument">users:read.email</code> is optional for attribution.
            </p>
          </div>

          {error && <p className="text-critical">{error}</p>}
          <SetupActions>
            <button type="button" onClick={goToReview} className="sre-action sre-action-primary">
              Next
            </button>
          </SetupActions>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-3">
          <p className="text-ink-muted">
            Saving validates both tokens, confirms they belong to the same Slack app, then starts
            the managed Socket Mode connection. No public webhook URL is required.
          </p>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 rounded border border-line p-3 text-sm">
            <dt className="text-ink-muted">Transport</dt>
            <dd>Socket Mode</dd>
            <dt className="text-ink-muted">App token</dt>
            <dd className="min-w-0 break-words">{appAction}</dd>
            <dt className="text-ink-muted">Bot token</dt>
            <dd className="min-w-0 break-words">{botAction}</dd>
            <dt className="text-ink-muted">Secrets</dt>
            <dd>Stored encrypted and never returned</dd>
          </dl>
          <div className="rounded border border-line p-3 text-xs text-ink-muted">
            Before continuing, confirm Socket Mode and Event Subscriptions are enabled and the app
            has been reinstalled after scope changes.
          </div>
          {error && <p className="text-critical">{error}</p>}
          <SetupActions>
            <button type="button" onClick={() => setStep(1)} disabled={busy} className="sre-action">
              Back
            </button>
            <button
              type="button"
              onClick={handleSaveAndVerify}
              disabled={busy}
              className="sre-action sre-action-primary"
            >
              {busy ? 'Verifying…' : 'Save and verify'}
            </button>
          </SetupActions>
        </div>
      )}

      {step === 3 && result && (
        <div className="flex flex-col gap-3">
          {result.ok ? (
            <p className="font-medium text-success">
              Connected as {result.botUserId} (team {result.team}).
            </p>
          ) : (
            <p className="font-medium text-warning">Verification failed: {result.error}</p>
          )}
          {result.ok && result.warning && <p className="text-warning">{result.warning}</p>}
          <SetupActions>
            <button type="button" onClick={() => setStep(2)} className="sre-action">
              Back
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={!passed}
              className="sre-action sre-action-primary"
            >
              Done
            </button>
          </SetupActions>
        </div>
      )}
    </SetupDialog>
  );
}
