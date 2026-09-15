# Workspace settings

Open **Settings** in the sidebar's Configure group. The area is titled **Workspace settings** and
has three tabs: **Workspace**, **Authentication**, and **Members**. Every member can read the
settings. Owners and admins can rename the workspace and change connections and the Slack
connection. Only owners can change sign-in methods, work email domains, or schedule deletion. The
screen-by-screen reference is [Dashboard: Workspace settings](../dashboard/settings.md).

## Rename the workspace

The name is the label shown throughout the dashboard. An owner or admin can change it on the
**Workspace** tab without changing any links.

The workspace address is the permanent short name used in sign-in and bookmarked links. It cannot
be changed after creation. Share the complete address shown on the page with teammates who need a
direct sign-in route.

## Add a workspace sign-in method

The **Authentication** tab lists every workspace sign-in method in the order people see it on the
workspace sign-in page. A new method uses the same guided setup as workspace creation and stays
unavailable until its work email domain is proved with DNS.

1. Select **Add sign-in method**. Choose your sign-in service and register an OpenID Connect web
   application with authorization-code sign-in.
2. Copy the displayed dashboard callback URL exactly into the application's allowed redirect URLs.
3. Enter the directory URL and select **Check directory** to check its published sign-in endpoints.
4. Enter the client ID and the client secret for the selected client authentication method. Match
   that method to your application registration; the per-provider defaults are listed under
   [Directory prerequisites](../operate/auth.md#directory-prerequisites). **Other** also supports
   public clients with PKCE and no secret when your directory explicitly supports them.
5. Enter your work email domain and select **Save sign-in method**. Copy the displayed DNS TXT
   record and publish it, then follow [Verify a work email domain](#verify-a-work-email-domain).

A successful directory check does not prove that sign-in works. The directory must return a signed
ID token for the registered client and a work email from the declared domain. When the directory
does not verify that email, the platform requires a mailbox verification code. Client secrets stay
encrypted on the server; the dashboard uses a server-owned session. You do not need a custom API
audience, API scopes, or a token gateway.

## Verify a work email domain

After publishing the DNS TXT record, choose **Verify DNS now** beside the pending domain. The button
checks immediately and shows the result and last check time. A pending result means the matching
record is not confirmed yet; check its host and value, allow time for DNS propagation, and try
again. Each domain also has its own background verification check. Verification proves domain
ownership, not that the entire sign-in flow works.

Workspace owners can run this check, and so can a platform administrator during an active support
session. Support access does not permit adding or deleting sign-in methods or domains. Other users
see who can verify instead of an unexplained missing action. A domain that belongs to an
installation sign-in method must be verified through Platform administration.

## Safety rules the API enforces

- The last active sign-in method cannot be disabled or deleted.
- You cannot disable the method you are currently using; sign in as an owner through a replacement
  first.
- A method cannot be deleted while active members still depend on its identity.
- An installation sign-in method can only be changed by a platform administrator.
- The last verified domain of an active method cannot be deleted.
- **Require the workspace directory** cannot be enabled from an installation sign-in method,
  because doing so would lock out the caller.

Disabling a method or enabling **Require the workspace directory** closes the workspace's live
connections. Every later request and live-stream check is evaluated against the current method
policy, so a missed live notification cannot keep access open.

## Require the workspace directory

**Require the workspace directory** blocks personal accounts and accounts from an installation
sign-in method from entering the workspace, even when the account would otherwise have access.
Enable it only while signed in through a working workspace sign-in method. A platform administrator
has a separately audited break-glass action to clear this rule, and every owner is notified when it
is used.

If SCIM provisioning is configured, **Require a provisioned account** is a separate control: it
requires a current active directory record as well as successful company sign-in.

**Provider-initiated logout** and SCIM controls appear only for eligible workspace sign-in methods.
Follow the endpoint, capability, credential, and verification guidance shown beside those controls,
and see [Authentication](../operate/auth.md) for the protocol details.

## Members

The **Members** tab controls invitations, roles, removal, and ownership transfer. See
[Members](members.md) for the role and safety rules.

## Delete a workspace

Only an owner can schedule deletion. The confirmation requires the exact workspace address.
Scheduling deletion blocks access immediately and starts a 14-day grace period. An owner or platform
administrator can cancel during that period.

After the grace period, workspace incidents, messages, connector credentials, and settings are
permanently removed together. Platform administration audit records remain. Schedule deletion
only after exporting anything the organisation must retain.
