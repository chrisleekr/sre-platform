import { expect, test, vi } from 'vitest';
import type { TopologySourceEvidence } from '@sre/contracts';
import { createFixture } from './code-intelligence.fixture';

const fixture = createFixture();
function evidence(): TopologySourceEvidence {
  return {
    status: 'partial',
    subject: null,
    note: 'Current declared source, not verified image provenance',
    repositories: [
      {
        key: 'source-association',
        repositoryKey: 'repository-identity',
        repository: { authority: 'repository:github.com', kind: 'repository', id: 'acme/checkout' },
        name: 'acme/checkout',
        role: 'application_source',
        path: 'packages/api',
        revision: fixture.OLD,
        declaredBy: 'API pod',
        evidenceKeys: ['runtime-source-edge'],
        sources: [
          {
            connectorId: fixture.repository().dataSourceId,
            connectorName: 'GitHub',
            connectorType: 'github',
            lifecycleVersion: 3,
            collection: 'repositories',
            observedAt: new Date().toISOString(),
            completeness: 'complete',
          },
        ],
      },
    ],
  };
}
function setup(source = evidence(), version = 3) {
  const reader = fixture.reader();
  reader.resolveRepository = vi.fn(async () => fixture.repository());
  const connector = {
    ...fixture.connector(reader),
    generation: { id: fixture.repository().dataSourceId, lifecycleVersion: version },
  };
  const runtime = fixture.artifactConnector([]);
  const testcase = fixture.setup({ reader, connectors: [connector, runtime] });
  testcase.context.sources = vi.fn(async () => source);
  return { ...testcase, reader, runtime, connector };
}

test('uses the recorded topology revision and component without broad service or deployment lookups', async () => {
  const testcase = setup();
  const result = await testcase.run({ stackTrace: '/workspace/src/orders.ts:42' });
  if (!result.available) throw new Error('Expected code result');
  expect(result.data.status).toBe('located');
  expect(result.data.revisions[0]).toMatchObject({
    revision: fixture.OLD,
    basis: 'topology_declaration',
    strength: 'declared',
    topologyEvidenceRefs: ['runtime-source-edge'],
  });
  expect(result.data.evidence[0]?.path).toBe('packages/api/src/orders.ts');
  expect(result.data.uncertainties.join(' ')).toContain('not verified image provenance');
  expect(testcase.reader.resolve).not.toHaveBeenCalled();
  expect(testcase.runtime.runtimeArtifacts!.observe).not.toHaveBeenCalled();
  expect(testcase.context.deploymentBoundary).not.toHaveBeenCalled();
  expect(testcase.reader.verifyRevision).toHaveBeenCalledWith(expect.anything(), fixture.OLD);
});

test('ambiguous or unavailable topology cannot silently use a same-name catalog repository', async () => {
  for (const status of ['ambiguous', 'unavailable'] as const) {
    const testcase = setup({ ...evidence(), status, repositories: [] });
    const result = await testcase.run({ stackTrace: '/workspace/src/orders.ts:42' });
    if (!result.available) throw new Error('Expected code result');
    expect(result.data.status).toBe(status === 'ambiguous' ? 'ambiguous' : 'missing_mapping');
    expect(testcase.reader.resolve).not.toHaveBeenCalled();
    expect(testcase.reader.resolveRepository).not.toHaveBeenCalled();
    expect(testcase.reader.read).not.toHaveBeenCalled();
  }
});

test('obsolete generations, invalid component paths and unknown source roles do not authorize reads', async () => {
  for (const mode of ['generation', 'traversal', 'role'] as const) {
    const source = evidence();
    if (mode === 'traversal') source.repositories[0]!.path = '../other';
    if (mode === 'role') source.repositories[0]!.role = 'unknown';
    const testcase = setup(source, mode === 'generation' ? 4 : 3);
    const result = await testcase.run({ stackTrace: '/workspace/src/orders.ts:42' });
    if (!result.available) throw new Error('Expected code result');
    expect(result.data.status).toBe('missing_mapping');
    expect(testcase.reader.read).not.toHaveBeenCalled();
    expect(testcase.reader.verifyRevision).not.toHaveBeenCalled();
  }
});

test('a missing or mismatched immutable revision cannot fall back to default-branch source', async () => {
  for (const mode of ['missing', 'moving', 'mismatch'] as const) {
    const source = evidence();
    if (mode === 'missing') source.repositories[0]!.revision = null;
    if (mode === 'moving') source.repositories[0]!.revision = 'main';
    const testcase = setup(source);
    if (mode === 'mismatch')
      vi.mocked(testcase.reader.verifyRevision).mockResolvedValue({
        revision: fixture.HEAD,
        providerUrl: 'https://github.com/acme/checkout',
      });
    const result = await testcase.run({ stackTrace: '/workspace/src/orders.ts:42' });
    if (!result.available) throw new Error('Expected code result');
    expect(result.data.status).toBe('missing_revision');
    expect(testcase.reader.read).not.toHaveBeenCalled();
    expect(testcase.context.deploymentBoundary).not.toHaveBeenCalled();
  }
});

