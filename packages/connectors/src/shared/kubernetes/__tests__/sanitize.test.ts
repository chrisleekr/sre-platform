import { describe, expect, test } from 'vitest';
import { sanitizeObject } from '../sanitize';

const REDACTED = '[REDACTED]';
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

describe('sanitizeObject Secret redaction', () => {
  test('redacts every value in Secret data and stringData but keeps the keys', () => {
    const secret = {
      kind: 'Secret',
      metadata: { name: 'db' },
      data: { password: 'aGVsbG8=', 'tls.key': 'c2VjcmV0' },
      stringData: { token: 'plain-token' },
    };
    const out = sanitizeObject(secret) as typeof secret;
    expect(Object.keys(out.data)).toEqual(['password', 'tls.key']);
    expect(out.data.password).toBe(REDACTED);
    expect(out.data['tls.key']).toBe(REDACTED);
    expect(out.stringData.token).toBe(REDACTED);
    // Input is not mutated (pure).
    expect(secret.data.password).toBe('aGVsbG8=');
  });

  test('redacts a Secret list item when kind comes from resourceKind (item has no .kind)', () => {
    const item = { metadata: { name: 'db' }, data: { password: 'x' } };
    const out = sanitizeObject(item, 'Secret') as { data: Record<string, string> };
    expect(Object.keys(out.data)).toEqual(['password']);
    expect(out.data.password).toBe(REDACTED);
  });
});

describe('sanitizeObject ConfigMap redaction', () => {
  test('redacts ConfigMap data and binaryData values, keeps keys', () => {
    const cm = {
      kind: 'ConfigMap',
      data: { 'app.conf': 'server=prod', 'db.url': 'postgres://secret' },
      binaryData: { 'blob.bin': 'AAAA' },
    };
    const out = sanitizeObject(cm) as typeof cm;
    expect(Object.keys(out.data)).toEqual(['app.conf', 'db.url']);
    expect(out.data['app.conf']).toBe(REDACTED);
    expect(out.data['db.url']).toBe(REDACTED);
    expect(out.binaryData['blob.bin']).toBe(REDACTED);
  });
});

describe('sanitizeObject does not redact benign data on non-Secret/non-ConfigMap kinds', () => {
  test('a CustomResource with a data field is left untouched', () => {
    const cr = { kind: 'Widget', data: { count: 3, label: 'ok' } };
    const out = sanitizeObject(cr) as typeof cr;
    expect(out.data).toEqual({ count: 3, label: 'ok' });
  });

  test('no kind and no resourceKind: data untouched', () => {
    const anon = { data: { a: 1 } };
    const out = sanitizeObject(anon) as typeof anon;
    expect(out.data).toEqual({ a: 1 });
  });
});

describe('sanitizeObject container env redaction', () => {
  test('redacts env[].value in a Deployment pod template, keeps name and valueFrom', () => {
    const deploy = {
      kind: 'Deployment',
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'app',
                env: [
                  { name: 'DB_PASSWORD', value: 'super-secret' },
                  {
                    name: 'FROM_SECRET',
                    valueFrom: { secretKeyRef: { name: 's', key: 'k' } },
                  },
                ],
              },
            ],
            initContainers: [{ name: 'init', env: [{ name: 'API_KEY', value: 'abc123' }] }],
          },
        },
      },
    };
    const out = sanitizeObject(deploy) as any;
    const c = out.spec.template.spec.containers[0];
    expect(c.env[0].name).toBe('DB_PASSWORD');
    expect(c.env[0].value).toBe(REDACTED);
    // valueFrom entries carry no literal value; keep them intact.
    expect(out.spec.template.spec.containers[0].env[1].value).toBeUndefined();
    expect(out.spec.template.spec.containers[0].env[1].valueFrom.secretKeyRef.key).toBe('k');
    expect(out.spec.template.spec.initContainers[0].env[0].value).toBe(REDACTED);
  });

  test('redacts env deep inside a CronJob jobTemplate and in ephemeralContainers', () => {
    const cron = {
      kind: 'CronJob',
      spec: {
        jobTemplate: {
          spec: {
            template: {
              spec: {
                containers: [{ name: 'job', env: [{ name: 'TOKEN', value: 't' }] }],
                ephemeralContainers: [{ name: 'debug', env: [{ name: 'PW', value: 'p' }] }],
              },
            },
          },
        },
      },
    };
    const out = sanitizeObject(cron) as any;
    const spec = out.spec.jobTemplate.spec.template.spec;
    expect(spec.containers[0].env[0].value).toBe(REDACTED);
    expect(spec.ephemeralContainers[0].env[0].value).toBe(REDACTED);
  });
});

describe('sanitizeObject metadata scrubbing', () => {
  test('drops metadata.managedFields wherever it appears', () => {
    const o = {
      kind: 'Pod',
      metadata: { name: 'p', managedFields: [{ manager: 'kubectl' }] },
      spec: { template: { metadata: { managedFields: [{ manager: 'x' }] } } },
    };
    const out = sanitizeObject(o) as any;
    expect('managedFields' in out.metadata).toBe(false);
    expect(out.metadata.name).toBe('p');
    expect('managedFields' in out.spec.template.metadata).toBe(false);
  });

  test('drops the last-applied-configuration annotation, keeps other annotations', () => {
    const o = {
      kind: 'Pod',
      metadata: {
        name: 'p',
        annotations: { [LAST_APPLIED]: '{"big":"blob"}', 'app.io/team': 'sre' },
      },
    };
    const out = sanitizeObject(o) as any;
    expect(LAST_APPLIED in out.metadata.annotations).toBe(false);
    expect(out.metadata.annotations['app.io/team']).toBe('sre');
  });
});

describe('sanitizeObject robustness', () => {
  test('never throws on non-object input', () => {
    expect(sanitizeObject(null)).toBeNull();
    expect(sanitizeObject('str')).toBe('str');
    expect(sanitizeObject(42)).toBe(42);
  });

  test('an array recurses: each item is kind-gated, so a Secret item is redacted', () => {
    // A raw list body handed in whole must not bypass data-redaction; each item sanitizes by its
    // own .kind.
    expect(sanitizeObject([{ kind: 'Secret', data: { a: 'b' } }])).toEqual([
      { kind: 'Secret', data: { a: REDACTED } },
    ]);
  });
});
