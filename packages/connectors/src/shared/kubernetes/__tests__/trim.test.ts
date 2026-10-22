import { describe, expect, test } from 'vitest';
import { trimObject } from '../trim';

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

describe('trimObject values pass through', () => {
  test('keeps Secret data, ConfigMap data and container env values unchanged', () => {
    const secret = { kind: 'Secret', data: { password: 'aGVsbG8=' }, stringData: { token: 't' } };
    const cm = { kind: 'ConfigMap', data: { 'db.url': 'postgres://u:p@h/db' } };
    const deploy = {
      kind: 'Deployment',
      spec: {
        template: {
          spec: {
            tolerations: [{ key: 'dedicated', operator: 'Exists' }],
            containers: [{ name: 'app', env: [{ name: 'DB_PASSWORD', value: 'super-secret' }] }],
          },
        },
      },
    };
    expect(trimObject(secret)).toEqual(secret);
    expect(trimObject(cm)).toEqual(cm);
    expect(trimObject(deploy)).toEqual(deploy);
  });
});

describe('trimObject metadata trimming', () => {
  test('drops metadata.managedFields wherever it appears', () => {
    const o = {
      kind: 'Pod',
      metadata: { name: 'p', managedFields: [{ manager: 'kubectl' }] },
      spec: { template: { metadata: { managedFields: [{ manager: 'x' }] } } },
    };
    const out = trimObject(o) as any;
    expect('managedFields' in out.metadata).toBe(false);
    expect(out.metadata.name).toBe('p');
    expect('managedFields' in out.spec.template.metadata).toBe(false);
    // Input is not mutated (pure).
    expect('managedFields' in o.metadata).toBe(true);
  });

  test('drops the last-applied-configuration annotation, keeps other annotations', () => {
    const o = {
      kind: 'Pod',
      metadata: {
        name: 'p',
        annotations: { [LAST_APPLIED]: '{"big":"blob"}', 'app.io/team': 'sre' },
      },
    };
    const out = trimObject(o) as any;
    expect(LAST_APPLIED in out.metadata.annotations).toBe(false);
    expect(out.metadata.annotations['app.io/team']).toBe('sre');
  });
});

describe('trimObject robustness', () => {
  test('never throws on non-object input', () => {
    expect(trimObject(null)).toBeNull();
    expect(trimObject('str')).toBe('str');
    expect(trimObject(42)).toBe(42);
  });

  test('an array recurses into each item', () => {
    expect(trimObject([{ metadata: { name: 'a', managedFields: [] } }])).toEqual([
      { metadata: { name: 'a' } },
    ]);
  });
});
