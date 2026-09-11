# Members

Open **Workspace settings**, then **Members**, to see who can use the workspace. Every member can
read the active member list. Owners and admins also see pending invitations and can invite people.
Only owners can change roles or transfer ownership.

## Roles

| Role | Can do |
| --- | --- |
| Owner | Everything an admin can do, plus change roles, transfer ownership, remove admins and other owners, and manage workspace sign-in methods, work email domains, and workspace deletion |
| Admin | Rename the workspace, invite people as member or admin, resend or revoke invitations, and remove members |
| Member | Everything that is not listed above, including investigating and responding to incidents and reading the active member list |

The final active owner cannot be removed or changed to another role. This prevents a workspace from
losing every person who can recover its access settings.

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
