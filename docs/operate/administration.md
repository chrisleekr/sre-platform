# Platform administration

The platform control room is at `/admin`. It is available only to an allowlisted platform
administrator who signed in through an installation sign-in method; the first such method is the
staff provider registered at bootstrap. A workspace sign-in method cannot grant platform-wide
access. The explicitly armed development password account is the only non-production exception.

![The platform administration workspace](../assets/screenshots/admin-workspaces-light.png#only-light)
![The platform administration workspace](../assets/screenshots/admin-workspaces-dark.png#only-dark)

## What platform administrators can do

Every row is gated by the platform administrator grant. Workspace owners and admins cannot perform
any of them.

| Area | Actions | What affected people see |
| --- | --- | --- |
| Registrations | Approve, reject with a reason, retry failed provisioning | A durable in-app notification and optional email copy |
| Workspaces | Suspend, reactivate, cancel deletion, clear **Require the workspace directory**, add a workspace binding, open a one-hour support session | Suspended members lose HTTP and live-session access immediately; every owner is notified when the directory rule is cleared and when a support session starts or ends |
| Users | Disable, enable, sign out everywhere, remove a membership, grant or revoke platform administrator access, delete | Disabled and signed-out users receive the matching notification |
| Identity providers | Edit an installation sign-in method's metadata and claims, manage its SCIM credential and settings, view its provisioned accounts | The verifier cache is invalidated; the next sign-in uses the saved values |
| Platform settings | Change registration policy, public copy, model, budgets, retention, and optional SMTP | Public configuration and new work use the saved value without a restart |
| Audit trail | Read every recorded administrator action | Nothing; reading is not a mutation |

The same grant also gates signal policy control on a workspace's **Signals** page, outside the
control room: changing the policy, running an evaluation, switching enforcement on or back to shadow
mode, and editing tag-link rules. Reviewing and promoting individual signals is open to workspace
members.

A workspace binding maps one exact claim value from an installation sign-in method to one workspace.
On the **Workspaces** screen it is entered as a binding provider and a claim value.

Every successful mutation appends exactly one row to the **Audit trail**. The row identifies the
administrator, action, target, time, supplied reason, and non-secret structured detail. Audit rows
are append-only to the application role. Account deletion tombstones the identity rather than
removing it, so earlier incident-message attribution and administrator actions remain intelligible.

## Bounded support sessions

**Open one-hour support session** lets a platform administrator investigate through the ordinary
workspace UI. A reason of at least ten characters is required. The database fixes the expiry at one
hour from creation; the session cannot be extended.

The dashboard keeps a warning banner visible for the whole session. It names the workspace, shows a
second-by-second countdown, and provides **End now**. The browser includes the opaque session id on
authenticated API calls, but the server remains authoritative: it checks the administrator, target
workspace, expiry, and ended state on every request. Messages retain the administrator's user id,
not a workspace owner's identity.

Every active workspace owner is notified when the support session starts and ends. An expired or
ended session is rejected; the dashboard clears the local hint and returns to ordinary routing.

## Safety rules

- The final platform administrator cannot revoke or delete themselves.
- The final active workspace owner cannot be removed.
- Only identities from an installation sign-in method can be granted platform administrator access.
- Provider credentials and SMTP passwords are never returned by administrator read routes.
- Workspace suspension and account changes publish live-session revocation after the durable gate
  commits. The next request also checks the database gate, so access stays denied if live delivery is
  temporarily unavailable.
