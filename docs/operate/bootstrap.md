# First-run bootstrap

A fresh deployment needs one installation sign-in method and at least one platform administrator.
The bootstrap task creates the first installation sign-in method (the staff provider) and the first
administrators. Neither may be written through the application database connection. Bootstrap
performs only those installation-wide writes, and it performs them through the administrative
database connection. Both connections are defined in
[Container image](container.md#the-two-database-connections).

Bootstrap does not create an organisation, tenant membership, or customer identity. Workspace
founding and membership assignment remain separate product operations.

Run bootstrap after migrations and before the application processes start.

## Configuration

Bootstrap reads `DATABASE_URL` plus two JSON environment variables. It accepts no command-line
arguments.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Administrative database connection, see [Container image](container.md#the-two-database-connections) |
| `BOOTSTRAP_STAFF_PROVIDER` | Public OIDC metadata for the first installation sign-in method |
| `BOOTSTRAP_PLATFORM_ADMINS` | Non-empty ordered list of administrators to grant or invite |
| `BOOTSTRAP_STAFF_CLIENT_SECRET` | Separate secret for either confidential authentication method, never included in provider JSON |
| `SECRETS_MASTER_KEY` | Existing 32-byte base64 encryption key, required when storing a client secret |

`BOOTSTRAP_STAFF_PROVIDER` accepts these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `displayName` | yes | Name shown for this sign-in method |
| `issuer` | yes | Exact HTTPS OIDC issuer, without credentials, query, or fragment |
| `browserClientId` | yes | OIDC application's client identifier, not an API audience |
| `clientAuthentication` | no | `client_secret_post` (POST body), `client_secret_basic` (HTTP Basic), or `none` for a public PKCE application; defaults to `none` |
| `audience` | no | Explicit API bearer-token audience, only when that separate integration is needed |
| `emailClaim` | no | Email claim name, default `email` |
| `jwksUri` | no | HTTPS JWKS endpoint, without credentials or fragment; a query is allowed |

Bootstrap reads the issuer's OIDC discovery document for every new provider so it can persist the
browser authorization and server token endpoints. An explicit `jwksUri` overrides only the
discovered key endpoint. Discovery follows the same transport rules as the API's runtime OIDC:
public addresses only, DNS-pinned HTTPS with TLS hostname verification, no redirects, and a 64 KiB
response limit. The one difference is the time limit: bootstrap allows 10 seconds per request where
the API allows five. The JSON `issuer` must exactly match the declaration, and `authorization_endpoint`,
`token_endpoint`, and `jwks_uri` must be HTTPS.

For the usual server-side web sign-in, set `clientAuthentication` to `client_secret_post` and supply
`BOOTSTRAP_STAFF_CLIENT_SECRET` through your deployment's secret mechanism. Use the same
`SECRETS_MASTER_KEY` as the API. The provider and encrypted client secret are saved together, so the
first administrator can sign in without an existing administration session. Missing secrets or an
invalid encryption key stop bootstrap before any writes. Do not place a client secret in provider
JSON, logs, or source control.

Match the registered authentication method: Okta Web applications default to `client_secret_basic`.
For Auth0, select POST in application credentials when using `client_secret_post`. Google and Entra
web registrations support a client secret in the POST body. Both confidential methods use the same
encrypted secret storage; neither exposes the secret to the browser.

An API audience is not required for browser sign-in. The browser receives an application-session
cookie, not the identity provider's tokens. Register the exact dashboard `/auth/callback` URL in the
identity provider. See [Authentication](auth.md) for session and deployment settings.

Each `BOOTSTRAP_PLATFORM_ADMINS` entry has either a `subject`, an `email`, or both:

- An entry with `subject` immediately creates the issuer-and-subject identity and grants it
  platform-operator permission. `email` is optional identity metadata.
- An entry with only `email` creates a pending platform-administrator invitation. The next sign-in
  through the installation sign-in method with the same issuer and trusted email accepts it atomically.
  A customer directory cannot consume that invitation, even when its issuer and email match.
  Use a subject entry when access
  must be immediate before that sign-in.

Values are trimmed. Unknown keys, empty strings, duplicate subjects, duplicate email-only
invitations, collisions between an email-only invitation and a subject entry, malformed JSON,
control characters, and empty administrator lists are rejected before database or discovery I/O.
Email-only invitations are stored in lowercase.

## Run from a checkout

The explicit `jwksUri` in this example overrides the discovered key endpoint:

```
BOOTSTRAP_STAFF_PROVIDER='{
  "displayName":"Staff sign-in",
  "issuer":"https://idp.example.invalid/",
  "jwksUri":"https://idp.example.invalid/jwks",
  "browserClientId":"sre-platform-browser",
  "clientAuthentication":"client_secret_post",
  "emailClaim":"email"
}' \
BOOTSTRAP_PLATFORM_ADMINS='[
  {"subject":"subject-from-id-token","email":"operator@example.invalid"},
  {"email":"invited@example.invalid"}
]' \
bun run db:bootstrap
```

Before running this example, inject `BOOTSTRAP_STAFF_CLIENT_SECRET` and `SECRETS_MASTER_KEY` into the
environment through your secret mechanism. The example intentionally contains no secret values.

In a deployment, run the published image once with `ROLE=bootstrap`. See
[Container image](container.md) for the role table.

## Output and recovery

On success, bootstrap prints one provider line followed by one line for each administrator in input
order. Each line says whether the record was created or already present. The report includes provider
issuer, subject or email, and generated identifiers. It never includes browser client IDs, audiences,
claim names, or JWKS endpoints.

Every write is idempotent. Concurrent runs serialize on one database advisory lock. A failed run may
have completed earlier entries, so run the same declaration again to finish it.

For an existing active installation sign-in method, bootstrap preserves every stored field,
including its issuer. The only exception is a safe one-time discovery backfill when an older row is
missing its authorization or token endpoint. Changing the JSON does not otherwise edit or replace
that provider. Provider changes require an explicit administrative operation rather than an
implicit deployment-side update. Bootstrap refuses ambiguous installations with more than one
active installation sign-in method.

Rerunning a confidential declaration preserves the existing encrypted secret; bootstrap is not a
secret-rotation command. The issuer, client identifier and authentication method must match before
bootstrap may fill a missing secret. If they differ, use platform administration to change the
registration. Existing explicit API audiences remain unchanged.

## Existing installations

Upgrading does not alter existing tenants, memberships, or customer identities. Run the new bootstrap
declaration to register the installation sign-in method and platform administrators. An existing
installation sign-in method and existing administrator grants or invitations are reported as already
present. Provider rows remain unchanged except for the one-time browser-endpoint backfill described
above. Disabled or deleted administrator identities are reported as unusable by subject; bootstrap
continues with the remaining declarations and does not restore those accounts or grant them access.

The previous tenant-creating bootstrap contract is not accepted. Deployment configuration must supply
`BOOTSTRAP_STAFF_PROVIDER` and `BOOTSTRAP_PLATFORM_ADMINS` before running the new image.

## Ordering

Run migrations first because bootstrap writes to the identity control-plane tables created by those
migrations. Start the API and workers afterwards.
