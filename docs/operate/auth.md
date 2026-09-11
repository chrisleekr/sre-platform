# Authentication

People sign in through a registered OpenID Connect directory. The server verifies their identity
and issues a separate, opaque application-session cookie. Directory tokens never become browser
API credentials. For a walkthrough, see [Create your workspace](../get-started/create-your-workspace.md).

## Directory prerequisites

Register a web application supporting authorization code with PKCE S256. Allow the exact dashboard
callback, ending in `/auth/callback`. Enable `openid`, `email`, and `profile`. Standard web
applications use a client secret, encrypted and write-only in the platform. The Other preset can
also use a public client when the directory supports PKCE without a secret.

Client authentication must match the registered application: `client_secret_basic` sends encoded
credentials in the Authorization header, `client_secret_post` sends them in the form body, and
`none` is reserved for an explicitly supported public PKCE client. Okta defaults to Basic; the Auth0
guide selects POST. Google and Entra web registrations support POST. Sign-in uses the directory's
normal prompting policy rather than forcing a provider-specific reauthentication parameter.

The directory must issue a signed ID token for that client ID. Its access token may be opaque:
SRE Platform neither uses it as an API credential nor retains it. No custom API audience, token
gateway or refresh-token permission is required for browser sign-in.

The API creates single-use state, nonce and PKCE values and persists them server-side. The callback
must come from the browser that started the attempt. The API verifies signature, issuer, client
audience, authorized party when present, expiry, issued-at time and nonce. Provider selection is by
exact stored provider identifier, not by whichever row shares an issuer. Separate clients may use
the same company-directory issuer.

Discovery, signing keys and code exchange use public-DNS validation, IP-pinned HTTPS with hostname
verification, no redirects, a five-second timeout and a 64 KiB response limit. Provider error bodies
and secrets are not reflected to the browser.

## Email and domain proof

The standard email claim is trusted only when `email_verified` is true. Otherwise the platform
requires a one-time mailbox code through configured SMTP before creating a user session or accepting
the email. Configure email delivery in **Platform settings** before enabling directories that do not
supply verified-email claims. Missing or failed SMTP delivery prevents sign-in and gives a safe,
actionable error. Codes never appear in the platform notification inbox.

The identity remains the exact issuer and configured subject claim, never the email address.
The original OIDC subject and optional provider session identifier are retained with the session.
Changing email does not relink an identity.

Mailbox verification does not establish company ownership. A new workspace separately requires
the generated DNS TXT record for its declared domain. Its founder can complete setup while DNS is
pending; ordinary members cannot use an unverified directory.

## Browser sessions and deployment

A browser receives a random credential in a host-only HttpOnly, SameSite=Lax cookie. Production
cookies are Secure and use the `__Host-` prefix. Only a hash is stored in the database. Browser
storage contains non-secret setup and routing metadata, not upstream tokens or client secrets.

The dashboard and API must be on the same site, for example `app.example.com` and `api.example.com`.
Use HTTPS for both in production. Cross-origin API calls include credentials, and `CORS_ORIGINS`
must list the exact dashboard origin. Configure both values on the API:

```dotenv
DASHBOARD_BASE_URL=https://app.example.com
CORS_ORIGINS=https://app.example.com
```

`DASHBOARD_BASE_URL` sets the trusted browser origin and the `/auth/callback` URL sent to the
directory. It is independent of `CORS_ORIGINS`; setting CORS alone is insufficient. Production
startup rejects an HTTP dashboard URL, including the local-development default.

Mutating cookie requests, including anonymous sign-in starts
and completion, require the configured Origin and the application's CSRF header. Reverse-proxy
headers do not switch secure cookies off. HTTP is supported only by explicit development mode.

Session lifetimes are platform settings: `SESSION_IDLE_SECONDS` bounds idle time,
`SESSION_ABSOLUTE_SECONDS` bounds the time since directory authentication, and
`MAX_TOKEN_LIFETIME_SEC` separately caps legacy API and local password bearer tokens. Their ranges
and defaults are listed in [Platform settings](settings.md). A platform administrator can change
them without restarting. Idle activity never changes the original authentication timestamp or
absolute expiry. Increasing a timeout cannot resurrect an expired or revoked session. Absolute
timeout changes apply when a new session is created.

