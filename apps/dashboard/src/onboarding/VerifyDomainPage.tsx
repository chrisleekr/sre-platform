import { credentialHeaders } from '../lib/request-credentials';
import { sessionFetch } from '../lib/session-fetch';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { useMe } from '../lib/me-store';
import { primaryButton } from './shared';

interface DomainView {
  id: string;
  domain: string;
  status: string;
  challengeHost: string;
  challengeValue: string | null;
  lastCheckedAt: string | null;
  foundingId?: string | null;
}

interface VerifyDomainProps {
  domain?: DomainView;
  onCheck?: () => void;
}

/** DNS ownership instructions and an explicit bounded recheck. */
export function VerifyDomainPage(props: VerifyDomainProps) {
  const { id } = useParams();
  return (
    <DomainVerification key={id ?? props.domain?.id ?? 'workspace-domain'} {...props} id={id} />
  );
}

function DomainVerification({
  domain: supplied,
  onCheck,
  id,
}: VerifyDomainProps & { id?: string }) {
  const session = useSession();
  const [selectedDomain, setSelectedDomain] = useState<DomainView>();
  const [loadError, setLoadError] = useState<string>();
  const me = useMe(
    session.getCredentials,
    session.status === 'authenticated' && !supplied,
    session.sessionKey,
    session.foundingId,
  );
  const domain = supplied ?? (id ? selectedDomain : me.data?.domain);
  useEffect(() => {
    if (!id || supplied) return;
    let live = true;
    setLoadError(undefined);
    void session
      .getCredentials()
      .then((token) =>
        sessionFetch(`${config.apiBaseUrl}/tenant/domains/${encodeURIComponent(id)}`, {
          headers: { ...credentialHeaders(token) },
        }),
      )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            'This domain could not be loaded. Check the link or return to Authentication settings.',
          );
        const result = (await response.json()) as { domain: DomainView };
        if (live) setSelectedDomain(result.domain);
      })
      .catch((cause) => {
        if (live)
          setLoadError(cause instanceof Error ? cause.message : 'Domain details are unavailable.');
      });
    return () => {
      live = false;
    };
  }, [id, session.getCredentials, supplied]);
  const [status, setStatus] = useState('');
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const copyValue = async (): Promise<void> => {
    if (!domain?.challengeValue) return;
    try {
      await navigator.clipboard.writeText(domain.challengeValue);
      setStatus('Copied value.');
    } catch {
      setStatus('Could not copy. Select the value and copy it manually.');
    }
  };
  const check = async (): Promise<void> => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setStatus('Checking…');
    try {
      if (onCheck) {
        await onCheck();
        return;
      }
      if (!domain?.id) {
        setStatus('Check failed. Try again.');
        return;
      }
      const token = await session.getCredentials();
      const response = await sessionFetch(
        `${config.apiBaseUrl}/tenant/domains/${domain.id}/check`,
        { method: 'POST', headers: { ...credentialHeaders(token) } },
      );
      const result = (await response.json().catch(() => null)) as {
        status?: string;
        error?: string;
      } | null;
      if (!response.ok) throw new Error(result?.error ?? 'DNS check failed. Try again.');
      const nextStatus = result?.status ?? 'pending';
      setStatus(
        nextStatus === 'verified'
          ? 'Domain verified. Your team can now sign in.'
          : nextStatus === 'conflict'
            ? 'This domain belongs to another workspace. Ask its owner or your platform administrator for help.'
            : nextStatus === 'expired'
              ? 'This proof expired. Return to Authentication settings to create a new domain proof.'
              : 'The DNS record is not visible yet. Check its host and value, allow time for propagation, then try again.',
      );
      if (selectedDomain)
        setSelectedDomain({
          ...selectedDomain,
          status: nextStatus,
          lastCheckedAt: new Date().toISOString(),
        });
      if (!id) me.refresh();
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : 'Check failed. Try again.');
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };
  return (
    <section className="mx-auto w-full max-w-3xl rounded-xl border border-line bg-surface p-5 sm:p-8">
      <h1 className="text-2xl font-medium">Verify your domain</h1>
      {!domain ? (
        <p role="alert" className="mt-4">
          {loadError ?? 'Loading domain details…'}
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          <p className="[overflow-wrap:anywhere]">
            Add this DNS TXT record for <strong>{domain.domain}</strong>.
          </p>
          <dl className="grid gap-2">
            <dt>Host</dt>
            <dd>
              <code className="break-all">{domain.challengeHost}</code>
              <button
                type="button"
                className="sre-action ml-2"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(domain.challengeHost)
                    .then(() => setStatus('Copied host.'))
                    .catch(() => setStatus('Select the host and copy it manually.'))
                }
              >
                Copy host
              </button>
            </dd>
            <dt>Value</dt>
            <dd className="flex flex-wrap items-center gap-3">
              <code className="break-all">{domain.challengeValue}</code>
              <button
                type="button"
                className="sre-action"
                disabled={!domain.challengeValue}
                onClick={() => void copyValue()}
              >
                Copy value
              </button>
            </dd>
            <dt>Status</dt>
            <dd>{domain.status}</dd>
            <dt>Last checked</dt>
            <dd>
              {domain.lastCheckedAt
                ? new Date(domain.lastCheckedAt).toLocaleString()
                : 'Not checked yet'}
            </dd>
          </dl>
          <p className="text-sm leading-6 text-ink-muted">
            Create a TXT record in the DNS service for this domain. Some services append the domain
            automatically; in that case enter only <code>_sre-platform</code> as the host. Keep the
            default TTL. DNS changes may take time to become visible.
          </p>
          <button
            type="button"
            className={primaryButton}
            disabled={checking}
            onClick={() => void check()}
          >
            Check now
          </button>
          <p role="status" aria-live="polite">
            {status}
          </p>
          <Link
            className="inline-block font-semibold text-accent underline"
            onClick={() => me.refresh()}
            to={domain.status === 'verified' ? '/w' : '/w/settings/authentication'}
          >
            {domain.status === 'verified' ? 'Open workspace' : 'Back to Authentication settings'}
          </Link>
        </div>
      )}
    </section>
  );
}
