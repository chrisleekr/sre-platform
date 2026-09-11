/** Browser configuration. Container deployments override build-time Vite values at startup. */
export interface AppConfig {
  apiBaseUrl: string;
  publicConfigUrl: string;
  wsBaseUrl: string;
}

declare global {
  interface Window {
    __SRE_PLATFORM_CONFIG__?: Partial<AppConfig>;
  }
}

export function deriveWsBase(apiBaseUrl: string, pageOrigin?: string): string {
  const base =
    apiBaseUrl || pageOrigin || (typeof window === 'undefined' ? '' : window.location.origin);
  return base.replace(/^http/, 'ws').replace(/\/$/, '');
}

/**
 * Derives the public configuration endpoint from the API base URL.
 *
 * @param apiBaseUrl - Same-origin empty value or configured split-origin API base URL.
 */
export function derivePublicConfigUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/public-config`;
}

/**
 * Resolves one externally registered API callback against same-origin or split-origin configuration.
 *
 * @param path - Absolute API path beginning with a slash.
 * @param apiBaseUrl - Same-origin empty value or configured API base URL.
 * @param pageOrigin - Browser origin used only for same-origin deployments.
 */
export function absoluteApiUrl(path: string, apiBaseUrl: string, pageOrigin: string): string {
  const configuredPath = `${apiBaseUrl.replace(/\/+$/, '')}${path}`;
  return new URL(configuredPath, `${pageOrigin.replace(/\/+$/, '')}/`).toString();
}

type ViteConfig = Record<string, string | boolean | undefined>;

function configured(
  runtime: Partial<AppConfig>,
  key: keyof AppConfig,
  fallback: string | boolean | undefined,
): string {
  const value = runtime[key];
  return typeof value === 'string' ? value : typeof fallback === 'string' ? fallback : '';
}

export function resolveAppConfig(
  runtime: Partial<AppConfig> = {},
  vite: ViteConfig = import.meta.env,
): AppConfig {
  const apiBaseUrl = configured(runtime, 'apiBaseUrl', vite.VITE_API_BASE_URL);
  const wsBaseUrl = configured(runtime, 'wsBaseUrl', vite.VITE_WS_BASE_URL);
  return {
    apiBaseUrl,
    publicConfigUrl: derivePublicConfigUrl(apiBaseUrl),
    wsBaseUrl: wsBaseUrl || deriveWsBase(apiBaseUrl),
  };
}

const runtimeConfig = typeof window === 'undefined' ? {} : (window.__SRE_PLATFORM_CONFIG__ ?? {});
export const config = resolveAppConfig(runtimeConfig);
