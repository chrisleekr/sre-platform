import { describe, expect, test } from 'vitest';
import { apiVersionBasePath, resourcePath, splitApiVersion, validateSegment } from '../path';

// The injection-defense module is the sole guard between engine-controlled input and the API-server
// path, so each segment charset and the path builders are exercised directly here.

describe('validateSegment', () => {
  test('group: accepts a DNS-1123 group and the empty core group, rejects a bad group', () => {
    expect(validateSegment('group', 'apps')).toBe('apps');
    expect(validateSegment('group', '')).toBe('');
    expect(() => validateSegment('group', 'Apps!')).toThrow(/invalid group/);
  });

  test('version: accepts v1/v1beta1, rejects a traversal-shaped version', () => {
    expect(validateSegment('version', 'v1')).toBe('v1');
    expect(validateSegment('version', 'v1beta1')).toBe('v1beta1');
    expect(() => validateSegment('version', 'v1..')).toThrow(/invalid version/);
  });

  test('resource: accepts a lowercase plural, rejects uppercase and slash', () => {
    expect(validateSegment('resource', 'pods')).toBe('pods');
    expect(() => validateSegment('resource', 'Pods')).toThrow(/invalid resource/);
    expect(() => validateSegment('resource', 'pods/log')).toThrow(/invalid resource/);
  });

  test('name: accepts a valid name, rejects a traversal and a >253-char name', () => {
    expect(validateSegment('name', 'checkout-abc')).toBe('checkout-abc');
    expect(() => validateSegment('name', '../x')).toThrow(/invalid name/);
    expect(() => validateSegment('name', 'a'.repeat(254))).toThrow(/invalid name/);
  });

  test('namespace: rejects an invalid namespace', () => {
    expect(validateSegment('namespace', 'checkout')).toBe('checkout');
    expect(() => validateSegment('namespace', 'Check Out')).toThrow(/invalid namespace/);
  });
});

describe('splitApiVersion', () => {
  test('core group: "v1" → {group:"", version:"v1"}', () => {
    expect(splitApiVersion('v1')).toEqual({ group: '', version: 'v1' });
  });

  test('named group: "apps/v1" → {group:"apps", version:"v1"}', () => {
    expect(splitApiVersion('apps/v1')).toEqual({ group: 'apps', version: 'v1' });
  });

  test('a 3-segment apiVersion throws', () => {
    expect(() => splitApiVersion('a/b/c')).toThrow(/invalid apiVersion/);
  });
});

describe('apiVersionBasePath', () => {
  test('core group maps to /api/v1', () => {
    expect(apiVersionBasePath('v1')).toBe('/api/v1');
  });

  test('named group maps to /apis/<group>/<version>', () => {
    expect(apiVersionBasePath('apps/v1')).toBe('/apis/apps/v1');
  });
});

describe('resourcePath', () => {
  test('builds a namespaced path with a name', () => {
    expect(resourcePath('v1', 'secrets', { namespace: 'checkout', name: 'db' })).toBe(
      '/api/v1/namespaces/checkout/secrets/db',
    );
  });

  test('builds a cluster-scoped path when namespace is omitted', () => {
    expect(resourcePath('v1', 'nodes', { name: 'ip-10-0-0-5' })).toBe('/api/v1/nodes/ip-10-0-0-5');
  });

  test('rejects an injecting name before returning a path', () => {
    expect(() => resourcePath('v1', 'pods', { name: '../secrets/x' })).toThrow();
  });
});
