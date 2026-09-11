import { listPublicProviders, type Db, type PublicProvider, type RegistrationMode } from '@sre/db';
import type { PlatformSettings } from '@sre/platform-settings';
import { Hono } from 'hono';
import type { Logger } from './logger';

type BrowserProvider = Pick<
  PublicProvider,
  'displayName' | 'issuer' | 'browserClientId' | 'authorizationEndpoint'
> & { providerId: string; scopes: string[]; authorizationAudience?: string | null };

interface PublicConfigDeps {
  db: Db;
  settings: Partial<Pick<PlatformSettings, 'get'>>;
  registrationMode?: () => Promise<RegistrationMode>;
  publicSite?: {
    supportUrl: string | null;
    termsUrl: string | null;
    termsVersion: string | null;
  };
  log?: Logger;
}

/** Builds the secret-free configuration consumed before browser authentication. */
export function publicConfigRoutes(deps: PublicConfigDeps): Hono {
  const app = new Hono();

  app.get('/public-config', async (c) => {
    try {
      const [
        providers,
        registrationMode,
        productName,
        productValueLine,
        supportUrl,
        termsUrl,
        privacyUrl,
      ] = await Promise.all([
        listPublicProviders(deps.db),
        deps.registrationMode?.() ?? Promise.resolve('approval_required' as const),
        deps.settings.get?.('PRODUCT_NAME') ?? Promise.resolve('SRE Platform'),
        deps.settings.get?.('PRODUCT_VALUE_LINE') ??
          Promise.resolve(
            'Built to work alongside you like a senior SRE: investigate problems, connect evidence across your systems, and help determine what to do next.',
          ),
        deps.settings.get?.('SUPPORT_URL') ?? Promise.resolve(null),
        deps.settings.get?.('TERMS_URL') ?? Promise.resolve(null),
        deps.settings.get?.('PRIVACY_URL') ?? Promise.resolve(null),
      ]);
      const project = (provider: PublicProvider): BrowserProvider => ({
        providerId: provider.id,
        displayName: provider.displayName,
        issuer: provider.issuer,
        browserClientId: provider.browserClientId,
        authorizationEndpoint: provider.authorizationEndpoint,
        scopes: [
          ...new Set(['openid', 'email', 'profile', ...(provider.authorizationScopes ?? [])]),
        ],
        authorizationAudience: provider.authorizationAudience,
      });
      const staff = providers.find(
        (provider) => provider.scope === 'installation' && !provider.supportsSignup,
      );
      const signup = providers.find(
        (provider) => provider.scope === 'installation' && provider.supportsSignup,
      );

      return c.json({
        productName,
        productValueLine,
        staffProvider: staff ? project(staff) : null,
        signupProvider: signup ? project(signup) : null,
        signInProviders: providers
          .filter((provider) => provider.scope === 'installation')
          .map(project),
        registrationMode,
        supportUrl: supportUrl ?? deps.publicSite?.supportUrl ?? null,
        termsUrl: termsUrl ?? deps.publicSite?.termsUrl ?? null,
        privacyUrl,
        termsVersion: deps.publicSite?.termsVersion ?? null,
      });
    } catch (error) {
      deps.log?.error('public configuration load failed', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return c.json({ error: 'public configuration unavailable' }, 503);
    }
  });

  return app;
}
