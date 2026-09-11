export type SignInPresetId = 'auth0' | 'okta' | 'entra' | 'google-workspace' | 'other';

export interface SignInPreset {
  id: SignInPresetId;
  name: string;
  issuerExample: string;
  registration: string;
  instructions: string[];
  documentation: string;
}

export const SIGN_IN_PRESETS: readonly SignInPreset[] = [
  {
    id: 'auth0',
    name: 'Auth0',
    issuerExample: 'https://your-organisation.auth0.com/',
    registration: 'Create a Regular Web Application.',
    instructions: [
      'Open Applications → Create Application → Regular Web Applications.',
      'Add the callback URL below to Allowed Callback URLs and save. Copy the Domain, Client ID, and Client Secret from this same application.',
      'In application credentials, use POST as the Token Endpoint Authentication Method.',
      'Enable the connection your team uses. You do not need to create an API or configure an API audience.',
    ],
    documentation: 'https://auth0.com/docs/get-started/applications/application-settings',
  },
  {
    id: 'okta',
    name: 'Okta',
    issuerExample: 'https://your-organisation.okta.com',
    registration: 'Create an OIDC Web Application.',
    instructions: [
      'Open Applications → Create App Integration → OIDC → Web Application.',
      'Enable Authorization Code and add the callback URL below as a Sign-in redirect URI.',
      'Assign your account or team to the application. Copy its Client ID and Client Secret.',
      'Keep the default client_secret_basic token authentication. The client secret stays on the server.',
    ],
    documentation: 'https://developer.okta.com/docs/guides/sign-into-web-app-redirect/main/',
  },
  {
    id: 'entra',
    name: 'Microsoft Entra ID',
    issuerExample: 'https://login.microsoftonline.com/YOUR-TENANT-ID/v2.0',
    registration: 'Register a single-tenant Web application.',
    instructions: [
      'Open App registrations → New registration and choose your organisation only.',
      'Add the callback URL below with the Web platform, not Single-page application.',
      'Copy Application (client) ID and Directory (tenant) ID. Create a client secret and copy its Value, not its Secret ID.',
      'Allow OpenID Connect profile and email. Your team may need email verification before entering the workspace.',
    ],
    documentation:
      'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app',
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    issuerExample: 'https://accounts.google.com',
    registration: 'Create an OAuth Web application client.',
    instructions: [
      'Configure the Google Auth Platform audience for your organisation.',
      'Create an OAuth client ID with application type Web application and add the callback URL below.',
      'Copy the Client ID and Client Secret. Request only basic identity and email access.',
    ],
    documentation: 'https://developers.google.com/identity/openid-connect/openid-connect',
  },
  {
    id: 'other',
    name: 'Other OpenID Connect service',
    issuerExample: 'https://login.example.com',
    registration: 'Register an OpenID Connect Web application.',
    instructions: [
      'Enable Authorization Code and PKCE (S256), and add the callback URL below.',
      'Copy the issuer URL, client ID, and client secret. Select Public client only if your service explicitly supports a client without a secret.',
      'Match the token authentication method to your registration: client secret in the POST body, HTTP Basic, or no secret for a public PKCE client.',
      'Allow openid, email and profile. A verified work email and DNS ownership are checked separately.',
    ],
    documentation: 'https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth',
  },
];
