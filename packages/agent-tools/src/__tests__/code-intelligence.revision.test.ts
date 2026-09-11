import { describe, expect, test, vi } from 'vitest';

import type { RuntimeArtifact } from '@sre/connectors';

import { createFixture } from './code-intelligence.fixture';

const __fixture = createFixture();

describe('investigate_code', () => {
  test('reads the stack path at the deployed revision, not the current default branch', async () => {
    const testCase = __fixture.setup({
      deployments: [
        __fixture.deployment(__fixture.OLD, '2026-08-20T12:00:00Z'),
        __fixture.deployment(__fixture.PREVIOUS, '2026-08-19T12:00:00Z'),
      ],
    });
    const result = await testCase.run({
      stackTrace:
        'TypeError: account missing\n    at chargeAccount (/workspace/src/orders.ts:42:9)',
      errorText: 'account missing',
      evidenceIds: ['22222222-2222-4222-8222-222222222222'],
    });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected code evidence');
    expect(result.data.status).toBe('located');
    expect(result.data.revisions[0]).toMatchObject({
      revision: __fixture.OLD,
      basis: 'deployment_event',
      strength: 'corroborated',
    });
    expect(result.data.evidence[0]).toMatchObject({
      revision: __fixture.OLD,
      path: 'src/orders.ts',
      changedFromPreviousRevision: true,
      causality: 'possible',
      sourceEvidenceIds: ['22222222-2222-4222-8222-222222222222'],
    });
    expect(testCase.source.read).toHaveBeenCalledWith(
      expect.anything(),
      __fixture.OLD,
      'src/orders.ts',
    );
    expect(testCase.source.search).not.toHaveBeenCalled();
    expect(result.data.evidence[0]!.excerpt).toContain('42: export function chargeAccount');
    expect(testCase.audit.records).toHaveLength(1);
    expect(testCase.audit.records[0]).toMatchObject({ tool: 'investigate_code', outcome: 'data' });
  });

  test('selects the deployment at provider onset rather than later incident ingestion time', async () => {
    const testCase = __fixture.setup({
      onsetAt: new Date('2026-08-20T13:00:00Z'),
      deployments: [
        __fixture.deployment(__fixture.ARTIFACT, '2026-08-20T18:00:00Z'),
        __fixture.deployment(__fixture.OLD, '2026-08-20T12:00:00Z'),
      ],
    });
    const result = await testCase.run({ stackTrace: '/workspace/src/orders.ts:42:9' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected code evidence');
    expect(result.data.revisions[0]).toMatchObject({
      revision: __fixture.OLD,
      basis: 'deployment_event',
    });
    expect(testCase.source.read).toHaveBeenCalledWith(
      expect.anything(),
      __fixture.OLD,
      'src/orders.ts',
    );
  });

  test('prefers repository and revision metadata attached to the running artifact', async () => {
    const artifact: RuntimeArtifact = {
      dataSourceId: '00000000-0000-4000-8000-000000000002',
      dataSourceName: 'Kubernetes production',
      kind: 'oci_image',
      service: 'checkout',
      namespace: 'checkout',
      workload: 'checkout-abc',
      container: 'app',
      image: 'registry.example/acme/checkout:stable',
      identity: `registry.example/acme/checkout@sha256:${'e'.repeat(64)}`,
      digest: `sha256:${'e'.repeat(64)}`,
      sourceUrl: 'https://github.com/acme/checkout.git',
      revision: __fixture.ARTIFACT,
      provenance: 'declared',
      observedAt: '2026-08-21T00:01:00Z',
    };
    const testCase = __fixture.setup({
      deployments: [__fixture.deployment(__fixture.OLD, '2026-08-20T12:00:00Z')],
      artifacts: [artifact],
    });
    const result = await testCase.run({ stackTrace: '/workspace/src/orders.ts:42:9' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected code evidence');
    expect(result.data.artifacts).toEqual([artifact]);
    expect(result.data.revisions[0]).toMatchObject({
      revision: __fixture.ARTIFACT,
      basis: 'runtime_annotation',
      strength: 'declared',
    });
    expect(testCase.source.read).toHaveBeenCalledWith(
      expect.anything(),
      __fixture.ARTIFACT,
      'src/orders.ts',
    );
  });

  test('does not project a current artifact revision backward across a later deployment', async () => {
    const artifact: RuntimeArtifact = {
      dataSourceId: '00000000-0000-4000-8000-000000000002',
      dataSourceName: 'Kubernetes production',
      kind: 'oci_image',
      service: 'checkout',
      namespace: 'checkout',
      workload: 'checkout-new',
      container: 'app',
      image: 'registry.example/acme/checkout:stable',
      identity: `registry.example/acme/checkout@sha256:${'e'.repeat(64)}`,
      digest: `sha256:${'e'.repeat(64)}`,
      sourceUrl: 'https://github.com/acme/checkout.git',
      revision: __fixture.ARTIFACT,
      provenance: 'declared',
      observedAt: '2026-08-21T01:30:00Z',
    };
    const later = __fixture.deployment(__fixture.ARTIFACT, '2026-08-21T01:00:00Z');
    const testCase = __fixture.setup({
      deployments: [later, __fixture.deployment(__fixture.OLD, '2026-08-20T12:00:00Z')],
      artifacts: [artifact],
    });
    const result = await testCase.run({ stackTrace: '/workspace/src/orders.ts:42:9' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected code evidence');
    expect(result.data.revisions[0]).toMatchObject({
      revision: __fixture.OLD,
      basis: 'deployment_event',
    });
    expect(testCase.source.read).toHaveBeenCalledWith(
      expect.anything(),
      __fixture.OLD,
      'src/orders.ts',
    );
  });

  test('uses provider search only to discover a path, then reads it at the deployed revision', async () => {
    const source = __fixture.reader();
    vi.mocked(source.read).mockImplementation(async (_repository, revision, path) => {
      if (path !== 'packages/checkout/src/orders.ts') throw new Error('source not found');
      return {
        path,
        revision,
        text: __fixture.sourceText(),
        providerUrl: `https://github.com/acme/checkout/blob/${revision}/${path}`,
      };
    });
    vi.mocked(source.search).mockResolvedValue({
      incomplete: false,
      matches: [
        {
          path: 'packages/checkout/src/orders.ts',
          scope: { kind: 'default_branch', ref: 'main' },
          line: 42,
          fragment: 'chargeAccount',
        },
      ],
    });
    const testCase = __fixture.setup({
      reader: source,
      deployments: [__fixture.deployment(__fixture.OLD, '2026-08-20T12:00:00Z')],
    });
    const result = await testCase.run({
      stackTrace: 'at chargeAccount (/srv/bundle/orders.js:42:9)',
    });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected code evidence');
    expect(result.data.status).toBe('located');
    expect(source.search).toHaveBeenCalledWith(expect.anything(), 'chargeAccount', 10);
    expect(source.read).toHaveBeenCalledWith(
      expect.anything(),
      __fixture.OLD,
      'packages/checkout/src/orders.ts',
    );
    expect(result.data.evidence[0]).toMatchObject({
      revision: __fixture.OLD,
      path: 'packages/checkout/src/orders.ts',
    });
  });

  test('rejects a default-branch search hit whose anchor is absent at the incident revision', async () => {
    const source = __fixture.reader();
    vi.mocked(source.search).mockResolvedValue({
      incomplete: false,
      matches: [
        {
          path: 'src/orders.ts',
          scope: { kind: 'default_branch', ref: 'main' },
          line: 7,
          fragment: 'MissingAccountToken',
        },
      ],
    });
    const testCase = __fixture.setup({
      reader: source,
      deployments: [__fixture.deployment(__fixture.OLD, '2026-08-20T12:00:00Z')],
    });

    const result = await testCase.run({ errorText: 'MissingAccountToken' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected bounded no-match result');
    expect(result.data.status).toBe('no_match');
    expect(result.data.evidence).toEqual([]);
  });

  test('searches and revalidates the full error phrase before a generic token fallback', async () => {
    const repo = __fixture.repository({ fullName: 'acme/sre-platform' });
    const source = __fixture.reader(repo);
    vi.mocked(source.search).mockImplementation(async (_repository, query) => ({
      incomplete: false,
      matches: [
        {
          path:
            query === 'manual incident declaration failed'
              ? 'apps/api/src/incidents.ts'
              : 'CONTEXT.md',
          scope: { kind: 'default_branch', ref: 'main' },
          fragment: query,
          line: 1,
        },
      ],
    }));
    vi.mocked(source.read).mockImplementation(async (_repository, revision, path) => ({
      path,
      revision,
      text:
        path === 'apps/api/src/incidents.ts'
          ? "logger.error('manual incident declaration failed')"
          : 'Manual operator workflow documentation.',
      providerUrl: `https://github.com/acme/sre-platform/blob/${revision}/${path}`,
    }));

    const result = await __fixture.setup({ reader: source }).run({
      errorText: 'manual incident declaration failed',
      focus: 'locate the responsible source',
    });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected exact error evidence');
    expect(result.data.status).toBe('located');
    expect(result.data.evidence[0]).toMatchObject({
      path: 'apps/api/src/incidents.ts',
      matchedBy: ['error_text'],
    });
    expect(source.search).toHaveBeenCalledWith(
      expect.anything(),
      'manual incident declaration failed',
      10,
    );
    expect(source.search).not.toHaveBeenCalledWith(expect.anything(), 'declaration', 10);
  });

  test('falls back to a salient error token after full-phrase revalidation fails', async () => {
    const source = __fixture.reader();
    vi.mocked(source.search).mockImplementation(async (_repository, query) => ({
      incomplete: false,
      matches: [
        {
          path:
            query === 'manual incident declaration failed'
              ? 'CONTEXT.md'
              : 'apps/api/src/incidents.ts',
          scope: { kind: 'default_branch', ref: 'main' },
          fragment: query,
          line: 1,
        },
      ],
    }));
    vi.mocked(source.read).mockImplementation(async (_repository, revision, path) => ({
      path,
      revision,
      text:
        path === 'CONTEXT.md'
          ? 'Manual operator workflow documentation.'
          : "logger.error('manual incident declaration failed')",
      providerUrl: `https://github.com/acme/checkout/blob/${revision}/${path}`,
    }));

    const result = await __fixture.setup({ reader: source }).run({
      errorText: 'manual incident declaration failed',
      focus: 'locate the responsible source',
    });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected token-fallback evidence');
    expect(result.data.status).toBe('located');
    expect(result.data.evidence[0]).toMatchObject({
      path: 'apps/api/src/incidents.ts',
      matchedBy: ['error_text'],
    });
    expect(vi.mocked(source.search).mock.calls.map((call) => call[1])).toEqual([
      'manual incident declaration failed',
      'declaration',
    ]);
  });

  test('keeps the error-token fallback ahead of a natural-language focus at the query cap', async () => {
    const source = __fixture.reader();
    vi.mocked(source.search).mockImplementation(async (_repository, query) => ({
      incomplete: false,
      matches:
        query === 'TimeoutCode'
          ? [
              {
                path: 'src/orders.ts',
                scope: { kind: 'default_branch', ref: 'main' },
                fragment: 'TimeoutCode',
                line: 42,
              },
            ]
          : [],
    }));
    vi.mocked(source.read).mockImplementation(async (_repository, revision, path) => {
      if (path !== 'src/orders.ts') throw new Error('source map path is not in the repository');
      return {
        path,
        revision,
        text: 'throw new Error(`TimeoutCode ${requestId}`);',
        providerUrl: `https://github.com/acme/checkout/blob/${revision}/${path}`,
      };
    });

    const result = await __fixture.setup({ reader: source }).run({
      stackTrace: 'at chargeAccount (/workspace/bundle.js:42:9)',
      errorText: 'TimeoutCode request 123 failed',
      focus: 'locate the relevant request handler',
    });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected token-fallback evidence');
    expect(result.data.status).toBe('located');
    expect(result.data.evidence[0]).toMatchObject({ path: 'src/orders.ts' });
    expect(source.search).toHaveBeenCalledWith(expect.anything(), 'TimeoutCode', 10);
    expect(source.search).not.toHaveBeenCalledWith(
      expect.anything(),
      'locate the relevant request handler',
      10,
    );
  });

  test('reports local source-search candidate truncation', async () => {
    const source = __fixture.reader();
    vi.mocked(source.search).mockResolvedValue({
      incomplete: false,
      matches: Array.from({ length: 4 }, (_, index) => ({
        path: `src/candidate-${index}.ts`,
        scope: { kind: 'default_branch' as const, ref: 'main' },
        line: 42,
        fragment: 'chargeAccount',
      })),
    });
    const result = await __fixture.setup({ reader: source }).run({ focus: 'chargeAccount' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected located evidence');
    expect(result.data.status).toBe('located');
    expect(result.data.uncertainties).toContain('code search was incomplete for acme/checkout');
  });

  test('returns bounded uncertainty instead of failing the whole tool when provider budget is exhausted', async () => {
    const source = __fixture.reader();
    vi.mocked(source.read).mockRejectedValue(new Error('source not found'));
    vi.mocked(source.search).mockResolvedValue({
      incomplete: false,
      matches: [1, 2, 3].map((index) => ({
        path: `candidate-${index}.ts`,
        scope: { kind: 'default_branch' as const, ref: 'main' },
        fragment: null,
        line: 1,
      })),
    });
    const testCase = __fixture.setup({
      reader: source,
      deployments: [__fixture.deployment(__fixture.OLD, '2026-08-20T12:00:00Z')],
    });
    const result = await testCase.run({
      stackTrace: 'at chargeAccount (/workspace/src/orders.ts:42:9)',
      errorText: 'MissingAccountToken',
      focus: 'BillingLookupFailure',
    });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected bounded no-match result');
    expect(result.data.status).toBe('no_match');
    expect(result.data.uncertainties).toContain(
      'code investigation provider-call budget exhausted',
    );
    expect(source.read).toHaveBeenCalledTimes(7);
  });

  test('returns ambiguity without provider reads instead of fanning out across a catalog', async () => {
    const readers = Array.from({ length: 4 }, (_, index) => {
      const repo = __fixture.repository({
        dataSourceId: `00000000-0000-4000-8000-00000000000${index + 1}`,
        repositoryId: String(index + 1),
        fullName: `acme/checkout-${index + 1}`,
      });
      const source = __fixture.reader(repo);
      return { source, connector: __fixture.connector(source) };
    });
    const testCase = __fixture.setup({ connectors: readers.map((item) => item.connector) });
    const result = await testCase.run({ stackTrace: '/workspace/src/orders.ts:42:9' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected ambiguity');
    expect(result.data.status).toBe('ambiguous');
    expect(result.data.requiredSetup[0]).toMatch(/confirm the service repository mapping/);
    for (const item of readers) expect(item.source.verifyRevision).not.toHaveBeenCalled();
  });

  test('does not let a declared runtime source suppress equally confirmed repository mappings', async () => {
    const readers = Array.from({ length: 4 }, (_, index) => {
      const repo = __fixture.repository({
        dataSourceId: `00000000-0000-4000-8000-00000000000${index + 1}`,
        repositoryId: String(index + 1),
        fullName: `acme/checkout-${index + 1}`,
      });
      const source = __fixture.reader(repo);
      return { source, connector: __fixture.connector(source) };
    });
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
      sourceUrl: 'https://github.com/acme/checkout-3',
      revision: __fixture.ARTIFACT,
      provenance: 'declared',
      observedAt: '2026-08-21T00:01:00Z',
    };
    const testCase = __fixture.setup({
      connectors: [
        ...readers.map((item) => item.connector),
        __fixture.artifactConnector([artifact]),
      ],
    });
    const result = await testCase.run({ stackTrace: '/workspace/src/orders.ts:42:9' });

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected ambiguous repository result');
    expect(result.data.status).toBe('ambiguous');
    for (const item of readers) expect(item.source.verifyRevision).not.toHaveBeenCalled();
  });

  test('does not trust a runtime source URL from a different repository host', async () => {
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
      sourceUrl: 'https://git.example.net/acme/checkout',
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
});
