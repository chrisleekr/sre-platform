import { useState } from 'react';
import type { WorkspaceDomain } from '../lib/workspace-settings';

type CheckStatus = 'pending' | 'verified' | 'expired' | 'conflict';
const RESULTS: Record<CheckStatus, string> = {
  verified: 'DNS verified. Domain ownership is confirmed.',
  pending:
    'The matching TXT record is not confirmed yet. Check the host and value above. DNS changes may take time to appear; you can try again.',
  expired:
    'This verification proof expired. Ask the workspace owner to remove and add the domain again for a new TXT record.',
  conflict:
    'This domain could not be verified because of a conflicting claim. Ask your platform administrator to review it.',
};

/** Manual DNS checks do not bypass proof validation or grant other authentication-setting access. */
export function DomainDnsVerification({
  domain,
  canVerify,
  platformManaged,
  busy,
  checking,
  onCheck,
}: {
  domain: WorkspaceDomain;
  canVerify: boolean;
  platformManaged: boolean;
  busy: boolean;
  checking: boolean;
  onCheck: () => Promise<{ status: CheckStatus }>;
}) {
  const [result, setResult] = useState<CheckStatus>();
  const [error, setError] = useState<string>();
  const pending = domain.status === 'pending';
  return (
    <div className="mt-3 space-y-2 text-sm">
      <p className="text-xs text-ink-muted">
        Last checked:{' '}
        {domain.lastCheckedAt ? new Date(domain.lastCheckedAt).toLocaleString() : 'Not checked yet'}
      </p>
      {pending && !platformManaged && canVerify ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setError(undefined);
            setResult(undefined);
            void onCheck()
              .then(({ status }) => setResult(status))
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error &&
                    /support session|impersonation session/.test(cause.message)
                    ? 'Support access is unavailable. Start a new support session or ask the workspace owner to verify this domain.'
                    : 'DNS verification could not complete. Try again shortly.',
                ),
              );
          }}
          className="sre-action min-h-11 text-xs"
        >
          {checking ? 'Checking DNS…' : 'Verify DNS now'}
        </button>
      ) : pending ? (
        <p className="text-ink-muted">
          {platformManaged
            ? 'This domain is managed by the platform. Ask a platform administrator to verify it.'
            : 'Ask the workspace owner or a platform administrator in a support session to verify this domain.'}
        </p>
      ) : null}
      {checking && <p role="status">Checking the DNS TXT record…</p>}
      {result && (
        <p role="status" className="text-ink-secondary">
          {RESULTS[result]}
        </p>
      )}
      {error && (
        <p role="alert" className="text-critical">
          {error}
        </p>
      )}
      {domain.status === 'failed' && !result && (
        <p className="text-warning">
          Verification failed or expired. Ask the workspace owner or platform administrator to
          review this domain before trying again.
        </p>
      )}
    </div>
  );
}
