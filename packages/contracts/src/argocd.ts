/**
 * Return a safe URL validation message without echoing possible credentials.
 * This checks syntax only; connector requests still enforce DNS and SSRF restrictions.
 * @param value - Untrusted Argo CD server address from a form or API request.
 * @returns An actionable error, or null when the URL syntax is supported.
 */
export function argoCdUrlError(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'Argo CD server URL is required.';
  if (value.length > 2048) return 'Argo CD server URL must be at most 2048 characters.';
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return 'Enter a complete Argo CD URL, including http:// or https:// and the server hostname.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return 'Argo CD requires an HTTPS URL, or an HTTP URL for an internal service.';
  if (url.username || url.password || url.search || url.hash)
    return 'Enter the Argo CD server URL without credentials, query parameters, or a fragment. Add project tokens in Access & tokens.';
  return null;
}
