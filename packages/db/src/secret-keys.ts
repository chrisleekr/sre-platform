// Single source of truth for SecretStore key namespaces. Two intentionally-distinct
// families: connector:<instance-id> is the OUTBOUND API credential one Data Source uses to call the
// tenant's API; <surface>:bot_token / <surface>:signing_secret / <surface>:webhook_secret are
// surface-adapter secrets. Build keys here, never string-interpolate at call sites, so the
// namespaces cannot drift.
/**
 * Provides connector credential key.
 *
 * @param connectorId - Connector instance targeted by the operation.
 */
export const connectorCredentialKey = (connectorId: string): string => `connector:${connectorId}`;
/** Separate credential for confirmed GitLab issue writes.
 * @param connectorId - Tenant-owned data source.
 */
export const connectorIssueCredentialKey = (connectorId: string): string =>
  `connector:${connectorId}:issues`;
/**
 * Separate credential namespace for administrator-authorized GitLab hook management.
 * @param connectorId - Connector whose own hooks may be managed.
 */
export const gitLabManagementCredentialKey = (connectorId: string): string =>
  `gitlab-management:${connectorId}`;
/**
 * Inbound event authentication and relay material, separate from the connector's read credential.
 *
 * @param connectorId - Connector instance targeted by the operation.
 */
export const connectorEventCredentialKey = (connectorId: string): string =>
  `connector:${connectorId}:events`;
/**
 * Provides surface bot token key.
 *
 * @param surface - Surface adapter targeted by the operation.
 */
export const surfaceBotTokenKey = (surface: string): string => `${surface}:bot_token`;
/**
 * Provides surface app token key.
 *
 * @param surface - Surface adapter targeted by the operation.
 */
export const surfaceAppTokenKey = (surface: string): string => `${surface}:app_token`;
/**
 * Provides surface signing secret key.
 *
 * @param surface - Surface adapter targeted by the operation.
 */
export const surfaceSigningSecretKey = (surface: string): string => `${surface}:signing_secret`;
/**
 * Provides surface webhook secret key.
 *
 * @param surface - Surface adapter targeted by the operation.
 */
export const surfaceWebhookSecretKey = (surface: string): string => `${surface}:webhook_secret`;
