# Create your workspace

To connect company sign-in, you need access to register an application in your identity service.
After workspace creation, a domain administrator can publish the DNS TXT record that enables team
access. These can be different people.

## 1. Choose a name and address

Open the application home, for example `https://sre.example.com/`. **Sign in** opens the same page;
these guides call it the entry page. Under **Setting up for your team?**, select **Create a
workspace**. Enter the workspace name; the suggested address follows the name until you edit the
address yourself. The preview shows the complete permanent address, for example
`https://sre.example.com/example-operations`. Save this address for returning sign-in.

Select **Continue to company sign-in**. The same page advances to company sign-in. Initial details
are saved in this browser tab. Use **Back to workspace details** to edit them. If workspace creation
requires platform administrator approval, the page explains that before you configure company
sign-in.

## 2. Connect your sign-in method

Choose your identity service and follow its visible setup instructions. Register a **web application** with
authorization-code sign-in. Copy the **Callback URL** exactly into the allowed redirect URI setting.
The callback belongs to the dashboard, not the API. Different schemes, ports or trailing paths do
not match.

| Field | Where to find it | Example |
| --- | --- | --- |
| Directory URL | OpenID Connect issuer in your service's configuration | `https://company.example.com` |
| Client ID | The application's identifier after registration | The value labelled Client ID or Application ID |
| Client secret | Credentials for that web application | Paste the secret value, not its identifier |
| Work email domain | Everything after `@` in your work email | `example.com` |

Use the provider-specific example beside **Directory URL**. Some issuers include an authorization
server or tenant path; do not remove it. **Other** also supports a public client without a secret
when your directory explicitly supports that application type with PKCE.

Select the client authentication method that matches your application registration; the
per-provider defaults are listed under [Directory prerequisites](../operate/auth.md#directory-prerequisites).
All confidential methods keep credentials on the server; HTTP Basic here does not mean entering your
personal password.

Select **Check directory** to verify discovery, then **Continue to sign in**. SRE Platform stores the
client secret encrypted on the server and never restores it into the browser. Before the first save,
reloading restores only non-secret fields, so you must paste the secret again. After the setup is
saved, the browser that created it can edit it: the form then shows **Replace stored client secret**
unchecked and saving keeps the stored secret. Tick it to enter a new one. Changing the directory
URL, client ID, or client authentication method always requires a new secret. Browser storage never
receives directory access, refresh or identity tokens.

## 3. Sign in through the new method

Sign in with an account from the declared work domain. If your directory does not confirm that the
email is verified, enter the eight-digit code delivered to that mailbox. The code expires after ten
minutes and allows five incorrect attempts. Reloading does not discard the pending email check.
If email delivery is unavailable, ask the platform administrator to configure SMTP, then restart
sign-in. A verified mailbox does not replace DNS ownership proof.

## 4. Confirm and create

After company sign-in, `/get-started` shows the saved workspace name, complete address, directory,
work domain and owner email. These details come from the server, including when you reload or resume
setup. Use **Edit workspace** or **Edit sign-in** on this page to correct them. Accept the displayed
terms if required, then select **Set up workspace**.

An open registration policy starts provisioning immediately. An approval-required policy waits for
the platform administrator. You can leave and return while approval or provisioning is pending.
The same `/get-started` page reports the current state, last check and any actionable failure.
**Retry** resumes the existing request; it does not create another workspace.

## Finish setup from the workspace home

After creation, SRE Platform opens the workspace home. Its setup checklist links to **Verify your
domain**. Copy the TXT host and value into your DNS service. If that service appends the domain
automatically, enter only `_sre-platform` as the host. Keep its default TTL and allow time for DNS
propagation.

Select **Check now**. A missing record stays pending and shows guidance; it is not treated as success.
After the exact record is visible, the page shows **Domain verified** and **Open workspace**. Until
then, only the recorded founder can access the workspace through that directory. Other people can
sign in once the domain is verified. Observability and Slack connections remain on the workspace
home checklist and do not block workspace creation.

## Returning, retrying and signing out

Use the entry page for returning sign-in. Your workspace link also remains available for bookmarks.
While DNS verification is pending,
select **Resume workspace setup** and use the same directory account that created the workspace.
This path does not grant access to other accounts. Provisioned workspaces remain resumable while
you finish DNS verification, even after the initial registration deadline.

After DNS verification, the work-email lookup can also select your directory. An expired,
unfinished registration requires a new request. A suspended, removed or deleting workspace shows
its access state instead of sending you into an empty workspace.

For every member sign-in and recovery path, including how long a browser session lasts and how to
sign out, see [Sign in](sign-in.md#session-length-and-signing-out). A sign-in error preserves the
selected workspace and directory and shows **Continue setup** on the sign-in page, even after a
reload.

## If sign-in fails

| What you see | What to check |
| --- | --- |
| Directory unreachable | Exact issuer, public HTTPS accessibility, and discovery support |
| Application secret missing or rejected | Secret value, expiry, and web application configuration |
| Callback refused by the identity service | Exact dashboard callback URL including its scheme and port |
| Work email missing or mismatched | Email claim enabled and an account from the declared domain |
| Email verification cannot be delivered | Platform SMTP configuration and recipient delivery |
| Setup expired | Start again; expired credentials are not reusable |
| DNS record not visible | TXT host and value, automatic domain suffixes, and propagation time |

Provider registration references: [Auth0 applications](https://auth0.com/docs/get-started/applications),
[Okta web sign-in](https://developer.okta.com/docs/guides/sign-into-web-app-redirect/main/),
[Microsoft identity authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
and [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).
