import { describe, expect, test, vi } from 'vitest';

import type { RuntimeArtifact } from '@sre/connectors';

import { createFixture } from './code-intelligence.fixture';

const __fixture = createFixture();

describe('investigate_code', () => {
  test('does not trust a runtime web URL from a different provider port', async () => {
    const artifact: RuntimeArtifact = {
      dataSourceId: '00000000-0000-4000-8000-000000000009',
      dataSourceName: 'Kubernetes production',
      kind: 'oci_image',
      service: 'checkout',
      namespace: 'checkout',
      workload: 'checkout-abc',
      container: 'app',
      image: 'registry.example/acme/checkout:stable',
      identity: `registry.example/acme/checkout@sha256:${'e'.repeat(64)}`,
      digest: `sha256:${'e'.repeat(64)}`,
      sourceUrl: 'https://github.com:8443/acme/checkout',
      revision: __fixture.ARTIFACT,
      provenance: 'declared',
      observedAt: '2026-08-21T00:01:00Z',
    };
    const testCase = __fixture.setup({ artifacts: [artifact] });

    const result = await testCase.run({ stackTrace: '/workspace/src/orders.ts:42:9' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected candidate evidence');
    expect(result.data.revisions[0]).toMatchObject({
      revision: __fixture.HEAD,
      basis: 'default_head',
    });
    expect(testCase.source.verifyRevision).not.toHaveBeenCalledWith(
      expect.anything(),
      __fixture.ARTIFACT,
    );
  });

  test('does not equate an SSH source authority with the catalog web URL', async () => {
    const artifact: RuntimeArtifact = {
      dataSourceId: '00000000-0000-4000-8000-000000000009',
      dataSourceName: 'Kubernetes production',
      kind: 'oci_image',
      service: 'checkout',
      namespace: 'checkout',
      workload: 'checkout-abc',
      container: 'app',
      image: 'registry.example/acme/checkout:stable',
      identity: `registry.example/acme/checkout@sha256:${'e'.repeat(64)}`,
      digest: `sha256:${'e'.repeat(64)}`,
      sourceUrl: 'ssh://git@github.com:2222/acme/checkout.git',
      revision: __fixture.ARTIFACT,
      provenance: 'declared',
      observedAt: '2026-08-21T00:01:00Z',
    };
    const testCase = __fixture.setup({ artifacts: [artifact] });

    const result = await testCase.run({ stackTrace: '/workspace/src/orders.ts:42:9' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected candidate evidence');
    expect(result.data.revisions[0]).toMatchObject({
      revision: __fixture.HEAD,
      basis: 'default_head',
    });
    expect(testCase.source.verifyRevision).not.toHaveBeenCalledWith(
      expect.anything(),
      __fixture.ARTIFACT,
    );
  });

  test('does not match a nested repository path by suffix', async () => {
    const artifact: RuntimeArtifact = {
      dataSourceId: '00000000-0000-4000-8000-000000000009',
      dataSourceName: 'Kubernetes production',
      kind: 'oci_image',
      service: 'checkout',
      namespace: 'checkout',
      workload: 'checkout-abc',
      container: 'app',
      image: 'registry.example/acme/checkout:stable',
      identity: `registry.example/acme/checkout@sha256:${'e'.repeat(64)}`,
      digest: `sha256:${'e'.repeat(64)}`,
      sourceUrl: 'https://github.com/other/acme/checkout',
      revision: __fixture.ARTIFACT,
      provenance: 'declared',
      observedAt: '2026-08-21T00:01:00Z',
    };
    const testCase = __fixture.setup({ artifacts: [artifact] });

    const result = await testCase.run({ stackTrace: '/workspace/src/orders.ts:42:9' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected candidate evidence');
    expect(result.data.revisions[0]).toMatchObject({
      revision: __fixture.HEAD,
      basis: 'default_head',
    });
    expect(testCase.source.verifyRevision).not.toHaveBeenCalledWith(
      expect.anything(),
      __fixture.ARTIFACT,
    );
  });

  test('reports repository catalog reader failures instead of presenting a missing mapping', async () => {
    const unavailable = __fixture.reader();
    vi.mocked(unavailable.resolve).mockRejectedValue(new Error('catalog unavailable'));
    const result = await __fixture.setup({ connectors: [__fixture.connector(unavailable)] }).run({
      focus: 'checkout handler',
    });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected missing mapping result');
    expect(result.data.status).toBe('missing_mapping');
    expect(result.data.uncertainties).toContain(
      'one or more repository catalog readers were unavailable',
    );
  });
});