test('separate component revisions in one repository remain separate source targets', async () => {
  const source = evidence();
  source.repositories.push({
    ...source.repositories[0]!,
    key: 'worker-association',
    path: 'packages/worker',
    revision: fixture.HEAD,
  });
  const testcase = setup(source);
  const result = await testcase.run({ stackTrace: '/workspace/src/orders.ts:42' });
  if (!result.available) throw new Error('Expected code result');
  expect(result.data.revisions.map((item) => item.revision).sort()).toEqual(
    [fixture.OLD, fixture.HEAD].sort(),
  );
  expect(result.data.evidence.map((item) => item.path).sort()).toEqual([
    'packages/api/src/orders.ts',
    'packages/worker/src/orders.ts',
  ]);
});

test.each(['path', 'revision'] as const)(
  'rejects a source response with a different %s',
  async (field) => {
    const testcase = setup();
    vi.mocked(testcase.reader.read).mockImplementation(async (_repository, revision, path) => ({
      path: field === 'path' ? 'outside/other.ts' : path,
      revision: field === 'revision' ? fixture.HEAD : revision,
      text: 'untrusted returned source',
      providerUrl: 'https://github.com/acme/checkout/blob/other',
    }));
    const result = await testcase.run({ stackTrace: '/workspace/src/orders.ts:42' });
    expect(JSON.stringify(result)).not.toContain('untrusted returned source');
    expect(JSON.stringify(result)).toContain('Source response did not match');
    expect(JSON.stringify(testcase.audit.records)).not.toContain('untrusted returned source');
  },
);

test.each([
  'removed',
  'rotated',
  'catalog',
  'association',
  'component',
  'revision',
  'ambiguous',
  'unavailable',
])('discards source output when %s changes during the provider read', async (change) => {
  const testcase = setup();
  vi.mocked(testcase.reader.read).mockImplementation(async (_repository, revision, path) => {
    const current = evidence();
    if (change === 'removed') testcase.toolContext.resolveConnectors = async () => [];
    if (change === 'rotated') {
      current.repositories[0]!.sources[0]!.lifecycleVersion = 4;
      testcase.toolContext.resolveConnectors = async () => [
        {
          ...testcase.connector,
          generation: { ...testcase.connector.generation, lifecycleVersion: 4 },
        },
      ];
    }
    if (change === 'catalog') vi.mocked(testcase.reader.resolveRepository!).mockResolvedValue(null);
    if (change === 'association') current.repositories = [];
    if (change === 'component') current.repositories[0]!.path = null;
    if (change === 'revision') current.repositories[0]!.revision = fixture.HEAD;
    if (change === 'ambiguous' || change === 'unavailable') current.status = change;
    vi.mocked(testcase.context.sources!).mockResolvedValue(current);
    return {
      path,
      revision,
      text: 'discarded source content',
      providerUrl: 'https://github.com/acme/checkout/file',
    };
  });
  const result = await testcase.run({ stackTrace: '/workspace/src/orders.ts:42' });
  expect(result).toMatchObject({
    available: true,
    data: { status: 'source_changed', evidence: [], revisions: [] },
  });
  expect(JSON.stringify(result)).not.toContain('discarded source content');
  expect(JSON.stringify(testcase.audit.records)).not.toContain('discarded source content');
});

test('search results are only path hints, followed by a component-confined read at the recorded revision', async () => {
  const testcase = setup();
  vi.mocked(testcase.reader.search).mockResolvedValue({
    incomplete: true,
    matches: [
      {
        path: 'other/private.ts',
        scope: { kind: 'default_branch', ref: 'main' },
        fragment: 'discarded search fragment',
        line: 1,
      },
      {
        path: 'packages/api/src/orders.ts',
        scope: { kind: 'default_branch', ref: 'main' },
        fragment: 'discarded search fragment',
        line: 1,
      },
    ],
  });
  const current = evidence();
  const initial = evidence();
  initial.repositories[0]!.sources[0]!.observedAt = new Date(Date.now() - 1000).toISOString();
  vi.mocked(testcase.context.sources!).mockResolvedValueOnce(initial).mockResolvedValue(current);
  const result = await testcase.run({ focus: 'chargeAccount' });
  expect(result).toMatchObject({
    available: true,
    data: {
      status: 'located',
      evidence: [
        expect.objectContaining({ path: 'packages/api/src/orders.ts', revision: fixture.OLD }),
      ],
    },
  });
  expect(testcase.reader.read).toHaveBeenCalledOnce();
  expect(testcase.reader.read).toHaveBeenCalledWith(
    expect.anything(),
    fixture.OLD,
    'packages/api/src/orders.ts',
  );
  expect(JSON.stringify(testcase.audit.records)).not.toContain('discarded search fragment');
});
