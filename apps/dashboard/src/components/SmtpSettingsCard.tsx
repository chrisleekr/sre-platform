import type { CredentialGetter } from '../lib/request-credentials';
import { useCallback, useEffect, useRef, useState } from 'react';
import { checkResponse, requestErrorMessage } from '../lib/request-error';
import { useSession } from '../auth';
import { config } from '../config';
import { authenticatedFetch } from '../lib/authenticatedFetch';

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  username?: string;
}

interface SmtpView {
  config: SmtpConfig | null;
  source: 'stored' | 'environment';
  passwordConfigured: boolean;
  updatedAt: string | null;
}

const EMPTY: SmtpConfig = {
  host: '',
  port: 587,
  secure: false,
  from: '',
};

async function smtpRequest(
  getCredentials: CredentialGetter,
  path = '',
  init?: RequestInit,
): Promise<Response> {
  return authenticatedFetch(`${config.apiBaseUrl}/platform-settings/smtp${path}`, getCredentials, {
    ...init,
    headers: init?.headers as Record<string, string> | undefined,
  });
}

/** Configures the optional SMTP channel without exposing its stored password. */
export function SmtpSettingsCard() {
  const { getCredentials } = useSession();
  const getTokenRef = useRef(getCredentials);
  getTokenRef.current = getCredentials;
  const [view, setView] = useState<SmtpView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState<SmtpConfig>(EMPTY);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | null>('load');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyView = (next: SmtpView): void => {
    setView(next);
    setEnabled(Boolean(next.config));
    setDraft(next.config ?? EMPTY);
    setPassword('');
  };

  const load = useCallback(async (): Promise<void> => {
    setBusy('load');
    setError(null);
    try {
      const response = await smtpRequest(getTokenRef.current);
      if (!response.ok) throw new Error(`SMTP settings failed with ${response.status}`);
      applyView((await response.json()) as SmtpView);
    } catch {
      setError('SMTP settings are unavailable.');
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    const next = enabled
      ? {
          ...draft,
          host: draft.host.trim(),
          from: draft.from.trim(),
          ...(draft.username?.trim()
            ? { username: draft.username.trim() }
            : { username: undefined }),
        }
      : null;
    if (
      next &&
      (!next.host ||
        !Number.isInteger(next.port) ||
        next.port < 1 ||
        next.port > 65_535 ||
        !/^[^\s@]+@[^\s@]+$/.test(next.from) ||
        (Boolean(next.username) && !view?.passwordConfigured && !password))
    ) {
      setError('Enter a valid host, port, sender email, and credential pair.');
      return;
    }
    setBusy('save');
    setError(null);
    setMessage(null);
    try {
      const response = await smtpRequest(getTokenRef.current, '', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: next,
          ...(password ? { password } : {}),
        }),
      });
      await checkResponse(response, 'SMTP settings could not be saved. Refresh and retry.');
      const body = (await response.json()) as SmtpView;
      applyView(body);
      setMessage(
        next
          ? 'SMTP settings saved.'
          : 'Email delivery disabled. In-app notifications remain active.',
      );
    } catch (cause) {
      setError(requestErrorMessage(cause, 'SMTP settings could not be saved.'));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async (): Promise<void> => {
    setBusy('test');
    setError(null);
    setMessage(null);
    try {
      const response = await smtpRequest(getTokenRef.current, '/test', { method: 'POST' });
      await checkResponse(response, 'SMTP test failed. Ask an operator to check the mail service.');
      const body = (await response.json()) as { to?: string };
      setMessage(`Test message sent to ${body.to}.`);
    } catch (cause) {
      setError(requestErrorMessage(cause, 'SMTP test failed.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="mt-6 rounded-xl border border-line bg-surface p-4 sm:p-5"
      aria-labelledby="smtp-settings-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="smtp-settings-title" className="text-lg font-medium text-ink">
            Notification email
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
            In-app notifications are always durable. SMTP adds an optional plain-text email copy.
          </p>
        </div>
        {view && (
          <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-xs font-semibold text-ink-muted">
            {view.source === 'stored' ? 'Saved configuration' : 'Environment default'}
          </span>
        )}
      </div>

      {busy === 'load' && <p className="mt-4 text-sm text-ink-muted">Loading email settings…</p>}
      {view && busy !== 'load' && (
        <div className="mt-5 space-y-4">
          <label className="flex items-center gap-3 text-sm font-semibold text-ink">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                setEnabled(event.target.checked);
                if (event.target.checked && !view.config) setDraft(EMPTY);
              }}
            />
            Send email copies
          </label>
          {enabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-semibold text-ink">
                SMTP host
                <input
                  value={draft.host}
                  onChange={(event) => setDraft({ ...draft, host: event.target.value })}
                  className="sre-field bg-canvas font-normal"
                  autoComplete="off"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-ink">
                Port
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={draft.port}
                  onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })}
                  className="sre-field bg-canvas font-normal"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-ink">
                Sender email
                <input
                  type="email"
                  value={draft.from}
                  onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                  className="sre-field bg-canvas font-normal"
                  autoComplete="email"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-ink">
                Username <span className="font-normal text-ink-faint">optional</span>
                <input
                  value={draft.username ?? ''}
                  onChange={(event) =>
                    setDraft({ ...draft, username: event.target.value || undefined })
                  }
                  className="sre-field bg-canvas font-normal"
                  autoComplete="username"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-ink">
                Password
                <input
                  type="password"
                  value={password}
                  placeholder={
                    view.passwordConfigured ? 'Stored; enter to replace' : 'Required with username'
                  }
                  onChange={(event) => setPassword(event.target.value)}
                  className="sre-field bg-canvas font-normal"
                  autoComplete="new-password"
                />
              </label>
              <label className="flex items-center gap-3 self-end py-2 text-sm font-semibold text-ink">
                <input
                  type="checkbox"
                  checked={draft.secure}
                  onChange={(event) => setDraft({ ...draft, secure: event.target.checked })}
                />
                TLS from connection start
              </label>
              {!draft.secure && (
                <p className="sm:col-span-2 text-xs text-ink-faint">
                  With TLS-from-start off, the SMTP client upgrades with STARTTLS when the server
                  offers it.
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              className="sre-action sre-action-primary"
              onClick={() => void save()}
            >
              {busy === 'save' ? 'Saving…' : 'Save email settings'}
            </button>
            <button
              type="button"
              disabled={busy !== null || !view.config}
              className="sre-action"
              onClick={() => void sendTest()}
            >
              {busy === 'test' ? 'Sending…' : 'Send test email'}
            </button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm text-success">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-critical">
          {error}
        </p>
      )}
    </section>
  );
}
