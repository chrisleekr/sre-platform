import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { config } from '../config';
import { sessionFetch } from '../lib/session-fetch';
import { SIGN_IN_PRESETS, type SignInPresetId } from './presets';
import { fieldClass, primaryButton, secondaryButton } from './shared';

export interface SignInMethodInput {
  displayName: string;
  issuer: string;
  clientId: string;
  clientAuthentication: 'none' | 'client_secret_post' | 'client_secret_basic';
  clientSecret?: string;
  domain: string;
}
export interface SignInMethodDraft {
  preset: SignInPresetId;
  issuer: string;
  clientId: string;
  domain: string;
  clientAuthentication: SignInMethodInput['clientAuthentication'];
}

function readDraft(key?: string): Partial<SignInMethodDraft> {
  try {
    return key ? JSON.parse(sessionStorage.getItem(key) ?? '{}') : {};
  } catch {
    return {};
  }
}

/** Guides registration and verifies endpoint reachability before the real sign-in test. */
export function SignInMethodSetup({
  submitLabel,
  onSubmit,
  nextDescription,
  draftKey,
  backTo,
  onBack,
  initial,
  secretStored = false,
  busy = false,
}: {
  submitLabel: string;
  onSubmit(input: SignInMethodInput): Promise<void>;
  nextDescription?: string;
  draftKey?: string;
  backTo?: string;
  onBack?: () => void;
  initial?: SignInMethodDraft;
  secretStored?: boolean;
  busy?: boolean;
}) {
  const saved = readDraft(draftKey);
  const [draft, setDraft] = useState<SignInMethodDraft>(
    initial ?? {
      preset: saved.preset ?? 'auth0',
      issuer: saved.issuer ?? '',
      clientId: saved.clientId ?? '',
      domain: saved.domain ?? '',
      clientAuthentication:
        saved.clientAuthentication ??
        (saved.preset === 'okta' ? 'client_secret_basic' : 'client_secret_post'),
    },
  );
  const [clientSecret, setClientSecret] = useState('');
  const [replaceSecret, setReplaceSecret] = useState(!secretStored);
  const [checking, setChecking] = useState(false);
  const [checkedIssuer, setCheckedIssuer] = useState('');
  const [error, setError] = useState<string>();
  const [copyStatus, setCopyStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [checkedDomain, setCheckedDomain] = useState('');
  const [invalidDomain, setInvalidDomain] = useState(false);
  const domainGeneration = useRef(0);
  const submitting = useRef(false);
  const generation = useRef(0);
  const preset = SIGN_IN_PRESETS.find((value) => value.id === draft.preset) ?? SIGN_IN_PRESETS[0]!;
  const callback = window.location.origin + '/auth/callback';

  function update(patch: Partial<SignInMethodDraft>) {
    if (
      initial &&
      ((patch.issuer !== undefined && patch.issuer !== initial.issuer) ||
        (patch.clientId !== undefined && patch.clientId !== initial.clientId) ||
        (patch.clientAuthentication !== undefined &&
          patch.clientAuthentication !== initial.clientAuthentication))
    )
      setReplaceSecret(true);
    const next = { ...draft, ...patch };
    setDraft(next);
    setError(undefined);
    if (patch.issuer !== undefined) {
      generation.current++;
      setCheckedIssuer('');
      setChecking(false);
    }
    if (patch.domain !== undefined) {
      domainGeneration.current++;
      setCheckedDomain('');
      setInvalidDomain(false);
    }
    if (draftKey) {
      try {
        sessionStorage.setItem(draftKey, JSON.stringify(next));
      } catch {
        /* Saving progress must not block sign-in. */
      }
    }
  }
  async function checkDomain() {
    const domain = draft.domain.trim().toLowerCase();
    if (!domain) return false;
    if (checkedDomain === domain) return !invalidDomain;
    const current = ++domainGeneration.current;
    try {
      const response = await sessionFetch(
        config.apiBaseUrl +
          '/workspace-email-domains/' +
          encodeURIComponent(domain) +
          '/eligibility',
      );
      const result = (await response.json()) as { eligible?: boolean; error?: string };
      if (current !== domainGeneration.current) return false;
      if (!response.ok || typeof result.eligible !== 'boolean')
        throw new Error(result.error ?? 'The work email domain could not be checked. Try again.');
      setCheckedDomain(domain);
      setInvalidDomain(!result.eligible);
      if (!result.eligible)
        setError(result.error ?? 'Use your work email domain, not a public mailbox service.');
      return result.eligible;
    } catch (cause) {
      if (current === domainGeneration.current) {
        setCheckedDomain('');
        setInvalidDomain(false);
        setError(
          cause instanceof Error ? cause.message : 'The work email domain could not be checked.',
        );
      }
      return false;
    }
  }
  async function discover() {
    const current = ++generation.current;
    const issuer = draft.issuer.trim();
    setChecking(true);
    setError(undefined);
    try {
      const response = await sessionFetch(config.apiBaseUrl + '/foundings/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuer }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(
          result.error ?? 'We could not reach that directory. Check the URL and try again.',
        );
      if (current !== generation.current) return false;
      setCheckedIssuer(issuer);
      return true;
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : 'Connection check failed. Try again.');
      return false;
    } finally {
      if (current === generation.current) setChecking(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(undefined);
    try {
      if (checkedIssuer !== draft.issuer.trim() && !(await discover())) return;
      const domain = draft.domain.trim().toLowerCase();
      if (!(await checkDomain())) return;
      await onSubmit({
        displayName: preset.name,
        issuer: draft.issuer.trim(),
        clientId: draft.clientId.trim(),
        clientAuthentication: draft.clientAuthentication,
        domain,
        ...(draft.clientAuthentication !== 'none' && replaceSecret ? { clientSecret } : {}),
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The sign-in method could not be saved. Try again.',
      );
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]"
    >
      <div className="min-w-0 space-y-5">
        <label className="block text-sm font-medium">
          Identity service
          <select
            aria-label="Identity service"
            className={fieldClass}
            value={draft.preset}
            onChange={(event) =>
              update({
                preset: event.target.value as SignInPresetId,
                clientAuthentication:
                  event.target.value === 'okta' ? 'client_secret_basic' : 'client_secret_post',
              })
            }
          >
            {SIGN_IN_PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <section className="rounded-xl border border-line bg-surface-subtle p-4">
          <h2 className="font-medium">1. Register your application</h2>
          <p className="mt-1 text-sm text-ink-muted">{preset.registration}</p>
          <div className="mt-3 text-sm">
            <h3 className="font-medium">Step-by-step instructions for {preset.name}</h3>
            <ol className="mt-3 list-decimal space-y-2 pl-5 leading-6">
              {preset.instructions.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
            <a
              className="mt-3 inline-block text-accent underline"
              href={preset.documentation}
              target="_blank"
              rel="noreferrer"
            >
              Official setup guide
            </a>
          </div>
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Callback URL
          </p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            <code className="min-w-0 break-all text-sm">{callback}</code>
            <button
              type="button"
              className="sre-action"
              onClick={() =>
                void navigator.clipboard
                  .writeText(callback)
                  .then(() => setCopyStatus('Callback URL copied.'))
                  .catch(() => setCopyStatus('Select the callback URL and copy it manually.'))
              }
            >
              Copy callback URL
            </button>
          </div>
          {copyStatus && (
            <p role="status" className="mt-1 text-xs text-ink-muted">
              {copyStatus}
            </p>
          )}
        </section>
        <section className="space-y-4">
          <h2 className="font-medium">2. Enter the application details</h2>
          <div>
            <label htmlFor="directory-url" className="text-sm font-medium">
              {draft.preset === 'auth0' ? 'Auth0 domain / issuer URL' : 'Directory URL'}
            </label>
            <input
              id="directory-url"
              aria-describedby={error ? 'sign-in-setup-error' : undefined}
              type="url"
              required
              className={fieldClass}
              value={draft.issuer}
              placeholder={preset.issuerExample}
              onChange={(event) => update({ issuer: event.target.value })}
            />
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              {draft.preset === 'auth0'
                ? 'Use your Auth0 Domain with https:// before it. Example: '
                : 'The OpenID Connect issuer from your service. Example: '}
              <span className="break-all">{preset.issuerExample}</span>
            </p>
            <button
              type="button"
              disabled={!draft.issuer || checking || saving}
              className="sre-action mt-2"
              onClick={() => void discover()}
            >
              {checking ? 'Checking directory…' : 'Check directory'}
            </button>
            {checkedIssuer === draft.issuer.trim() && checkedIssuer && (
              <p role="status" className="mt-2 text-sm text-success">
                Directory reachable. Client ID, secret, and callback are not verified yet. Continue
                to sign in to test them.
              </p>
            )}
          </div>
          <label className="block text-sm font-medium">
            Client ID
            <input
              aria-label="Client ID"
              required
              className={fieldClass}
              value={draft.clientId}
              onChange={(event) => update({ clientId: event.target.value })}
              autoComplete="off"
            />
            <span className="mt-1 block text-xs font-normal text-ink-muted">
              The application's identifier, not its secret.
            </span>
          </label>
          {draft.preset === 'other' ? (
            <label className="block text-sm font-medium">
              Application authentication
              <select
                aria-label="Application authentication"
                className={fieldClass}
                value={draft.clientAuthentication}
                onChange={(event) =>
                  update({
                    clientAuthentication: event.target
                      .value as SignInMethodDraft['clientAuthentication'],
                  })
                }
              >
                <option value="client_secret_post">Client secret in POST body</option>
                <option value="client_secret_basic">
                  Web application with HTTP Basic authentication
                </option>
                {draft.preset === 'other' && (
                  <option value="none">Public client without a secret</option>
                )}
              </select>
            </label>
          ) : (
            <p className="text-sm text-ink-muted">
              The client secret stays on the server and is sent using{' '}
              {draft.clientAuthentication === 'client_secret_basic'
                ? 'HTTP Basic authentication'
                : 'POST body authentication'}
              .
            </p>
          )}
          {draft.clientAuthentication !== 'none' && (
            <div>
              {secretStored && (
                <label className="mb-3 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={replaceSecret}
                    onChange={(event) => setReplaceSecret(event.target.checked)}
                  />
                  Replace stored client secret
                </label>
              )}
              {!replaceSecret ? (
                <p className="text-sm text-ink-muted">
                  A client secret is stored securely. It will be kept when you save.
                </p>
              ) : (
                <label className="block text-sm font-medium">
                  Client secret
                  <input
                    aria-label="Client secret"
                    type="password"
                    required
                    autoComplete="new-password"
                    className={fieldClass}
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                  />
                  <span className="mt-1 block text-xs font-normal text-ink-muted">
                    Encrypted when submitted. Never saved in browser storage. Re-enter it if you
                    reload this form or return from a previous step.
                  </span>
                </label>
              )}
            </div>
          )}
          <label className="block text-sm font-medium">
            Work email domain
            <input
              aria-label="Work email domain"
              aria-describedby={error ? 'sign-in-setup-error' : undefined}
              required
              className={fieldClass}
              value={draft.domain}
              placeholder="example.com"
              onBlur={() => void checkDomain()}
              onChange={(event) => update({ domain: event.target.value })}
            />
            <span className="mt-1 block text-xs font-normal text-ink-muted">
              Use the domain after @ in your work email. You will prove ownership with a DNS TXT
              record after setup.
            </span>
          </label>
        </section>
        {error && (
          <p
            id="sign-in-setup-error"
            role="alert"
            className="rounded-lg border border-critical-line bg-critical-soft p-3 text-sm text-critical"
          >
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          {onBack ? (
            <button type="button" className={secondaryButton} onClick={onBack}>
              ← Back to workspace details
            </button>
          ) : backTo ? (
            <Link to={backTo} className={secondaryButton}>
              ← Back to workspace details
            </Link>
          ) : null}
          <button
            type="submit"
            disabled={
              saving ||
              busy ||
              checking ||
              invalidDomain ||
              !draft.clientId.trim() ||
              !draft.domain.trim() ||
              !draft.issuer.trim() ||
              (draft.clientAuthentication !== 'none' && replaceSecret && !clientSecret)
            }
            className={primaryButton}
          >
            {saving ? 'Saving and opening sign-in…' : submitLabel}
          </button>
        </div>
        {(backTo || onBack) && !initial && (
          <p className="text-xs leading-5 text-ink-muted">
            Back keeps your workspace and application details in this tab. Your client secret is not
            saved, so you will need to enter it again.
          </p>
        )}
      </div>
      <aside className="h-fit rounded-xl border border-line bg-surface p-4 text-sm leading-6">
        <h2 className="font-medium">What happens next</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-4 text-ink-muted">
          <li>Sign in with your work account.</li>
          <li>Confirm the saved details and create the workspace.</li>
          <li>Verify your domain from the workspace home so your team can join.</li>
        </ol>
        {nextDescription && (
          <p className="mt-4 border-t border-line pt-3 text-ink-muted">{nextDescription}</p>
        )}
      </aside>
    </form>
  );
}
