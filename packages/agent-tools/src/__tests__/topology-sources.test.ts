import { beforeEach, expect, test, vi } from 'vitest';
import type { Db } from '@sre/db';
import type { IDataSourceConnector } from '@sre/connectors';
import type { TopologySourceEvidence } from '@sre/contracts';
import { makeReadTopologySourceFileTool } from '../topology-sources';
import { readTopologySourceFile } from '../topology-source-reader';
import { runTool } from '../dispatch';
import { makeInMemoryAuditSink } from '../audit';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@sre/topology', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readTopologySources: mocks.read,
}));
const revision = 'a'.repeat(40);
const source: TopologySourceEvidence['repositories'][number] = {
  key: 'source-proof',
  repository: { authority: 'repository:git.example', kind: 'repository', id: 'team/mono' },
  repositoryKey: 'repo',
  name: 'team/mono',
  role: 'deployment_config',
  path: 'apps/api',
  revision,
  declaredBy: 'api',
  evidenceKeys: ['owns', 'manages', 'source'],
  sources: [
    {
      connectorId: 'git',
      connectorName: 'Git',
      connectorType: 'gitlab',
      collection: 'repositories',
      completeness: 'complete',
      lifecycleVersion: 2,
      observedAt: new Date().toISOString(),
    },
  ],
};
beforeEach(() =>
  mocks.read.mockResolvedValue({
    status: 'partial',
    subject: null,
    repositories: [source],
    note: 'Declared source',
  }),
);
function setup(generation = 2) {
  const read = vi.fn(async () => ({
    path: 'apps/api/deployment.yaml',
    revision,
    providerUrl: 'https://git.example/file',
    text: 'glpat-ABCDEF1234567890abcd\n' + 'safe source\n'.repeat(200),
  }));
  const resolveRepository = vi.fn(
    async (): Promise<{ repositoryId: string; pathPrefix?: string | null } | null> => ({
      repositoryId: '42',
    }),
  );
  const verifyRevision = vi.fn(async () => ({ revision }));
  const connector = {
    id: 'git',
    generation: { id: 'git', lifecycleVersion: generation },
    sourceCode: { resolveRepository, verifyRevision, read },
  } as unknown as IDataSourceConnector;
  const audit = makeInMemoryAuditSink();
  const ctx = {
    tenantId: 'tenant',
    incidentId: 'incident',
    service: 'api',
    resolveConnectors: vi.fn(async () => [connector]),
    audit,
  };
  return {
    tool: makeReadTopologySourceFileTool({ db: {} as Db }),
    ctx,
    read,
    resolveRepository,
    verifyRevision,
    audit,
    connector,
  };
}
const input = {
  subjectKey: 'exact-api',
  sourceKey: 'source-proof',
  path: 'apps/api/deployment.yaml',
};

test('shared background source reads need no incident and return redacted bounded evidence', async () => {
  const fixture = setup();
  const result = await readTopologySourceFile(
    {
      db: {} as Db,
      tenantId: 'tenant',
      resolveConnectors: fixture.ctx.resolveConnectors,
    },
    input,
  );
  expect(result).toMatchObject({ status: 'read', file: { revision, startLine: 1, endLine: 120 } });
  expect(JSON.stringify(result)).not.toContain('glpat-ABCDEF1234567890abcd');
  expect(result.file!.excerpt.length).toBeLessThanOrEqual(16384);
  expect(fixture.audit.records).toEqual([]);
});

test.each([
  ['password:\n  hunter2\nsafe source', 3],
  ['-----BEGIN PRIVATE KEY-----\nhunter2\n-----END PRIVATE KEY-----\nsafe source', 4],
  ['Authorization:\n  hunter2\nsafe source', 3],
])(
  'redacts complete credential context before selecting source lines: %s',
  async (text, endLine) => {
    const fixture = setup();
    fixture.read.mockResolvedValue({
      path: input.path,
      revision,
      providerUrl: 'https://git.example/file',
      text,
    });
    const result = await runTool(fixture.tool, fixture.ctx, { ...input, startLine: 2 });
    expect(result).toMatchObject({
      available: true,
      data: { status: 'read', file: { startLine: 2, endLine } },
    });
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(fixture.audit.records)).not.toContain('hunter2');
    expect(JSON.stringify(result)).toContain('safe source');
  },
);

test.each(['path', 'revision'] as const)(
  'rejects a provider file with the wrong %s',
  async (field) => {
    const fixture = setup();
    fixture.read.mockResolvedValue({
      path: input.path,
      revision,
      providerUrl: 'https://git.example/file',
      text: 'source evidence',
      [field]: field === 'path' ? 'apps/worker/config.yaml' : 'b'.repeat(40),
    });
    expect(await runTool(fixture.tool, fixture.ctx, input)).toMatchObject({
      available: true,
      data: { status: 'unavailable' },
    });
  },
);

test.each(['removed', 'rotated', 'catalog-removed', 'association-removed'])(
  'discards a completed read when authorization becomes %s',
  async (change) => {
    const fixture = setup();
    if (change === 'removed')
      fixture.ctx.resolveConnectors
        .mockResolvedValueOnce([fixture.connector])
        .mockResolvedValue([]);
    if (change === 'rotated')
      fixture.ctx.resolveConnectors
        .mockResolvedValueOnce([fixture.connector])
        .mockResolvedValue([
          { ...fixture.connector, generation: { id: 'git', lifecycleVersion: 3 } },
        ]);
    if (change === 'catalog-removed')
      fixture.resolveRepository
        .mockResolvedValueOnce({ repositoryId: '42' })
        .mockResolvedValue(null);
    if (change === 'association-removed')
      mocks.read
        .mockResolvedValueOnce({ status: 'partial', repositories: [source] })
        .mockResolvedValue({ repositories: [] });
    expect(await runTool(fixture.tool, fixture.ctx, input)).toMatchObject({
      available: true,
      data: { status: 'unavailable' },
    });
    expect(fixture.read).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixture.audit.records)).not.toContain('safe source');
  },
);

