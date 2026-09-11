# Sign in

The application home and **Sign in** open the same entry page. Enter your work email and select
**Continue** to find your company sign-in. A matched company directory opens automatically. When
several installation sign-in methods match, the page says **Choose your company account to
continue**; select the one you use. You do not need to type a workspace address.

## Platform administrators

Enter your work email. The installation sign-in method opens automatically when it is the only
matching method. A platform administrator without workspace memberships goes directly to Platform
administration. Creating a workspace is not required for administrator access. The grant must already
exist through [deployment bootstrap](../operate/bootstrap.md); choosing a method does not grant it.

## If your email does not find a method

Open your team's invitation or ask a workspace owner to finish configuring company sign-in.
If you are setting up a new team, select **Create a workspace**. Existing browser-owned setup
requests offer **Continue setup**.

Email discovery finds a company sign-in route; it does not reveal whether a particular person has
an account. A connection failure shows a retryable error instead of a missing-workspace message.

## Choose or switch a workspace

After signing in, a single workspace already authorized by your session opens directly. If you
belong to several workspaces, choose one from your authenticated memberships. You can return to the
chooser through **Switch workspace** in the dashboard account menu.

A workspace may require its own workspace sign-in method. Selecting it opens that method and checks
access before entering the workspace. Accounts from different identity providers are not combined
just because they share an email address.

Workspace addresses remain useful for invitations, bookmarks and direct links. They are not a
credential or a value you need to remember for the normal sign-in flow.

## Join from an invitation

Open the notification sent by your workspace owner or admin, then sign in with the invited work
email. A pending invitation lasts seven days. The first successful sign-in accepts it and applies
the invited role.

After a work email domain is verified, a person from that company directory may also join as a
member without an invitation unless the workspace requires a provisioned account. An invitation is
still useful when the person must join as an admin or needs a direct notification. A revoked or
expired invitation cannot grant its selected role.

## Resume workspace setup

After successful founder authentication, the same browser tab remembers the setup's sign-in route
until that session's original expiry. After logout, enter the same work email and select **Continue**
to sign in again, even before DNS verification. This remembers no credential and grants no access:
the server requires the original directory account on every return. Another email cannot use this
shortcut. A completed directory setup or another company authentication replaces the saved route.

In a new tab, after expiry, or when browser storage is unavailable, open your workspace's direct
sign-in link and select **Resume workspace setup**. Domain verification is still required before
ordinary company-domain discovery and member access are enabled.

There is no separate resume wizard. A browser that still owns a valid setup request shows
**Continue setup** on the sign-in page. Sign in with the same company method and continue on the
normal `/get-started` journey. A direct workspace address can also show **Resume setup** when this
browser owns that request.

The setup page restores server-saved details and lets you use **Edit workspace** or **Edit sign-in**
before creation. A client secret is never restored into browser storage. The stored secret is kept
unless you tick **Replace stored client secret** and enter a new one.

Select **Start a different setup** only when you intend to abandon the browser's saved recovery
pointer and begin with another workspace name or address.

## What each state means

| What you see | Meaning and next action |
| --- | --- |
| Continue setup | This browser has a valid unfinished request. Continue with the same company account. |
| Waiting for approval | The request is saved. A platform administrator must approve it. You may close the page and return. |
| Setup is in progress | Creation is running and the page checks again automatically. |
| Setup failed | Read the reason, correct the workspace address when offered, then retry the same request. |
| Setup expired | The unfinished request cannot be reused. Start a new setup. |
| Domain verification pending | The creating account can sign in and publish the displayed DNS record. Other members must wait. |
| Workspace suspended | Access is blocked. Contact the support link shown; only a platform administrator can reactivate it. |
| Workspace scheduled for deletion | An owner can sign in during the grace period and cancel deletion. |
| Access removed | Reauthentication does not recreate access. Contact a workspace owner. |
| No sign-in method available | The workspace exists but has no safe active method. Contact a workspace owner. |

## Local development

Use the same **Work email** form. On an explicitly enabled local installation, the configured
development email signs in without a password. Other emails follow normal company sign-in.
There are no separate development controls. See [Local development](local-development.md#local-email-sign-in-recommended)
for the opt-in settings and loopback-only safeguards. This is not a recovery method for production.

## Session length and signing out

Browser sessions survive reloads. By default a session ends after a day without activity or a week
after company authentication, whichever comes first; your platform administrator can change these
limits in [platform settings](../operate/settings.md). **Log out** ends this browser session;
**Sign out everywhere** ends all of your current platform sessions.
