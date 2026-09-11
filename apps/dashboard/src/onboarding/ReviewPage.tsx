import { credentialHeaders } from '../lib/request-credentials';
import { sessionFetch } from '../lib/session-fetch';
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { messageForApiCode } from '../i18n/messages';
import { useMe } from '../lib/me-store';
import type { WorkspaceDraft } from './draft';
import { primaryButton } from './shared';
import { usePublicConfig } from './usePublicConfig';

interface Terms {
  url: string;
  version: string;
}

/** Reviews the founder-authenticated request before policy-controlled provisioning. */
export function ReviewPage({
  workspace,
  signInMethod,
  domain,
  terms,
  registrationMode,
  onSubmit,
  onSubmitted,
  onEditWorkspace,
  onEditSignIn,
}: {
  workspace?: WorkspaceDraft;
  signInMethod?: string;
  domain?: string;
  terms?: Terms;
  registrationMode?: 'open' | 'approval_required' | 'closed';
  onSubmit?: (input: { termsAcceptedVersion?: string }) => void;
  onSubmitted?: () => void;
  onEditWorkspace?: () => void;
  onEditSignIn?: () => void;
}) {
  const session = useSession();
  const navigate = useNavigate();
  const publicConfig = usePublicConfig();
  const me = useMe(
    session.getCredentials,
    session.status === 'authenticated',
    session.sessionKey,
    session.foundingId,
  );
  const persistedFounding = me.data?.founding;
  const draft =
    workspace ??
    (persistedFounding?.requestedName && persistedFounding.slug
      ? { requestedName: persistedFounding.requestedName, slug: persistedFounding.slug }
      : undefined);
  const reviewReady = Boolean(
    draft && (onSubmit || (persistedFounding?.provider && me.data?.user.email)),
  );
  const configuredTerms =
    terms ??
    (publicConfig.value?.termsUrl && publicConfig.value.termsVersion
      ? { url: publicConfig.value.termsUrl, version: publicConfig.value.termsVersion }
      : undefined);
  const mode = registrationMode ?? publicConfig.value?.registrationMode;
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (
      submitting.current ||
      !reviewReady ||
      !draft ||
      !mode ||
      mode === 'closed' ||
      (configuredTerms && !accepted)
    )
      return;
    const input = configuredTerms ? { termsAcceptedVersion: configuredTerms.version } : {};
    if (onSubmit) {
      onSubmit(input);
      return;
    }
    const foundingId = session.foundingId ?? persistedFounding?.id;
    if (!foundingId) {
      setError('Your setup session is unavailable. Start again.');
      return;
    }
    submitting.current = true;
    setSaving(true);
    try {
      const token = await session.getCredentials();
      const response = await sessionFetch(`${config.apiBaseUrl}/foundings/${foundingId}`, {
        method: 'PUT',
        headers: { ...credentialHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ ...draft, ...input }),
      });
      const body = (await response.json().catch(() => null)) as { code?: string } | null;
      if (!response.ok) throw new Error(messageForApiCode(body?.code));
      me.refresh();
      if (onSubmitted) onSubmitted();
      else navigate('/get-started');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Setup could not be submitted.');
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      {!onSubmit &&
        !reviewReady &&
        (me.error ? (
          <div role="alert" className="mb-5 rounded-lg bg-warning-soft p-3 text-sm text-warning">
            Saved workspace details could not be loaded. Your setup is unchanged.
            <button
              type="button"
              className="ml-2 font-semibold underline"
              onClick={() => me.refresh()}
            >
              Retry loading details
            </button>
          </div>
        ) : (
          <p role="status" className="mb-5 text-sm text-ink-muted">
            Loading saved workspace details…
          </p>
        ))}
      <dl className="grid gap-3 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="text-ink-muted">Workspace</dt>
        <dd className="flex flex-wrap items-center justify-between gap-3">
          <span>{draft?.requestedName ?? 'Not set'}</span>
          {onEditWorkspace && (
            <button
              type="button"
              className="font-semibold text-info underline"
              onClick={onEditWorkspace}
            >
              Edit workspace
            </button>
          )}
        </dd>
        <dt className="text-ink-muted">Address</dt>
        <dd className="break-all">
          {draft?.slug ? `${window.location.origin}/${draft.slug}` : 'Not set'}
        </dd>
        <dt className="text-ink-muted">Sign-in</dt>
        <dd className="flex flex-wrap items-center justify-between gap-3">
          <span>
            {signInMethod ?? persistedFounding?.provider?.displayName ?? 'Loading sign-in details…'}
          </span>
          {onEditSignIn && (
            <button
              type="button"
              className="font-semibold text-info underline"
              onClick={onEditSignIn}
            >
              Edit sign-in
            </button>
          )}
        </dd>
        {persistedFounding?.provider && (
          <>
            <dt className="text-ink-muted">Directory</dt>
            <dd className="break-all">{persistedFounding.provider.issuer}</dd>
          </>
        )}
        <dt className="text-ink-muted">Domain</dt>
        <dd>{domain ?? persistedFounding?.domain ?? 'Loading domain…'}</dd>
        <dt className="text-ink-muted">You</dt>
        <dd>{me.data?.user.email ? `${me.data.user.email} · Owner` : 'Owner'}</dd>
      </dl>
      {mode === 'approval_required' && (
        <p className="mt-5 rounded-lg bg-warning-soft p-3 text-sm text-warning">
          An administrator will review this request before setup begins.
        </p>
      )}
      {mode === 'closed' && (
        <p role="alert" className="mt-5 rounded-lg bg-warning-soft p-3 text-sm text-warning">
          Workspace registration is closed. Ask your administrator for help.
        </p>
      )}
      <form className="mt-6" onSubmit={(event) => void submit(event)}>
        {configuredTerms && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />{' '}
            <span>
              I accept the{' '}
              <a className="underline" href={configuredTerms.url}>
                terms
              </a>
              .
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-critical">
            {error}
          </p>
        )}
        <button
          type="submit"
          className={`${primaryButton} mt-5`}
          disabled={
            saving ||
            !reviewReady ||
            !mode ||
            !draft ||
            mode === 'closed' ||
            Boolean(configuredTerms && !accepted)
          }
        >
          {saving
            ? 'Submitting workspace…'
            : mode === 'approval_required'
              ? 'Submit request'
              : 'Set up workspace'}
        </button>
      </form>
    </>
  );
}
