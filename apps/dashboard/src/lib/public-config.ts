export interface PublicIdentityProvider {
  providerId: string;
  displayName: string;
  issuer: string;
  browserClientId: string | null;
  authorizationEndpoint: string | null;
  scopes: string[];
  authorizationAudience?: string | null;
}

export interface PublicConfig {
  productName: string;
  productValueLine?: string;
  staffProvider: PublicIdentityProvider | null;
  signupProvider: PublicIdentityProvider | null;
  signInProviders?: PublicIdentityProvider[];
  registrationMode: 'open' | 'approval_required' | 'closed';
  supportUrl: string | null;
  termsUrl: string | null;
  privacyUrl?: string | null;
  termsVersion: string | null;
}

const successfulLoads = new Map<string, Promise<PublicConfig>>();

function provider(value: unknown): PublicIdentityProvider | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.providerId !== 'string' ||
    typeof row.displayName !== 'string' ||
    typeof row.issuer !== 'string' ||
    (row.browserClientId !== null && typeof row.browserClientId !== 'string') ||
    (row.authorizationEndpoint !== null && typeof row.authorizationEndpoint !== 'string') ||
    !Array.isArray(row.scopes) ||
    !row.scopes.every((scope) => typeof scope === 'string')
  ) {
    return undefined;
  }
  return {
    providerId: row.providerId,
    displayName: row.displayName,
    issuer: row.issuer,
    browserClientId: row.browserClientId,
    authorizationEndpoint: row.authorizationEndpoint,
    scopes: row.scopes,
    authorizationAudience:
      typeof row.authorizationAudience === 'string' ? row.authorizationAudience : null,
  };
}

function parsePublicConfig(value: unknown): PublicConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Public configuration response has an unexpected shape');
  }
  const row = value as Record<string, unknown>;
  const staffProvider = provider(row.staffProvider);
  const signupProvider = provider(row.signupProvider);
  const signInProviders =
    row.signInProviders === undefined
      ? [staffProvider, signupProvider].filter((item): item is PublicIdentityProvider =>
          Boolean(item),
        )
      : Array.isArray(row.signInProviders)
        ? row.signInProviders.map(provider)
        : [undefined];
  const supportUrl = row.supportUrl ?? null;
  const termsUrl = row.termsUrl ?? null;
  const termsVersion = row.termsVersion ?? null;
  const productValueLine =
    row.productValueLine ??
    'Built to work alongside you like a senior SRE: investigate problems, connect evidence across your systems, and help determine what to do next.';
  const privacyUrl = row.privacyUrl ?? null;
  if (
    typeof row.productName !== 'string' ||
    typeof productValueLine !== 'string' ||
    staffProvider === undefined ||
    signupProvider === undefined ||
    signInProviders.some((item) => !item) ||
    (row.registrationMode !== 'open' &&
      row.registrationMode !== 'approval_required' &&
      row.registrationMode !== 'closed') ||
    (supportUrl !== null && typeof supportUrl !== 'string') ||
    (termsUrl !== null && typeof termsUrl !== 'string') ||
    (privacyUrl !== null && typeof privacyUrl !== 'string') ||
    (termsVersion !== null && typeof termsVersion !== 'string')
  ) {
    throw new Error('Public configuration response has an unexpected shape');
  }
  return {
    productName: row.productName,
    productValueLine,
    staffProvider,
    signupProvider,
    signInProviders: signInProviders as PublicIdentityProvider[],
    registrationMode: row.registrationMode,
    supportUrl,
    termsUrl,
    privacyUrl,
    termsVersion,
  };
}

/**
 * Loads public sign-in configuration and memoizes a successful response by URL.
 *
 * @param url - Same-origin or absolute API URL for the public configuration endpoint.
 */
export function loadPublicConfig(url: string): Promise<PublicConfig> {
  const cached = successfulLoads.get(url);
  if (cached) return cached;

  const request = fetch(url)
    .then(async (response) => {
      if (!response.ok)
        throw new Error(`Public configuration request failed with ${response.status}`);
      return parsePublicConfig(await response.json());
    })
    .catch((error: unknown) => {
      successfulLoads.delete(url);
      throw error;
    });
  successfulLoads.set(url, request);
  return request;
}
