import { useState } from 'react';
import { useSession } from '../auth';
import { WorkspaceMutationConfirmation } from '../components/WorkspaceMutationConfirmation';
import { invalidateMe } from '../lib/me-store';
import { requestErrorMessage } from '../lib/request-error';
import { adminRequest } from './api';

interface Candidate {
  userId: string;
  email: string | null;
  role: string;
}

/** Explicit owner recovery, separate from account or provider recovery. */
export function OwnerRecovery({
  workspace,
  onRecovered,
}: {
  workspace: { id: string; name: string; slug: string; ownership: { inactiveOwnerCount: number } };
  onRecovered(): Promise<void>;
}) {
  const session = useSession();
  const [members, setMembers] = useState<Candidate[]>();
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState<{ member: Candidate; reason: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await adminRequest<{ members: Candidate[] }>(
        session.getCredentials,
        `/tenants/${workspace.id}/recovery-members`,
      );
      setMembers(result.members);
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Could not load recovery members.'));
    } finally {
      setBusy(false);
    }
  };
  const recover = async () => {
    if (!confirmation || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await adminRequest(session.getCredentials, `/tenants/${workspace.id}/recover-owner`, {
        method: 'POST',
        body: { userId: confirmation.member.userId, reason: confirmation.reason },
      });
      invalidateMe(session.sessionKey ?? null);
      await onRecovered();
      setConfirmation(undefined);
      setMembers(undefined);
    } catch (cause) {
      setError(
        requestErrorMessage(
          cause,
          'Ownership recovery failed. Refresh and check the current owners.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mt-4 space-y-3 rounded-lg border border-warning-line bg-warning-soft p-4">
      <p className="text-sm font-semibold">
        {workspace.ownership.inactiveOwnerCount
          ? 'Owner accounts are inactive.'
          : 'This workspace has no owner.'}
      </p>
      <p className="text-sm text-ink-muted">
        Recover ownership for an existing member. This does not enable accounts or change sign-in
        providers or directory policy.
      </p>
      {workspace.ownership.inactiveOwnerCount > 0 && (
        <p className="text-sm text-warning">
          Existing inactive owners keep their grants. Enabling those accounts restores their owner
          permissions.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      {!members ? (
        <button type="button" disabled={busy} onClick={() => void load()} className="sre-action">
          Recover owner
        </button>
      ) : confirmation ? (
        <>
          <p className="break-words text-sm">Reason: {confirmation.reason}</p>
          <WorkspaceMutationConfirmation
            title={`Make ${confirmation.member.email ?? confirmation.member.userId} the owner of ${workspace.name}?`}
            slug={workspace.slug}
            busy={busy}
            onCancel={() => setConfirmation(undefined)}
            onConfirm={() => void recover()}
          />
        </>
      ) : members.length === 0 ? (
        <p className="text-sm">
          No active members have active accounts. Resolve account access or workspace membership
          first, then reload this page.
        </p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const member = members.find((candidate) => candidate.userId === userId);
            if (member && reason.trim().length >= 3)
              setConfirmation({ member, reason: reason.trim() });
          }}
        >
          <label className="block text-sm">
            New owner
            <select
              required
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              className="sre-field mt-1 w-full"
            >
              <option value="">Choose an active member</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.email ?? member.userId} · {member.role} · {member.userId}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Recovery reason
            <textarea
              required
              minLength={3}
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="sre-field mt-1 w-full"
            />
          </label>
          <button
            disabled={!userId || reason.trim().length < 3}
            className="sre-action sre-action-primary"
          >
            Review recovery
          </button>
        </form>
      )}
    </section>
  );
}