test('reads a bounded exact-revision file through current admitted repository identity and audited redaction', async () => {
  const fixture = setup();
  const result = await runTool(fixture.tool, fixture.ctx, input);
  expect(result).toMatchObject({
    available: true,
    data: {
      status: 'read',
      source: { role: 'deployment_config' },
      file: { revision, truncated: true },
    },
  });
  expect(fixture.resolveRepository).toHaveBeenCalledWith(source.repository);
  expect(fixture.verifyRevision).toHaveBeenCalledWith({ repositoryId: '42' }, revision);
  expect(JSON.stringify(result)).not.toContain('glpat-ABCDEF1234567890abcd');
  expect(fixture.audit.records[0]?.output).toEqual(result.available ? result.data : null);
});

test.each([
  '../secret',
  '/etc/passwd',
  'apps/worker/config.yaml',
  'apps/api/../secret',
  'apps/api\\secret',
])('rejects traversal and unrelated component path %s before provider access', async (path) => {
  const fixture = setup();
  expect(await runTool(fixture.tool, fixture.ctx, { ...input, path })).toMatchObject({
    available: true,
    data: { status: 'unavailable' },
  });
  expect(fixture.resolveRepository).not.toHaveBeenCalled();
});

test('does not use an old connector generation, arbitrary proof key or moving branch', async () => {
  const fixture = setup(3);
  expect(await runTool(fixture.tool, fixture.ctx, input)).toMatchObject({
    available: true,
    data: { status: 'unavailable' },
  });
  expect(fixture.resolveRepository).not.toHaveBeenCalled();
  const active = setup();
  expect(
    await runTool(active.tool, active.ctx, { ...input, sourceKey: 'not-associated' }),
  ).toMatchObject({ available: true, data: { status: 'unavailable' } });
  mocks.read.mockResolvedValue({ repositories: [{ ...source, revision: 'main' }] });
  expect(await runTool(active.tool, active.ctx, input)).toMatchObject({
    available: true,
    data: { status: 'unavailable' },
  });
  expect(active.resolveRepository).not.toHaveBeenCalled();
});

test('reads subsequent bounded line windows instead of making content after the first excerpt unreachable', async () => {
  const fixture = setup();
  const result = await runTool(fixture.tool, fixture.ctx, { ...input, startLine: 150 });
  expect(result).toMatchObject({
    available: true,
    data: { status: 'read', file: { startLine: 150, truncated: true } },
  });
  expect(result.available && result.data.file!.endLine).toBeLessThanOrEqual(269);
  expect(await runTool(fixture.tool, fixture.ctx, { ...input, startLine: 9999 })).toMatchObject({
    available: true,
    data: { status: 'unavailable' },
  });
});

test('a broader topology association cannot bypass a narrower admitted catalog component', async () => {
  const fixture = setup();
  fixture.resolveRepository.mockResolvedValue({ repositoryId: '42', pathPrefix: 'apps/worker' });
  expect(await runTool(fixture.tool, fixture.ctx, input)).toMatchObject({
    available: true,
    data: { status: 'unavailable' },
  });
  expect(fixture.read).not.toHaveBeenCalled();
});

test.each(['scope', 'identity'])(
  'discards a file when catalog %s changes during its read',
  async (change) => {
    const fixture = setup();
    fixture.resolveRepository.mockResolvedValueOnce({ repositoryId: '42' }).mockResolvedValue({
      repositoryId: change === 'identity' ? '43' : '42',
      pathPrefix: change === 'scope' ? 'apps/worker' : null,
    });
    expect(await runTool(fixture.tool, fixture.ctx, input)).toMatchObject({
      available: true,
      data: { status: 'unavailable' },
    });
    expect(fixture.read).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixture.audit.records)).not.toContain('safe source');
  },
);

test.each(['status', 'role', 'completeness'] as const)(
  'rejects ineligible source %s before provider reads and after changes',
  async (field) => {
    const changed = {
      status: field === 'status' ? 'unavailable' : 'partial',
      subject: null,
      note: '',
      repositories: [
        {
          ...source,
          role: field === 'role' ? 'unknown' : source.role,
          sources: source.sources.map((item) => ({
            ...item,
            completeness: field === 'completeness' ? 'unavailable' : item.completeness,
          })),
        },
      ],
    };
    const first = setup();
    mocks.read.mockResolvedValue(changed);
    expect(
      await readTopologySourceFile(
        { db: {} as Db, tenantId: 'tenant', resolveConnectors: first.ctx.resolveConnectors },
        input,
      ),
    ).toMatchObject({ status: 'unavailable' });
    expect(first.verifyRevision).not.toHaveBeenCalled();
    expect(first.read).not.toHaveBeenCalled();
    const second = setup();
    mocks.read
      .mockResolvedValueOnce({ status: 'partial', subject: null, repositories: [source], note: '' })
      .mockResolvedValue(changed);
    expect(
      await readTopologySourceFile(
        { db: {} as Db, tenantId: 'tenant', resolveConnectors: second.ctx.resolveConnectors },
        input,
      ),
    ).toMatchObject({ status: 'unavailable' });
    expect(second.read).toHaveBeenCalledTimes(1);
  },
);
