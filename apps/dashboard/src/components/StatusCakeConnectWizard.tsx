import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import type { ConnectorTestResult } from '../lib/connectors';
import type {
  StatusCakeSetupResponse,
  StatusCakeUptimeTest,
} from '../lib/connector-api/statuscake';
import { requestErrorMessage } from '../lib/request-error';
import { ConnectorSetupGuide } from './connector-setup/ConnectorSetupGuide';
import { publicApiOrigin } from './connector-setup/event-delivery';
import { DataSourceNameField } from './DataSourceNameField';
import { SetupDialog } from './SetupDialog';
import { SetupActions } from './SetupDialogSlots';
import { SetupProgress } from './SetupProgress';
import { UptimeTestPicker } from './statuscake-connect/UptimeTestPicker';

const STEPS = ['API token', 'Notifications', 'Done'];

/** A failure whose message is written for the operator, shown as is. */
class WizardError extends Error {}

type Mode = 'auto' | 'custom' | 'off';

const STATE_LABELS: Record<NonNullable<StatusCakeUptimeTest['state']>, string> = {
  ready: 'Connected',
  created: 'Contact group created',
  attached: 'Contact group added',
  repaired: 'Contact group updated',
  removed: 'Contact group removed',
  missing: 'Not set up yet',
  not_bound: 'Not included',
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function initialMode(settings: Record<string, unknown> | undefined, connect: boolean): Mode {
  if (settings?.eventTransport === 'direct')
    return settings.setupMode === 'auto' ||
      (settings.setupMode === undefined && stringList(settings.uptimeMonitorIds).length === 0)
      ? 'auto'
      : 'custom';
  return connect ? 'auto' : 'off';
}

export function StatusCakeConnectWizard({
  mode: dialogMode,
  connectorId,
  initialName,
  initialSettings,
  credentialConfigured = false,
  onSave,
  onRunTest,
  loadChannels,
  onListTests,
  onSetup,
  returnFocusTo,
  onClose,
}: {
  mode: 'connect' | 'edit';
  connectorId?: string;
  initialName?: string;
  initialSettings?: Record<string, unknown>;
  credentialConfigured?: boolean;
  onSave: (body: {
    id?: string;
    name: string;
    credential?: string;
    settings?: Record<string, unknown>;
  }) => Promise<{ connectorId: string }>;
  onRunTest: (id: string) => Promise<ConnectorTestResult>;
  loadChannels: () => Promise<Array<{ id: string; name: string }>>;
  onListTests: (id: string) => Promise<StatusCakeSetupResponse>;
  onSetup: (id: string) => Promise<StatusCakeSetupResponse>;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}) {
  const origin = publicApiOrigin(config.apiBaseUrl);
  const [step, setStep] = useState(1);
  const [savedConnectorId, setSavedConnectorId] = useState(connectorId);
  const [name, setName] = useState(initialName ?? 'StatusCake');
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<Mode>(
    origin ? initialMode(initialSettings, dialogMode === 'connect') : 'off',
  );
  const [selected, setSelected] = useState(
    () => new Set(stringList(initialSettings?.uptimeMonitorIds)),
  );
  const [excluded, setExcluded] = useState(
    () => new Set(stringList(initialSettings?.excludedMonitorIds)),
  );
  const [alertChannel, setAlertChannel] = useState(String(initialSettings?.alertChannel ?? ''));
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [channelsError, setChannelsError] = useState('');
  const [tests, setTests] = useState<StatusCakeUptimeTest[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [result, setResult] = useState<StatusCakeSetupResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Callers pass inline loaders; reading them through a ref keeps the load to once per visit.
  const loaders = useRef({ onListTests, loadChannels });
  loaders.current = { onListTests, loadChannels };
  useEffect(() => {
    if (step !== 2 || !savedConnectorId) return;
    let active = true;
    setLoadError('');
    setChannelsError('');
    const { onListTests: listTests, loadChannels: listChannels } = loaders.current;
    // Loaded separately: a Slack problem must not hide the uptime tests, or the reverse.
    void listTests(savedConnectorId).then(
      (listed) => {
        if (!active) return;
        // A partial list must not be saved: filtering the saved selections against it would drop
        // exclusions. Keeping tests unset leaves Save disabled.
        if (listed.error) setLoadError(listed.error.message);
        else setTests(listed.tests);
      },
      (cause) => {
        if (active)
          setLoadError(requestErrorMessage(cause, 'Uptime tests could not be loaded. Retry.'));
      },
    );
    void listChannels().then(
      (loaded) => {
        if (active) setChannels(loaded);
      },
      () => {
        if (active)
          setChannelsError(
            'Slack channels could not be loaded. Connect Slack under Connections, then reopen this setup.',
          );
      },
    );
    return () => {
      active = false;
    };
  }, [step, savedConnectorId]);

  const run = (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError('');
    void action()
      .catch((cause) =>
        setError(
          cause instanceof WizardError ? cause.message : requestErrorMessage(cause, fallback),
        ),
      )
      .finally(() => setBusy(false));
  };

  const saveToken = () => {
    if (!name.trim()) return setError('Data source name is required.');
    if (!token.trim() && !(dialogMode === 'edit' && credentialConfigured))
      return setError('Paste a StatusCake API token.');
    if (savedConnectorId && !token.trim() && name.trim() === initialName) {
      setError('');
      return setStep(2);
    }
    run(async () => {
      const saved = await onSave({
        ...(savedConnectorId ? { id: savedConnectorId } : {}),
        name: name.trim(),
        ...(token.trim() ? { credential: token.trim() } : {}),
      });
      setSavedConnectorId(saved.connectorId);
      const verified = await onRunTest(saved.connectorId);
      if (verified.status !== 'healthy')
        throw new WizardError(
          verified.authorized
            ? `StatusCake could not be verified: ${verified.warnings.join(' ')}`
            : 'StatusCake rejected this API token. Create a new token in StatusCake and paste it here.',
        );
      setToken('');
      setStep(2);
    }, 'Save or verification failed. Review the token and retry.');
  };

  const isChecked = (id: string) => (mode === 'auto' ? !excluded.has(id) : selected.has(id));
  const toggle = (ids: string[], checked: boolean) => {
    const update = (current: Set<string>, add: boolean) => {
      const next = new Set(current);
      for (const id of ids) {
        if (add) next.add(id);
        else next.delete(id);
      }
      return next;
    };
    if (mode === 'auto') setExcluded((current) => update(current, !checked));
    else setSelected((current) => update(current, checked));
  };

  const saveNotifications = () => {
    if (mode !== 'off' && !alertChannel) return setError('Choose the Slack channel for incidents.');
    if (mode === 'custom' && selected.size === 0)
      return setError('Choose at least one uptime test, or send notifications for all tests.');
    const id = savedConnectorId!;
    const known = new Set((tests ?? []).map((test) => test.id));
    const listed = (testId: string) => !tests || known.has(testId);
    run(async () => {
      await onSave({
        id,
        name: name.trim(),
        settings: {
          eventTransport: mode === 'off' ? 'none' : 'direct',
          ...(mode !== 'off' ? { setupMode: mode } : {}),
          // Drop IDs of tests deleted in StatusCake so the saved lists do not grow forever.
          uptimeMonitorIds: [...selected].filter(listed),
          excludedMonitorIds: [...excluded].filter(listed),
          ...(alertChannel ? { alertChannel } : {}),
          ...(origin ? { receiverOrigin: origin } : {}),
        },
      });
      const verified = await onRunTest(id);
      if (verified.status !== 'healthy')
        throw new WizardError('StatusCake could not be verified. Go back and check the API token.');
      // Turning notifications off still runs setup to remove the platform's contact groups; if it
      // cannot finish, the background sync keeps retrying the removal.
      setResult(await onSetup(id));
      setStep(3);
    }, 'Notifications could not be saved. Retry.');
  };

  const retrySetup = () =>
    run(async () => setResult(await onSetup(savedConnectorId!)), 'Setup could not run. Retry.');

  const included = (result?.tests ?? []).filter((test) => test.state !== 'not_bound');

  return (
    <SetupDialog
      size="standard"
      title={dialogMode === 'edit' ? 'Manage StatusCake' : 'Connect StatusCake'}
      closeLabel={step === 3 || dialogMode === 'edit' ? 'Close' : 'Cancel'}
      busy={busy}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    >
      <SetupProgress steps={STEPS} current={step} />
      {step === 1 && (
        <div className="flex flex-col gap-4">
          <ConnectorSetupGuide provider="statuscake" />
          <DataSourceNameField value={name} onChange={setName} placeholder="Global uptime" />
          <ol className="list-decimal space-y-1 pl-5 text-ink-secondary">
            <li>Open StatusCake, then go to Integrations and API.</li>
            <li>Reuse an existing API token, or create one.</li>
            <li>Paste it below. It is encrypted and never shown again.</li>
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
            {dialogMode === 'edit' && credentialConfigured && (
              <span className="mt-1 block text-xs font-normal text-ink-muted">
                Leave blank to keep the saved token.
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
              disabled={busy}
              onClick={saveToken}
              className="sre-action sre-action-primary"
            >
              {busy
                ? 'Verifying…'
                : savedConnectorId && !token.trim() && name.trim() === initialName
                  ? 'Continue'
                  : 'Save and continue'}
            </button>
          </SetupActions>
        </div>
      )}
      {step === 2 && (
        <div className="flex flex-col gap-4">
          <fieldset className="space-y-2 rounded border border-line p-3">
            <legend className="font-medium">Open incidents from StatusCake alerts</legend>
            {(
              [
                [
                  'auto',
                  'All uptime tests',
                  'Recommended. New tests are added automatically; untick any test to leave it out.',
                ],
                ['custom', 'Only tests I choose', 'New tests are not added until you select them.'],
                ['off', 'Off', 'StatusCake is used only as evidence during investigations.'],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="statuscake-mode"
                  checked={mode === value}
                  disabled={value !== 'off' && !origin}
                  onChange={() => setMode(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <br />
                  <span className="text-sm text-ink-muted">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {!origin && (
            <p role="alert" className="text-sm text-warning">
              StatusCake calls the platform from the internet, so uptime alerts need a public HTTPS
              API address. Ask your platform administrator to configure one in the deployment.
            </p>
          )}
          {mode !== 'off' && (
            <>
              <p className="text-sm text-ink-muted">
                The platform adds one contact group per selected test in StatusCake, named “SRE
                Platform: test name”. Your existing contacts stay on every test.
              </p>
              <label className="font-medium">
                Incident Slack channel
                <select
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
                  {alertChannel && !channels.some((channel) => channel.id === alertChannel) && (
                    <option value={alertChannel}>{alertChannel}</option>
                  )}
                </select>
              </label>
              {channelsError && (
                <p role="alert" className="text-critical">
                  {channelsError}
                </p>
              )}
              {tests === null && !loadError && (
                <p className="text-sm text-ink-muted">Loading uptime tests…</p>
              )}
              {tests && (
                <UptimeTestPicker
                  tests={tests}
                  mode={mode}
                  isChecked={isChecked}
                  onToggle={(id, checked) => toggle([id], checked)}
                  onToggleAll={toggle}
                />
              )}
            </>
          )}
          {loadError && (
            <p role="alert" className="text-critical">
              {loadError}
            </p>
          )}
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
              disabled={busy || (mode !== 'off' && !tests)}
              onClick={saveNotifications}
              className="sre-action sre-action-primary"
            >
              {busy ? 'Setting up…' : mode === 'off' ? 'Save' : 'Save and set up'}
            </button>
          </SetupActions>
        </div>
      )}
      {step === 3 && result && (
        <div className="flex flex-col gap-4">
          {result.error ? (
            <p role="alert" className="font-medium text-critical">
              Setup stopped: {result.error.message}
            </p>
          ) : (
            <h3 className="font-medium text-success">
              {mode === 'off'
                ? 'StatusCake alerts no longer open incidents.'
                : `StatusCake alerts from ${included.length} ${included.length === 1 ? 'test' : 'tests'} now open incidents.`}
            </h3>
          )}
          {included.length > 0 && (
            <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded border border-line">
              {included.map((test) => (
                <li key={test.id} className="flex flex-wrap justify-between gap-2 p-2 text-sm">
                  <span className="min-w-0 break-words">{test.name}</span>
                  <span className={test.state === 'missing' ? 'text-warning' : 'text-ink-muted'}>
                    {STATE_LABELS[test.state ?? 'not_bound']}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {mode !== 'off' && !result.error && (
            <p className="text-sm text-ink-muted">
              {mode === 'auto'
                ? 'New uptime tests are set up within five minutes of being added in StatusCake.'
                : 'To add tests later, choose Manage and select them.'}
            </p>
          )}
          {error && (
            <p role="alert" className="text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            {result.error && (
              <button type="button" disabled={busy} onClick={retrySetup} className="sre-action">
                {busy ? 'Retrying…' : 'Retry setup'}
              </button>
            )}
            <button type="button" onClick={onClose} className="sre-action sre-action-primary">
              Finish
            </button>
          </SetupActions>
        </div>
      )}
    </SetupDialog>
  );
}
