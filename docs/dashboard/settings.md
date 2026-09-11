# Workspace settings

**Workspace settings** opens from **Settings** in the sidebar's Configure group and has three tabs.
Owners and admins also reach the Members tab through **Manage members** in the account menu. Every
member can read them. Owners and admins can rename the workspace. Only owners can change authentication or delete
the workspace. For the step-by-step tasks, see [Workspace settings](../use/workspace-settings.md)
and [Members](../use/members.md).

## Workspace

Shows the workspace name, which can be changed, and the workspace address, which is read-only
because it is part of bookmarked sign-in pages and durable links. The **Delete workspace** action
sits here; deletion is scheduled with a grace period rather than immediate, as described in
[Delete a workspace](../use/workspace-settings.md#delete-a-workspace).

## Authentication

Lists every workspace sign-in method in the order people see it, each with its status, and the
**Work email domains** section with each domain's verification state, DNS TXT record, and
**Verify DNS now** button. Below them sit **Require the workspace directory** and, for eligible
methods, **Provider-initiated logout** and SCIM controls. **Add sign-in method** opens the same
guided setup as workspace creation. The procedure, the safety rules the API enforces, and the
directory requirement are in [Workspace settings](../use/workspace-settings.md#add-a-workspace-sign-in-method).

## Members

Lists active members with their roles, and for owners and admins the pending invitations with
**Resend** and **Revoke**. Owners also see **Change role**, **Transfer ownership**, and removal for
every other member. The role rules are in [Members](../use/members.md#roles).

Platform-wide model, cost, registration, and notification settings are not here; they are in
[Platform administration](../operate/administration.md).
