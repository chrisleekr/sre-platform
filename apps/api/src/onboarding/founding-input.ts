import { workspaceSlug } from './validation';
import { oidcRequestOptions } from './oidc-options';

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validDomain(domain: string): boolean {
  return domain.length <= 253 && domain.split('.').every((label) => DOMAIN_LABEL.test(label));
}

/** Validates workspace details shared by both creation paths.
 * @param value - Untrusted JSON request body.
 */
export function foundingInput(value: unknown): {
  slug: string;
  requestedName: string;
  declaredDomain?: string;
} | null {
  const input = value as Record<string, unknown> | null;
  const slug = workspaceSlug(input?.slug) ?? '';
  const requestedName = typeof input?.requestedName === 'string' ? input.requestedName.trim() : '';
  const domain =
    typeof input?.declaredDomain === 'string' ? input.declaredDomain.trim().toLowerCase() : '';
  if (!slug || requestedName.length < 1 || requestedName.length > 100) return null;
  if (domain && !validDomain(domain)) return null;
  return { slug, requestedName, ...(domain ? { declaredDomain: domain } : {}) };
}

/** Validates a directory-backed workspace request.
 * @param value - Untrusted JSON request body.
 */
export function oidcFoundingInput(value: unknown): {
  slug: string;
  requestedName: string;
  declaredDomain: string;
  issuer: string;
  clientId: string;
  clientAuthentication: 'none' | 'client_secret_post' | 'client_secret_basic';
  clientSecret?: string;
  apiAudience: string | null;
  subjectClaim: 'sub' | 'oid';
  authorizationScopes: string[];
  authorizationAudience?: string | null;
} | null {
  const common = foundingInput(value);
  const input = value as Record<string, unknown> | null;
  const issuer = typeof input?.issuer === 'string' ? input.issuer.trim() : '';
  const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : '';
  const apiAudience = typeof input?.apiAudience === 'string' ? input.apiAudience.trim() : '';
  const clientAuthentication = input?.clientAuthentication ?? 'none';
  const clientSecret = typeof input?.clientSecret === 'string' ? input.clientSecret : undefined;
  if (
    !['none', 'client_secret_post', 'client_secret_basic'].includes(String(clientAuthentication)) ||
    (clientAuthentication !== 'none' && (!clientSecret || clientSecret.length > 4_096))
  )
    return null;
  const subjectClaim = input?.subjectClaim === 'oid' ? 'oid' : 'sub';
  const requestOptions = oidcRequestOptions.safeParse(input);
  if (!requestOptions.success) return null;
  if (
    !common?.declaredDomain ||
    issuer.length < 1 ||
    issuer.length > 2_048 ||
    clientId.length < 1 ||
    clientId.length > 255 ||
    apiAudience.length > 2_048
  ) {
    return null;
  }
  return {
    ...common,
    declaredDomain: common.declaredDomain,
    issuer,
    clientId,
    apiAudience: apiAudience || null,
    clientAuthentication: clientAuthentication as
      'none' | 'client_secret_post' | 'client_secret_basic',
    ...(clientSecret ? { clientSecret } : {}),
    subjectClaim,
    ...requestOptions.data,
  };
}
