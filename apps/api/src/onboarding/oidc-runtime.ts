import { fetchGuardedJson } from './oidc-relay';
import { discoverOidcProvider } from './oidc-discovery';

/** Discovers validated external directory metadata. */
export function makeOidcRuntime() {
  return {
    discover: (issuer: string) => discoverOidcProvider(issuer, { fetchJson: fetchGuardedJson }),
  };
}