**Log out** revokes the current browser session, including outstanding incident-stream tickets.
**Sign out everywhere** persists the user's revocation cutoff and asks all API replicas to close
their live streams. Every HTTP request and stream recheck consults durable account, session,
provider, workspace and membership gates, so a missed live notification cannot restore access.
A token issued before a revocation cutoff cannot become a fresh application session.

## Ending sessions from the directory

OpenID Connect back-channel logout lets an enabled directory end SRE Platform browser sessions
without waiting for their idle or absolute expiry. Enable **Provider-initiated logout** on an
installation sign-in method in **Platform administration → Identity providers**, or on a workspace
sign-in method in **Workspace settings → Authentication**. Copy the URL shown there into that same OIDC
client's back-channel logout setting. The URL contains the provider ID and must be registered exactly.

Before enabling it, verify that the provider's discovery document advertises
`backchannel_logout_supported: true`, or that its current documentation explicitly supports OpenID
Connect Back-Channel Logout for this client. If session-specific logout is required, also verify
`backchannel_logout_session_supported: true`. Front-channel logout metadata and a browser logout URL
describe a different protocol and are not sufficient.

The endpoint is public because the signed `logout_token` is its credential. It accepts only a form
encoded POST whose signature, issuer and audience match that exact active, opted-in provider. The
audience is the browser client ID. The token must have a recent numeric `iat`, a numeric `exp`, a
unique token ID, the standard back-channel logout event with a JSON-object value, no nonce, and a
subject or provider session ID. The specification recommends an empty event object but permits
provider extensions. A SHA-256 hash of each token ID is stored in a durable provider-scoped receipt;
the raw token ID is never stored. That receipt and the session effects commit in one transaction, so
a replay is rejected without risking a split claim and revocation. Expired receipts are removed in
bounded batches during later deliveries. Tokens signed with RS256 are accepted. SRE Platform rejects
every other signing algorithm and any multi-audience token because it does not yet persist a
client-specific signing algorithm or trusted extra audiences.

The optional **Require logout+jwt token type** setting additionally rejects tokens whose protected
header does not contain exactly `typ: logout+jwt`. Leave it off for providers that implement the
protocol but omit this recommended media type.

A token with a provider session ID is session-scoped. If it also contains a subject, both values must
match the same provider, client and browser session. It does not advance the user-wide cutoff. Only
when the session ID is absent does a subject logout map every historical session for that exact
provider, client and original OIDC subject, advance each mapped user's durable sign-out cutoff, revoke
current matching sessions, and close live streams. Already-ended and unknown sessions still return
success. Disabling the capability makes the endpoint return not found before it reads a request body.

The callback must be publicly reachable by the directory over HTTPS; a browser-only or private URL
cannot receive server-to-server delivery. A replica-safe ingress budget accepts 600 attempts per
trusted source address per minute before provider lookup or token verification. Exhaustion returns
`429` with `Retry-After: 60`; retry behavior is provider-specific, so verify it during integration.
Limiter failure returns `503` without processing the token. SRE Platform does not implement
front-channel logout, and it does not retain directory access or refresh tokens to revoke them.

