// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { installDialogMethods } from '../../test/dialog';

let dialogMethods: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialogMethods = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialogMethods.restore();
});

const session = vi.hoisted(() => {
  const state = { key: 'session-a', token: 'token-a' };
  return { state, getCredentials: async () => ({ kind: 'bearer' as const, token: state.token }) };
});

vi.mock('../../auth', () => ({
  useSession: () => ({
    sessionKey: session.state.key,
    getCredentials: session.getCredentials,
  }),
}));

import { MembersPage, MembersPanel } from '../MembersPanel';

test.each(['missing_owner', 'inactive_owners'] as const)(
  'loads the %s warning through the members page',
  async (state) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (input: RequestInfo | URL) =>
          new Response(
            JSON.stringify(
              String(input).endsWith('/me')
                ? { user: { id: 'member' }, tenant: { role: 'member' } }
                : {
                    members: [],
                    ownership: {
                      state,
                      activeOwnerCount: 0,
                      inactiveOwnerCount: state === 'inactive_owners' ? 1 : 0,
                    },
                  },
            ),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(
        state === 'missing_owner' ? /This workspace has no owner/ : /their accounts are inactive/,
      ),
    ).toBeDefined();
  },
);

test.each(['missing_owner', 'inactive_owners'] as const)(
  'shows server ownership state %s even to ordinary members',
  (state) => {
    render(
      <MembersPanel
        viewer={{ userId: 'member', role: 'member' }}
        members={[]}
        ownership={{
          state,
          activeOwnerCount: 0,
          inactiveOwnerCount: state === 'inactive_owners' ? 1 : 0,
        }}
        onInvite={vi.fn()}
        onRemove={vi.fn()}
        onRoleChange={vi.fn()}
        onTransferOwnership={vi.fn()}
        onResendInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain(
      state === 'missing_owner' ? 'This workspace has no owner.' : 'their accounts are inactive.',
    );
    expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
  },
);

test('does not offer ownership transfer to disabled accounts', () => {
  render(
    <MembersPanel
      viewer={{ userId: 'owner', role: 'owner' }}
      members={[
        {
          userId: 'member',
          email: 'disabled@example.test',
          role: 'member',
          status: 'active',
          userStatus: 'disabled',
        },
      ]}
      ownership={{ state: 'owned', activeOwnerCount: 1, inactiveOwnerCount: 0 }}
      onInvite={vi.fn()}
      onRemove={vi.fn()}
      onRoleChange={vi.fn()}
      onTransferOwnership={vi.fn()}
      onResendInvitation={vi.fn()}
      onRevokeInvitation={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: /Transfer ownership/i })).toBeNull();
  expect(screen.getByText('active · account disabled')).toBeDefined();
});

const MEMBERS = [
  { userId: 'owner-1', email: 'owner@example.test', role: 'owner' as const, status: 'active' },
  { userId: 'member-1', email: 'member@example.test', role: 'member' as const, status: 'active' },
];

afterEach(() => {
  cleanup();
  session.state.key = 'session-a';
  session.state.token = 'token-a';
  vi.unstubAllGlobals();
});

function renderPanel(
  viewerRole: 'owner' | 'admin' | 'member',
  members: Array<{
    userId: string;
    email: string;
    role: 'owner' | 'admin' | 'member';
    status: string;
  }> = MEMBERS,
  invitations: Array<{
    id: string;
    email: string;
    role: 'admin' | 'member';
    status: string;
  }> = [
    {
      id: 'invite-1',
      email: 'pending@example.test',
      role: 'member' as const,
      status: 'pending',
    },
  ],
  viewerUserId = 'owner-1',
) {
  const actions = {
    onInvite: vi.fn(),
    onRemove: vi.fn(),
    onRoleChange: vi.fn(),
    onTransferOwnership: vi.fn(),
    onResendInvitation: vi.fn(),
    onRevokeInvitation: vi.fn(),
  };
  render(
    <MembersPanel
      viewer={{ userId: viewerUserId, role: viewerRole }}
      members={members}
      invitations={invitations}
      {...actions}
    />,
  );
  return actions;
}

