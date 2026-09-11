export const PRODUCT_ROOT = '/w';

/** Builds one canonical authenticated product route. */
export function productPath(path = ''): string {
  const suffix = path.replace(/^\/+|\/+$/g, '');
  return suffix ? `${PRODUCT_ROOT}/${suffix}` : PRODUCT_ROOT;
}

/** Builds the canonical dashboard link for an incident identifier. */
export function incidentPath(incidentId: string): string {
  return productPath(`incidents/${encodeURIComponent(incidentId)}`);
}

/** Builds the canonical dashboard link for an incident's postmortem page. */
export function postmortemPath(incidentId: string): string {
  return productPath(`incidents/${encodeURIComponent(incidentId)}/postmortem`);
}
