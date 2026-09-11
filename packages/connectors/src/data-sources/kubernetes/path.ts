// URL-path safety for the Kubernetes connector's generic tools. Every segment the engine controls
// (apiVersion, resource, namespace, name) is interpolated into the API-server path, so a value like
// `../secrets/x` or `pods/../..` could otherwise traverse to an unintended resource. Each segment is
// validated against the strict k8s charset for its kind and rejected before any fetch is built.

// DNS-1123 subdomain/label: what k8s allows for names, namespaces, and API group names.
const DNS_1123 = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
// API version: v1, v1beta1, v2alpha1, etc.
const VERSION = /^v[0-9]+((alpha|beta)[0-9]+)?$/;
// A resource is a lowercase plural with no slash (subresources are handled by dedicated tools).
const RESOURCE = /^[a-z][a-z0-9]*$/;

type SegmentKind = 'group' | 'version' | 'resource' | 'namespace' | 'name';

/**
 * Validate one path segment and return it unchanged, or throw. `group` may be empty (the core
 * group); every other kind must be non-empty. `namespace`/`name` also enforce the 253-char cap.
 */
export function validateSegment(kind: SegmentKind, value: string): string {
  switch (kind) {
    case 'group':
      if (value === '') return value;
      if (!DNS_1123.test(value)) throw new Error(`kubernetes connector: invalid group segment`);
      return value;
    case 'version':
      if (!VERSION.test(value)) throw new Error(`kubernetes connector: invalid version segment`);
      return value;
    case 'resource':
      if (!RESOURCE.test(value)) throw new Error(`kubernetes connector: invalid resource segment`);
      return value;
    case 'namespace':
    case 'name':
      if (value.length > 253 || !DNS_1123.test(value))
        throw new Error(`kubernetes connector: invalid ${kind} segment`);
      return value;
  }
}

/** Split an apiVersion into its group and version. "v1" → core group ""; "apps/v1" → {apps, v1}. */
export function splitApiVersion(apiVersion: string): { group: string; version: string } {
  const parts = apiVersion.split('/');
  if (parts.length === 1) return { group: '', version: parts[0]! };
  if (parts.length === 2) return { group: parts[0]!, version: parts[1]! };
  throw new Error('kubernetes connector: invalid apiVersion');
}

/** The base path for an apiVersion: core group → /api/v1, named group → /apis/<group>/<version>. */
export function apiVersionBasePath(apiVersion: string): string {
  const { group, version } = splitApiVersion(apiVersion);
  validateSegment('group', group);
  validateSegment('version', version);
  return group === '' ? `/api/${version}` : `/apis/${group}/${version}`;
}

/**
 * Build a validated resource path. Every interpolated segment is charset-checked, so this throws on
 * any injection attempt before the caller ever reaches out to the API server. Returns the path only;
 * query strings are appended by the caller via URLSearchParams.
 */
export function resourcePath(
  apiVersion: string,
  resource: string,
  opts: { namespace?: string; name?: string } = {},
): string {
  let p = apiVersionBasePath(apiVersion);
  validateSegment('resource', resource);
  if (opts.namespace) p += `/namespaces/${validateSegment('namespace', opts.namespace)}`;
  p += `/${resource}`;
  if (opts.name) p += `/${validateSegment('name', opts.name)}`;
  return p;
}
