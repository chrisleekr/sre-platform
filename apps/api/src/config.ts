import { adminUrl, appUrl, masterKey } from '@sre/db';
import { localLoginCredentials, type LocalLoginCredentials } from './local-auth';
import { localDevelopmentLoginOrigin } from './local-development-auth';

export interface ApiConfig {
  port: number;
  /** Local identity, absent unless an explicit development login gate is armed. */
  localLogin?: LocalLoginCredentials;
  localDevelopmentLoginOrigin?: string;
  adminUrl: string;
  appUrl: string;
  masterKey: string;
  valkeyUrl: string;
  /** Browser origins allowed to call the API cross-origin (dashboard dev server). */
  corsOrigins: string[];
  /** Right-most forwarding hops trusted when deriving a public request's source address. */
  trustedProxyHops: number;
  /** Public dashboard base used in notifications and external incident links. */
  dashboardBaseUrl: string;
  publicSite: {
    supportUrl: string | null;
    termsUrl: string | null;
    termsVersion: string | null;
  };
}

function optionalPublicUrl(name: string, value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be an absolute HTTP or HTTPS URL`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error(`${name} must be an absolute HTTP or HTTPS URL`);
  }
  return url.toString();
}

function trustedProxyHops(value: string | undefined): number {
  const parsed = Number(value ?? '0');
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
    throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 10');
  }
  return parsed;
}

/** Validate and load configuration at boot; throws on misconfiguration. */
export function loadConfig(): ApiConfig {
  const termsUrl = optionalPublicUrl('TERMS_URL', process.env.TERMS_URL);
  const termsVersion = process.env.TERMS_VERSION?.trim() || null;
  if (Boolean(termsUrl) !== Boolean(termsVersion)) {
    throw new Error('TERMS_URL and TERMS_VERSION must be configured together');
  }
  return {
    port: Number(process.env.PORT ?? '3000'),
    localLogin: localLoginCredentials(process.env),
    localDevelopmentLoginOrigin: localDevelopmentLoginOrigin(process.env),
    adminUrl: adminUrl(),
    appUrl: appUrl(),
    masterKey: masterKey(),
    valkeyUrl: process.env.VALKEY_URL ?? 'redis://localhost:6379',
    // Comma-separated allowlist; defaults to the dashboard dev origin. A bearer-token API must not
    // use a wildcard origin.
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:45173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    trustedProxyHops: trustedProxyHops(process.env.TRUST_PROXY_HOPS),
    dashboardBaseUrl: optionalPublicUrl(
      'DASHBOARD_BASE_URL',
      process.env.DASHBOARD_BASE_URL ?? 'http://localhost:45173',
    )!,
    publicSite: {
      supportUrl: optionalPublicUrl('SUPPORT_URL', process.env.SUPPORT_URL),
      termsUrl,
      termsVersion,
    },
  };
}
