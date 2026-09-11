import { describe, expect, test } from 'vitest';
import { kubernetesRbacManifest } from '../manifest';

describe('kubernetesRbacManifest', () => {
  const yaml = kubernetesRbacManifest({
    namespace: 'sre-triage',
    serviceAccount: 'sre-triage-reader',
  });

  test('emits Namespace, ServiceAccount, ClusterRole, bindings and a token Secret', () => {
    expect(yaml).toContain('kind: Namespace');
    expect(yaml).toContain('kind: ServiceAccount');
    expect(yaml).toContain('kind: ClusterRole\n');
    expect(yaml).toContain('kind: ClusterRoleBinding');
    // Long-lived, projected-token-independent service account token (k8s >= 1.24).
    expect(yaml).toContain('type: kubernetes.io/service-account-token');
    expect(yaml).toContain('kubernetes.io/service-account.name: sre-triage-reader');
  });

  test('binds the built-in read-only view ClusterRole to the service account', () => {
    // view grants broad reads but deliberately excludes secrets; that is why we bind it.
    expect(yaml).toMatch(/kind: ClusterRole\n\s+name: view/);
    expect(yaml).toContain('name: sre-triage-reader');
  });

  test('interpolates the namespace and service account', () => {
    const custom = kubernetesRbacManifest({ namespace: 'obs', serviceAccount: 'reader-x' });
    expect(custom).toContain('name: obs');
    expect(custom).toContain('name: reader-x');
    expect(custom).toContain('name: reader-x-cluster-read');
  });

  test('never grants read on secrets in any ClusterRole rule', () => {
    // Least privilege: the supplement role only adds nodes, metrics and pods/log; a secrets grant
    // would defeat the whole point of the connector's secret-exclusion posture.
    expect(yaml).not.toMatch(/resources:.*secrets/);
    expect(yaml).not.toContain('- secrets');
  });

  test('supplement ClusterRole grants nodes, metrics and pods/log only', () => {
    expect(yaml).toContain('name: sre-triage-reader-cluster-read');
    expect(yaml).toMatch(/resources:\s*\[?"?nodes/);
    expect(yaml).toContain('metrics.k8s.io');
    expect(yaml).toContain('pods/log');
  });

  test('rejects path-injecting namespace or service account names', () => {
    expect(() => kubernetesRbacManifest({ namespace: '../x', serviceAccount: 'ok' })).toThrow();
    expect(() => kubernetesRbacManifest({ namespace: 'ns', serviceAccount: 'bad/name' })).toThrow();
    expect(() => kubernetesRbacManifest({ namespace: 'UPPER', serviceAccount: 'ok' })).toThrow();
  });
});
