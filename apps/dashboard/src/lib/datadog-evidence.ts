/** Build a provider-confined log search link without trusting a URL stored in evidence.
 * @param attributes - Allowlisted provider site, source query and bounded observation window.
 */
export function datadogEvidenceUrl(attributes?: Record<string, string>): string | null {
  const site = attributes?.datadogSite,
    query = attributes?.logQuery;
  if (
    !site ||
    !query ||
    query.length > 1024 ||
    !/^(?:(?:(?:ap1|ap2|us3|us5|uk1)\.)?datadoghq\.com|datadoghq\.eu|(?:us2\.)?ddog-gov\.com)$/.test(
      site,
    )
  )
    return null;
  const from = Date.parse(attributes.windowStart ?? ''),
    to = Date.parse(attributes.windowEnd ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 600_000)
    return null;
  const url = new URL(`https://app.${site}/logs`);
  url.searchParams.set('query', query);
  url.searchParams.set('from_ts', String(from));
  url.searchParams.set('to_ts', String(to));
  url.searchParams.set('live', 'false');
  return url.href;
}