describe('MembersPanel', () => {
  test.each([
    {
      label: 'owner managing an admin',
      viewerRole: 'owner' as const,
      targetRole: 'admin' as const,
      targetStatus: 'active',
      self: false,
      changeRole: 'enabled',
      remove: 'enabled',
      transfer: 'enabled',
    },
    {
      label: 'owner managing a member',
      viewerRole: 'owner' as const,
      targetRole: 'member' as const,
      targetStatus: 'active',
      self: false,
      changeRole: 'enabled',
      remove: 'enabled',
      transfer: 'enabled',
    },
    {
      label: 'owner managing another owner',
      viewerRole: 'owner' as const,
      targetRole: 'owner' as const,
      targetStatus: 'active',
      self: false,
      changeRole: 'enabled',
      remove: 'enabled',
      transfer: 'absent',
    },
    {
      label: 'last owner managing themself',
      viewerRole: 'owner' as const,
      targetRole: 'owner' as const,
      targetStatus: 'active',
      self: true,
      changeRole: 'disabled',
      remove: 'disabled',
      transfer: 'absent',
    },
    {
      label: 'admin managing a member',
      viewerRole: 'admin' as const,
      targetRole: 'member' as const,
      targetStatus: 'active',
      self: false,
      changeRole: 'absent',
      remove: 'enabled',
      transfer: 'absent',
    },
    {
      label: 'admin viewing an admin',
      viewerRole: 'admin' as const,
      targetRole: 'admin' as const,
      targetStatus: 'active',
      self: false,
      changeRole: 'absent',
      remove: 'absent',
      transfer: 'absent',
    },
    {
      label: 'admin viewing an owner',
      viewerRole: 'admin' as const,
      targetRole: 'owner' as const,
      targetStatus: 'active',
      self: false,
      changeRole: 'absent',
      remove: 'absent',
      transfer: 'absent',
    },
    {
      label: 'member viewing another member',
      viewerRole: 'member' as const,
      targetRole: 'member' as const,
      targetStatus: 'active',
      self: false,
      changeRole: 'absent',
      remove: 'absent',
      transfer: 'absent',
    },
    {
      label: 'owner viewing an inactive member',
      viewerRole: 'owner' as const,
      targetRole: 'member' as const,
      targetStatus: 'removed',
      self: false,
      changeRole: 'absent',
      remove: 'absent',
      transfer: 'absent',
    },
  ])('enforces the complete action matrix for $label', (expected) => {
    const viewer = {
      userId: 'viewer-1',
      email: 'viewer@example.test',
      role: expected.viewerRole,
      status: 'active',
    };
    const target = {
      userId: expected.self ? viewer.userId : 'target-1',
      email: 'target@example.test',
      role: expected.targetRole,
      status: expected.targetStatus,
    };
    renderPanel(
      expected.viewerRole,
      expected.self ? [target] : [viewer, target],
      [],
      viewer.userId,
    );
    const row = screen.getByRole('row', { name: /target@example\.test/i });
    for (const [name, state] of [
      ['change role', expected.changeRole],
      ['remove', expected.remove],
      ['transfer ownership', expected.transfer],
    ] as const) {
      const action = within(row).queryByRole('button', { name: new RegExp(name, 'i') });
      expect(action !== null).toBe(state !== 'absent');
      if (action && state !== 'absent')
        expect((action as HTMLButtonElement).disabled).toBe(state === 'disabled');
    }
  });

  test('keeps the member view read-only', () => {
    renderPanel('member');
    expect(screen.getByText('member@example.test')).toBeDefined();
    expect(screen.queryByRole('button', { name: /invite member/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /transfer ownership/i })).toBeNull();
    expect(screen.queryByText('pending@example.test')).toBeNull();
  });

  test('lets admins invite and remove without exposing ownership transfer', () => {
    renderPanel('admin');
    expect(screen.getByRole('button', { name: /invite member/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /remove member@example\.test/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /transfer ownership/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /change role/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove owner@example\.test/i })).toBeNull();
  });

  test('shows pending invitation actions without presenting historical rows as pending', () => {
    renderPanel('owner', MEMBERS, [
      {
        id: 'invite-pending',
        email: 'pending@example.test',
        role: 'member',
        status: 'pending',
      },
      {
        id: 'invite-revoked',
        email: 'revoked@example.test',
        role: 'member',
        status: 'revoked',
      },
    ]);

    expect(screen.getByText('pending@example.test')).toBeDefined();
    expect(screen.queryByText('revoked@example.test')).toBeNull();
    expect(screen.getByRole('button', { name: /resend.*pending@example\.test/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /revoke.*pending@example\.test/i })).toBeDefined();
  });

  test('does not offer removal for a non-active directory row', () => {
    renderPanel('owner', [
      ...MEMBERS,
      {
        userId: 'removed-1',
        email: 'removed@example.test',
        role: 'member',
        status: 'removed',
      },
    ]);

    const row = screen.getByRole('row', { name: /removed@example\.test/i });
    expect(within(row).queryAllByRole('button')).toHaveLength(0);
  });

  test('explains immediate access loss and preserves attribution before removal', () => {
    const actions = renderPanel('owner');
    fireEvent.click(screen.getByRole('button', { name: /remove member@example\.test/i }));

    const dialog = screen.getByRole('dialog', { name: /remove member@example\.test/i });
    expect(dialog.textContent).toMatch(/lose access immediately/i);
    expect(dialog.textContent).toMatch(/messages and approvals remain attributed/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(actions.onRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /remove member@example\.test/i }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /^remove member$/i }),
    );
    expect(actions.onRemove).toHaveBeenCalledWith('member-1');
  });

  test('ignores member data that arrives after the authenticated identity changes', async () => {
    const pending = new Map<string, (response: Response) => void>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('authorization');
        const path = new URL(String(input)).pathname;
        if (authorization === 'Bearer token-a') {
          return new Promise<Response>((resolve) => pending.set(path, resolve));
        }
        return path === '/me'
          ? Response.json({ user: { id: 'user-b' }, tenant: { role: 'member' } })
          : Response.json({
              members: [
                {
                  userId: 'user-b',
                  email: 'person-b@example.test',
                  role: 'member',
                  status: 'active',
                },
              ],
            });
      }),
    );
    const view = render(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );
    await vi.waitFor(() => expect(pending.size).toBe(2));

    session.state.key = 'session-b';
    session.state.token = 'token-b';
    view.rerender(
      <MemoryRouter>
        <MembersPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('person-b@example.test')).toBeDefined();

    pending.get('/me')?.(Response.json({ user: { id: 'user-a' }, tenant: { role: 'owner' } }));
    pending.get('/tenant/members')?.(
      Response.json({
        members: [
          {
            userId: 'user-a',
            email: 'person-a@example.test',
            role: 'owner',
            status: 'active',
          },
        ],
      }),
    );
    await Promise.resolve();
    expect(screen.queryByText('person-a@example.test')).toBeNull();
  });

  test('allows owner transfer but explains why the last owner cannot be removed or demoted', () => {
    renderPanel('owner');
    const ownerRow = screen.getByRole('row', { name: /owner@example\.test/i });
    expect(
      (within(ownerRow).getByRole('button', { name: /remove/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(ownerRow).getByText(/last owner/i)).toBeDefined();
    expect(
      (
        within(ownerRow).getByRole('button', {
          name: /change role for owner@example\.test/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: /transfer ownership to member@example\.test/i }),
    ).toBeDefined();
  });
});
