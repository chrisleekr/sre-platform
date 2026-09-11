import { sessionFetch } from '../lib/session-fetch';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { config } from '../config';
import { messageForApiCode } from '../i18n/messages';
import type { SignInRetry } from '../lib/application-session';
import { readWorkspaceDraft, readWorkspaceSignIn, type WorkspaceDraft } from './draft';
import { fieldClass, primaryButton } from './shared';

function suggestedAddress(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

/** First onboarding step, with a server-backed workspace-address check. */
export function WorkspaceIdentityPage({
  onContinue,
}: {
  onContinue: (draft: WorkspaceDraft, continuation?: SignInRetry) => void;
}) {
  const [searchParams] = useSearchParams();
  const previous = readWorkspaceDraft();
  const continuation = useRef(previous ? readWorkspaceSignIn(previous.slug)?.retry : undefined);
  const [requestedName, setName] = useState(previous?.requestedName ?? '');
  const [slug, setSlug] = useState(previous?.slug ?? '');
  const nameRef = useRef(requestedName);
  const slugRef = useRef(slug);
  const addressRequest = useRef(0);
  const submitting = useRef(false);
  const addressEdited = useRef(Boolean(previous?.slug));
  const [pending, setPending] = useState(false);
  const [existing, setExisting] = useState<'workspace' | null>(null);
  const [addressState, setAddressState] = useState<
    'idle' | 'checking' | 'available' | 'taken' | 'error'
  >('idle');

  async function checkAddress(candidate = slugRef.current): Promise<boolean> {
    const checkedSlug = candidate.trim().toLowerCase();
    if (!checkedSlug) return false;
    const request = ++addressRequest.current;
    setAddressState('checking');
    setExisting(null);
    try {
      const response = await sessionFetch(
        `${config.apiBaseUrl}/workspace-addresses/${encodeURIComponent(checkedSlug)}/availability`,
      );
      const body = (await response.json()) as { available?: boolean; code?: string };
      let available = response.ok && body.available === true;
      let recovered: { providerId: string; foundingId: string; returnTo: string } | undefined;
      let destination: 'workspace' | null = null;
      if (!available && body.code === 'workspace_address_taken') {
        const draftResponse = await sessionFetch(
          `${config.apiBaseUrl}/workspace-setup-drafts/${encodeURIComponent(checkedSlug)}`,
        );
        const saved = (await draftResponse.json().catch(() => null)) as {
          providerId?: unknown;
          foundingId?: unknown;
        } | null;
        if (
          draftResponse.ok &&
          typeof saved?.providerId === 'string' &&
          typeof saved.foundingId === 'string'
        ) {
          available = true;
          recovered = {
            providerId: saved.providerId,
            foundingId: saved.foundingId,
            returnTo: '/get-started',
          };
        }
        if (!recovered) {
          const lookup = await sessionFetch(
            `${config.apiBaseUrl}/workspaces/${encodeURIComponent(checkedSlug)}/sign-in-methods`,
          );
          const result = (await lookup.json()) as {
            workspace?: { status: string };
          };
          if (lookup.ok && result.workspace?.status === 'active') destination = 'workspace';
        }
      }
      if (
        request !== addressRequest.current ||
        slugRef.current.trim().toLowerCase() !== checkedSlug
      ) {
        return false;
      }
      setAddressState(
        available ? 'available' : body.code === 'workspace_address_taken' ? 'taken' : 'error',
      );
      setExisting(destination);
      if (recovered) continuation.current = recovered;
      return available;
    } catch {
      if (
        request !== addressRequest.current ||
        slugRef.current.trim().toLowerCase() !== checkedSlug
      ) {
        return false;
      }
      setAddressState('error');
      return false;
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      const checkedSlug = slugRef.current.trim().toLowerCase();
      if (!(await checkAddress(checkedSlug))) return;
      if (slugRef.current.trim().toLowerCase() !== checkedSlug) return;
      const latestName = nameRef.current.trim();
      if (!latestName) return;
      const draft = { requestedName: latestName, slug: checkedSlug };
      if (continuation.current) onContinue(draft, continuation.current);
      else onContinue(draft);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  const statusId = 'workspace-address-status';
  return (
    <>
      {searchParams.get('setup') === 'ended' && (
        <p role="alert" className="mb-4 text-warning">
          This setup request ended. Start again to create a new request.
        </p>
      )}
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="workspace-name" className="text-sm font-medium">
          Workspace name
        </label>
        <input
          id="workspace-name"
          aria-describedby="workspace-name-help"
          placeholder="Acme Operations"
          className={fieldClass}
          required
          value={requestedName}
          onChange={(event) => {
            const name = event.target.value;
            nameRef.current = name;
            setName(name);
            if (!addressEdited.current) {
              const suggested = suggestedAddress(name);
              slugRef.current = suggested;
              addressRequest.current += 1;
              setSlug(suggested);
              setAddressState('idle');
            }
          }}
        />
        <p id="workspace-name-help" className="mt-2 text-sm text-ink-muted">
          Your team or organisation’s name.
        </p>
        <label htmlFor="workspace-address" className="mt-4 block text-sm font-medium">
          Workspace address
        </label>
        <input
          id="workspace-address"
          className={fieldClass}
          required
          aria-describedby={statusId}
          value={slug}
          onChange={(event) => {
            addressEdited.current = true;
            const nextSlug = event.target.value.toLowerCase();
            slugRef.current = nextSlug;
            addressRequest.current += 1;
            setSlug(nextSlug);
            setExisting(null);
            setAddressState('idle');
          }}
          onBlur={() => void checkAddress()}
        />
        <p className="mt-2 break-all font-mono text-xs text-ink-muted">
          {window.location.origin}/{slug || 'your-workspace'}
        </p>
        <p
          id={statusId}
          role="status"
          aria-live="polite"
          className="mt-2 min-h-5 text-sm text-ink-muted"
        >
          {addressState === 'checking'
            ? 'Checking…'
            : addressState === 'available'
              ? 'Available.'
              : addressState === 'taken'
                ? messageForApiCode('workspace_address_taken')
                : addressState === 'error'
                  ? 'Address check is unavailable. Try again.'
                  : 'Your team will use this address to sign in. You can edit it until the workspace is created.'}
        </p>
        {existing ? (
          <Link
            to={`/${encodeURIComponent(slug.trim().toLowerCase())}`}
            className={`${primaryButton} mt-5 inline-flex`}
          >
            Sign in to workspace
          </Link>
        ) : (
          <button
            type="submit"
            className={`${primaryButton} mt-5`}
            disabled={!requestedName || !slug || addressState === 'taken' || pending}
          >
            {pending ? 'Checking address…' : 'Continue to company sign-in'}
          </button>
        )}
      </form>
      <p className="mt-6 text-sm leading-6 text-ink-muted">
        Next, connect your company sign-in. You’ll need access to your identity provider’s settings.
        Domain verification follows workspace creation.
      </p>
    </>
  );
}
