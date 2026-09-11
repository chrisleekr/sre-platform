import { useSession } from '../auth';
import type { PublicIdentityProvider } from '../lib/public-config';
import { primaryButton } from './shared';

/** Starts a configured identity service without asking users for a workspace address. */
export function CompanySignInOptions({
  providers,
  returnTo,
}: {
  providers: PublicIdentityProvider[];
  returnTo: string;
}) {
  const session = useSession();
  const available = providers.filter(
    (provider) => provider.authorizationEndpoint && provider.browserClientId,
  );
  if (!available.length) return null;
  return (
    <section aria-label="Sign-in options" className="mt-5 grid gap-3">
      {available.map((provider) => (
        <button
          key={provider.providerId}
          type="button"
          disabled={session.isStarting}
          className={`${primaryButton} w-full`}
          onClick={() =>
            session.signInWith(
              {
                providerId: provider.providerId,
                issuer: provider.issuer,
                authorizationEndpoint: provider.authorizationEndpoint!,
                clientId: provider.browserClientId!,
                scopes: provider.scopes,
                authorizationAudience: provider.authorizationAudience,
              },
              returnTo,
            )
          }
        >
          Continue with {provider.displayName}
        </button>
      ))}
      <p className="text-sm text-ink-muted">
        After signing in, choose a workspace if you belong to more than one.
      </p>
    </section>
  );
}
