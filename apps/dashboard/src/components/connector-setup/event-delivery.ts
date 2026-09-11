export const PUBLIC_API_CONFIGURATION_ERROR =
  'Public webhook delivery is unavailable. Ask your platform administrator to configure a public HTTPS API URL in the deployment, or use Smee for local development.';

/** Use deployment configuration, never a per-connector override, for public delivery. */
export function publicApiOrigin(apiBaseUrl: string): string {
  try {
    const url = new URL(apiBaseUrl || window.location.origin);
    return url.protocol === 'https:' &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.origin
      : '';
  } catch {
    return '';
  }
}

/** A missing server-issued path must never become a plausible-looking placeholder webhook. */
export function publicWebhookUrl(origin: string, path: string): string {
  if (!origin.trim() || !path.startsWith('/webhooks/') || path.startsWith('//')) return '';
  const validOrigin = publicApiOrigin(origin.trim());
  return validOrigin ? new URL(path, validOrigin).toString() : '';
}
