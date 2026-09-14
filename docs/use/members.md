# Members

Open **Workspace settings**, then **Members**, to see who can use the workspace. Every member can
read the active member list. Owners and admins also see pending invitations, can invite people, and
are the only roles that can change the workspace's connections, its Slack connection, or which
Slack channels it listens to. Only owners can change roles or transfer ownership.

## Roles

| Role | Can do |
| --- | --- |
| Owner | Everything an admin can do, plus change roles, transfer ownership, remove admins and other owners, and manage workspace sign-in methods, work email domains, and workspace deletion |
| Admin | Rename the workspace, invite people as member or admin, resend or revoke invitations, remove members, add, edit, verify, retest or remove connections, connect, recheck or disconnect Slack and choose which channels it listens to, define, retarget or delete service level objectives, and edit the service catalog and its dependencies |
| Member | Everything that is not listed above, including investigating and responding to incidents, reading the active member list, and reading connections, the Slack connection and its channel subscriptions, objectives and their budgets, and the service graph, with their status |

Removing, demoting or deleting an owner requires another owner with an active account and active
membership. Ownership cannot be transferred to an inactive account.

If **Members** reports missing ownership or inactive owner accounts, ask a platform administrator
to [recover ownership](../operate/administration.md#recover-workspace-ownership). Disabling an
account for security remains possible. Ownership status describes stored accounts and memberships,
not whether an external sign-in provider is reachable.

## Invite someone

1. Select **Invite member**.
2. Enter the person's work email.
3. Choose **Member** or **Admin**, then select **Send invitation**.

The invitation lasts seven days. **Resend** starts a new seven-day window. **Revoke** prevents the
invitation from applying its selected role. When the person signs in with that verified email, the
pending invitation is accepted automatically.

A verified company directory may admit new people as members without an invitation. Use an
invitation when you want to notify a specific person or grant the admin role. If authentication
requires a provisioned account, that directory account must also be active.

## Change access

An owner can use **Change role** to switch an active member between member and admin. To make another
person the owner, use **Transfer ownership**. The current owner becomes an admin after the transfer,
so the workspace always keeps an owner.

Owners can remove any other member, including admins. Admins can remove members only, not admins or
owners. Removal ends workspace access immediately, closes live incident views, and cannot be undone
by signing in again. Existing incident messages, decisions, and approvals keep their original
attribution.
