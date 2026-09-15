import { checkResponse, requestErrorMessage } from '../lib/request-error';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SetupDialog } from './SetupDialog';
import { SetupActions } from './SetupDialogSlots';
import { useSession } from '../auth';
import { WorkspaceSettingsNavigation } from './WorkspaceSettingsNavigation';
import { config } from '../config';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { Link } from 'react-router-dom';

type Role = 'owner' | 'admin' | 'member';
interface Member {
  userId: string;
  email: string | null;
  role: Role;
  status: string;
  userStatus?: string;
}
interface Invitation {
  id: string;
  email: string;
  role: 'admin' | 'member';
  status: string;
}

interface MembersPanelProps {
  ownership?: {
    state: 'owned' | 'missing_owner' | 'inactive_owners';
    activeOwnerCount: number;
    inactiveOwnerCount: number;
  };
  viewer: { userId: string; role: Role; isPlatformAdmin?: boolean };
  members: Member[];
  invitations?: Invitation[];
  onInvite(): void;
  onRemove(userId: string): void;
  onRoleChange(userId: string, role: 'admin' | 'member'): void;
  onTransferOwnership(userId: string): void;
  onResendInvitation(id: string): void;
  onRevokeInvitation(id: string): void;
}

/** Renders the role-safe workspace directory and owner-preserving actions. */
export function MembersPanel({
  ownership,
  viewer,
  members,
  invitations = [],
  onInvite,
  onRemove,
  onRoleChange,
  onTransferOwnership,
  onResendInvitation,
  onRevokeInvitation,
}: MembersPanelProps) {
  const [removeTarget, setRemoveTarget] = useState<Member>();
  const canManage = viewer.role === 'owner' || viewer.role === 'admin';
  const owners = members.filter(
    (member) =>
      member.role === 'owner' &&
      member.status === 'active' &&
      (!member.userStatus || member.userStatus === 'active'),
  );
  const pendingInvitations = invitations.filter((invitation) => invitation.status === 'pending');
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Members</h1>
          <p className="text-sm text-ink-muted">People with access to this workspace.</p>
        </div>
        {canManage && (
          <button
            type="button"
            className="rounded-lg bg-strong px-4 py-2 text-sm font-semibold text-on-strong"
            onClick={onInvite}
          >
            Invite member
          </button>
        )}
      </div>
      {ownership && ownership.state !== 'owned' && (
        <p
          role="status"
          className="mt-4 rounded-lg border border-warning-line bg-warning-soft p-3 text-sm"
        >
          {ownership.state === 'missing_owner'
            ? 'This workspace has no owner.'
            : 'This workspace has owner memberships, but their accounts are inactive.'}{' '}
          Ask a platform administrator to recover ownership. Account status does not confirm
          external sign-in availability.
          {viewer.isPlatformAdmin && (
            <Link to="/admin/workspaces" className="mt-2 block font-semibold underline">
              Recover ownership in platform administration
            </Link>
          )}
        </p>
      )}
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-ink-muted">
              <th className="py-2">Email</th>
              <th>Role</th>
              <th>Status</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const lastOwner =
                member.role === 'owner' &&
                (ownership?.activeOwnerCount ?? owners.length) -
                  (!member.userStatus || member.userStatus === 'active' ? 1 : 0) <
                  1;
              const canEdit = canManage && member.userId !== viewer.userId;
              return (
                <tr key={member.userId} className="border-b border-line">
                  <td className="py-3">
                    {member.email ?? 'Email unavailable'}
                    {lastOwner && ownership?.activeOwnerCount !== 0 && (
                      <span className="ml-2 text-xs text-warning">Last owner</span>
                    )}
                  </td>
                  <td>{member.role}</td>
                  <td>
                    {member.status}
                    {member.userStatus && member.userStatus !== 'active'
                      ? ` · account ${member.userStatus}`
                      : ''}
                  </td>
                  <td className="space-x-2 py-2 text-right">
                    {viewer.role === 'owner' && member.status === 'active' && (
                      <button
                        type="button"
                        aria-label={`change role for ${member.email ?? member.userId}`}
                        disabled={!canEdit || lastOwner}
                        className="rounded px-2 py-1 disabled:opacity-40"
                        onClick={() =>
                          onRoleChange(member.userId, member.role === 'member' ? 'admin' : 'member')
                        }
                      >
                        Change role
                      </button>
                    )}
                    {member.status === 'active' &&
                      (viewer.role === 'owner' ||
                        (viewer.role === 'admin' && member.role === 'member')) && (
                        <button
                          type="button"
                          aria-label={`remove ${member.email ?? member.userId}`}
                          disabled={!canEdit || lastOwner}
                          className="rounded px-2 py-1 text-critical disabled:opacity-40"
                          onClick={() => setRemoveTarget(member)}
                        >
                          Remove
                        </button>
                      )}
                    {viewer.role === 'owner' &&
                      member.role !== 'owner' &&
                      (!member.userStatus || member.userStatus === 'active') &&
                      member.status === 'active' && (
                        <button
                          type="button"
                          aria-label={`transfer ownership to ${member.email ?? member.userId}`}
                          className="rounded px-2 py-1"
                          onClick={() => onTransferOwnership(member.userId)}
                        >
                          Transfer ownership
                        </button>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canManage && pendingInvitations.length > 0 && (
        <section className="mt-6">
          <h2 className="font-semibold">Pending invitations</h2>
          <ul className="mt-2 space-y-2">
            {pendingInvitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-subtle p-3"
              >
                <span>{invitation.email}</span>
                <span className="space-x-2">
                  <button
                    type="button"
                    aria-label={`Resend invitation to ${invitation.email}`}
                    onClick={() => onResendInvitation(invitation.id)}
                  >
                    Resend
                  </button>
                  <button
                    type="button"
                    aria-label={`Revoke invitation to ${invitation.email}`}
                    onClick={() => onRevokeInvitation(invitation.id)}
                  >
                    Revoke
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {removeTarget && (
        <SetupDialog
          title={`Remove ${removeTarget.email ?? 'this member'}?`}
          closeLabel="Close"
          size="compact"
          onClose={() => setRemoveTarget(undefined)}
        >
          <p className="mt-3 text-sm text-ink-muted">
            They lose access immediately, including any open incident view. Existing messages and
            approvals remain attributed to them.
          </p>
          <SetupActions>
            <button
              type="button"
              className="rounded-lg border border-line px-4 py-2"
              onClick={() => setRemoveTarget(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg bg-critical px-4 py-2 text-on-strong"
              onClick={() => {
                onRemove(removeTarget.userId);
                setRemoveTarget(undefined);
              }}
            >
              Remove member
            </button>
          </SetupActions>
        </SetupDialog>
      )}
    </section>
  );
}

/** Loads the current workspace directory and wires its existing administration endpoints. */
export function MembersPage() {
  const session = useSession();
  const getCredentials = session.getCredentials;
  const sessionKey = session.sessionKey;
  const loadVersion = useRef(0);
  const [data, setData] = useState<{
    ownership?: MembersPanelProps['ownership'];
    viewer: { userId: string; role: Role; isPlatformAdmin?: boolean };
    members: Member[];
    invitations?: Invitation[];
  }>();
  const [error, setError] = useState<string>();
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const load = useCallback(async (): Promise<void> => {
    if (!sessionKey) return;
    const version = ++loadVersion.current;
    try {
      const [meResponse, membersResponse] = await Promise.all([
        authenticatedFetch(`${config.apiBaseUrl}/me`, getCredentials),
        authenticatedFetch(`${config.apiBaseUrl}/tenant/members`, getCredentials),
      ]);
      if (!meResponse.ok || !membersResponse.ok) throw new Error('Member directory is unavailable');
      const me = (await meResponse.json()) as {
        user: { id: string; isPlatformAdmin?: boolean };
        tenant: { role: Role };
      };
      const members = (await membersResponse.json()) as {
        ownership?: MembersPanelProps['ownership'];
        members: Member[];
        invitations?: Invitation[];
      };
      if (version === loadVersion.current) {
        setData({
          viewer: {
            userId: me.user.id,
            role: me.tenant.role,
            isPlatformAdmin: me.user.isPlatformAdmin,
          },
          ...members,
        });
      }
    } catch (cause) {
      if (version === loadVersion.current) {
        setError(requestErrorMessage(cause, 'Member directory is unavailable'));
      }
    }
  }, [getCredentials, sessionKey]);
  useEffect(() => {
    loadVersion.current += 1;
    setData(undefined);
    setError(undefined);
    void load();
    return () => {
      loadVersion.current += 1;
    };
  }, [load]);
  if (!data) return error ? <p role="alert">{error}</p> : <p role="status">Loading members…</p>;
  const mutate = async (path: string, method: string, body?: unknown): Promise<void> => {
    const response = await authenticatedFetch(`${config.apiBaseUrl}${path}`, getCredentials, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    await checkResponse(response, 'Member update failed');
    await load();
  };
  const run = (operation: Promise<void>): void => {
    setError(undefined);
    void operation.catch((cause: unknown) => {
      setError(requestErrorMessage(cause, 'Member update failed'));
    });
  };
  return (
    <div className="space-y-4">
      <WorkspaceSettingsNavigation />
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      <MembersPanel
        {...data}
        onInvite={() => setInviting(true)}
        onRemove={(id) => run(mutate(`/tenant/members/${id}`, 'DELETE'))}
        onRoleChange={(id, role) => run(mutate(`/tenant/members/${id}/role`, 'PUT', { role }))}
        onTransferOwnership={(id) =>
          run(mutate(`/tenant/members/${id}/transfer-ownership`, 'POST'))
        }
        onResendInvitation={(id) => run(mutate(`/tenant/invitations/${id}/resend`, 'POST'))}
        onRevokeInvitation={(id) => run(mutate(`/tenant/invitations/${id}`, 'DELETE'))}
      />
      {inviting && (
        <form
          className="rounded-xl border border-line bg-surface p-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              mutate('/tenant/invitations', 'POST', {
                email: inviteEmail,
                role: inviteRole,
              }).then(() => {
                setInviting(false);
                setInviteEmail('');
              }),
            );
          }}
        >
          <h2 className="font-semibold">Invite member</h2>
          <div className="mt-3 flex flex-wrap gap-3">
            <label className="min-w-56 flex-1 text-sm">
              Email
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2"
              />
            </label>
            <label className="text-sm">
              Role
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as 'admin' | 'member')}
                className="mt-1 block rounded-lg border border-line-strong px-3 py-2"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="submit" className="rounded-lg bg-strong px-4 py-2 text-on-strong">
              Send invitation
            </button>
            <button
              type="button"
              className="rounded-lg border border-line px-4 py-2"
              onClick={() => setInviting(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