Provider availability is not interchangeable. As checked in September 2026,
[Auth0 documents this feature for Enterprise-plan tenants](https://auth0.com/docs/authenticate/login/logout/back-channel-logout/configure-back-channel-logout).
The current [Okta OIDC SLO guide](https://developer.okta.com/docs/guides/single-logout/openidconnect/main/)
and [Microsoft identity-platform OIDC guide](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)
describe front-channel flows; those guides are not evidence that a tenant can deliver this callback.
Use the provider's discovery fields or explicit back-channel documentation as the authority.

## Provisioning people with SCIM

SCIM 2.0 lets a workspace directory create, update, deactivate and delete user records before those
people sign in. Configure it on a workspace sign-in method in **Workspace settings →
Authentication**, or on an installation sign-in method in **Platform administration →
Identity providers**. The settings screen supplies the exact provider-scoped base URL and a bearer
token. Copy the token immediately: only its SHA-256 hash is retained, and the plaintext is never
shown again.

Set the directory's SCIM base URL to the copied HTTPS URL, use the copied bearer token, and enable
User provisioning. The service implements the SCIM 2.0 User resource, equality filters for
`userName` and `externalId`, pagination, PUT, PATCH and DELETE. Groups, bulk operations, sorting and
password provisioning are not advertised. Each URL and token belongs to one identity provider;
neither can read or mutate another provider's accounts.

Choose the identity mapping deliberately:

| OIDC sign-in identity | SCIM field | When to choose it |
| --- | --- | --- |
| Configured subject claim | `externalId` | The directory can provision the same stable employee or directory identifier into both protocols |
| Configured subject claim | `userName` | The OIDC subject claim is intentionally the same stable value used as SCIM `userName` |

SRE Platform never assumes that SCIM `externalId` equals the OIDC `sub`. At first sign-in, an exact
match using the selected fields creates a durable link. If that match is absent, a verified email may
link only one active, previously unlinked SCIM account. Unverified email, multiple matches and
already-linked accounts are never guessed. Once linked, email changes cannot move the identity to a
different account.

Enable **Require a provisioned account** only after the directory has completed its first sync and
the expected accounts appear in the settings screen. With it off, unmatched people continue through
the existing just-in-time sign-in policy. With it on, unmatched people are denied. A linked account
that is inactive or deleted is always denied, even if the requirement is later switched off.

Deactivation and deletion advance the linked user's durable revocation cutoff in the same database
transaction as the directory change. Existing browser sessions, bearer requests and live incident
streams are therefore rejected by their normal authoritative checks. A live revoke message closes
streams quickly, but losing that best-effort message cannot restore access. DELETE leaves an internal
tombstone so ownership history is preserved, while the deleted SCIM resource returns `404` and is
excluded from searches as required by
[RFC 7644 section 3.6](https://www.rfc-editor.org/rfc/rfc7644#section-3.6). Reprovisioning the person
creates a new SCIM resource ID; the old ID is never reused.

Rotate the token immediately if it may have been exposed. Rotation invalidates the previous token,
and disabling SCIM removes the stored credential. Tokens expire, so schedule directory-side rotation
before the date shown in settings. A disabled or expired credential returns the same authentication
failure as an unknown token. Use HTTPS in deployed environments and restrict the token to the target
directory application. The endpoint applies a bounded, fail-closed request limit before provider
lookup and rejects oversized payloads.

Before enforcing provisioning, verify all of these in a test account:

1. `GET <base-url>/ServiceProviderConfig` succeeds with the bearer token.
2. Creating a User makes it appear under **Provisioned accounts**.
3. A sign-in whose configured subject matches the selected SCIM field succeeds.
4. Setting `active` to `false` ends that person's current access and prevents a fresh sign-in.
5. Reactivating the same current resource permits a newly authenticated session.
6. Rotating the token makes the previous token fail immediately.

## Workspace access and existing API credentials

A workspace binding selects a workspace before membership is evaluated:

- A workspace sign-in method belongs to exactly one workspace, so its binding carries no claim
  value (a null-claim binding) and the ID token needs no workspace claim.
- An installation sign-in method requires its explicitly configured binding claim in the ID token,
  and the claim value must match a workspace binding exactly. If that claim is missing or unbound,
  the person stays signed in but unaffiliated. Configure the claim in the directory's ID token; the
  platform does not guess from email or another membership.
- Removed memberships and suspended or deleting workspaces remain denied. Reauthentication does
  not recreate a removed membership or elevate its role.
- Platform-administrator access remains separate from workspace ownership.

Existing installation and local API bearer credentials retain signature, audience, lifetime and
revocation verification. Session-only directory rows have no API audience and cannot accept an ID
token as an API bearer token. A shared issuer is not eligible for ambiguous issuer-only bearer
selection; browser sessions retain exact provider/client selection.

Workspace sign-in method setup persists a provisional registration before sign-in, then attaches only its
verified founder. Submission respects open, approval-required or closed registration policy.
Provisioning writes the workspace, owner, binding and independent DNS challenge. Durable queue
work resumes after a restart. Reloading and returning sign-in resume server state rather than
replaying browser credentials.

## The platform-operator permission

Platform-administrator access is independent of workspace membership. This lets an unaffiliated
administrator operate installation-wide settings without gaining access to customer data.

The grant gates every action in the platform administration area, listed in full under
[What platform administrators can do](administration.md#what-platform-administrators-can-do):
registrations, workspace suspension and bindings, user accounts and administrator grants,
installation sign-in methods, platform settings, and support sessions. Outside that area it also
gates signal policy control on a workspace's **Signals** page: changing the policy, running an
evaluation, switching enforcement on or back to shadow mode, and editing tag-link rules.

The administrator list is global, not per workspace. Bootstrap may grant a known subject immediately or
create an email invitation. On the next sign-in with the matching issuer and trusted email claim, the
API accepts that invitation and grants administrator access in one owner transaction. The ordinary
application role cannot write that allowlist directly. Development-only local login is the
only path that provisions itself automatically.

## Signing in with a password, for local development only

For everyday local work, prefer the explicitly enabled [local email sign-in](../get-started/local-development.md#local-email-sign-in-recommended).
`ALLOW_LOCAL_DEVELOPMENT_LOGIN=true` requires exactly `NODE_ENV=development`, a loopback dashboard origin,
and no trusted proxy hops. It binds the API to `127.0.0.1`. The passwordless endpoint checks the
actual socket peer, URL host, exact browser Origin and custom request header; it rejects forwarded
requests. It uses the same short-lived bearer tokens, local identity and provisioning path described
below. The endpoint requires the configured development email; unmatched emails continue to company
sign-in. The browser renews an existing local session, but never starts one on page load or after
sign-out. Both local flags default to off.

The legacy password exchange at `POST /auth/local/login` remains available to development automation
when explicitly enabled. The dashboard uses the single work-email form, not a separate password page.

**The API refuses to start** if this is switched on while `NODE_ENV` is `production` or unset. An
unknown environment is treated as production. Note that the check is an exact string match, so an
environment named `prod` or `staging` is not covered by it.

| Variable | Meaning |
| --- | --- |
| `ALLOW_LOCAL_PASSWORD_LOGIN` | Enabled only by the exact string `true`. Anything else leaves it off. |
| `LOCAL_LOGIN_EMAIL` | The single local account's address. |
| `LOCAL_LOGIN_PASSWORD` | The shared password. At least 12 characters. |

It also refuses to start if it is switched on with a missing email, a missing password, or a password
under 12 characters, and it logs a loud warning at startup whenever it is armed.

How it behaves when enabled:

- A wrong password and an unknown email give the same generic failure. The response never says which
  half was wrong, and the password comparison takes the same time either way.
- The session lasts up to 15 minutes and is shortened when `MAX_TOKEN_LIFETIME_SEC` is lower. Its
  signing key is generated in memory at startup and never written anywhere, so no private key sits
  in your environment and every restart invalidates outstanding sessions.
- A token is only ever checked against the key set belonging to the issuer it claims. A token signed
  by the local key while claiming to be from an installation sign-in method is rejected, and the
  reverse too.
- The local provider and its workspace binding with no claim value are persisted, so workspace
  selection uses the same binding path as every other sign-in method. Its signing keys remain
  injected process memory only.
- The first successful local sign-in creates an active `local-dev` founding and runs the same atomic
  workspace provisioner used by OIDC onboarding. It also grants the local account operator permission.
  This is the only automatic operator grant, and it is unreachable unless a local login mode is on.

When both local modes are switched off their routes do not exist, and any token claiming the local
issuer is rejected. The dashboard asks the API which sign-in paths exist rather than assuming, so the
login screen can never offer one the API does not serve.
