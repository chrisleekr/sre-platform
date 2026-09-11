import { afterEach, expect, test, vi } from 'vitest';
import type { ConnectorConfig } from '../../../registry';
import { makeGitLabConnector } from '../connector';
import { pollGitLabGroup } from '../polling';
import { cfg, publicLookup } from './test-helpers';

const now = new Date('2026-09-08T00:00:00Z');
const project = {
  id: 42,
  name: 'service',
  path_with_namespace: 'platform/service',
  web_url: 'https://gitlab.example.com/platform/service',
};
const candidates = [
  {
    repositoryId: '42',
    fullName: 'platform/service',
    cursor: null as Record<string, unknown> | null,
  },
];

function config(cursor: Record<string, unknown> = {}, selected = candidates): ConnectorConfig {
  return cfg({
    settings: {
      baseUrl: 'https://gitlab.example.com',
      groupId: 7,
      groupPath: 'platform',
      eventStrategy: 'system',
      pollCursor: cursor,
    },
    repositories: {
      resolve: async () => [],
      search: async () => [],
      recentEvents: async () => [],
      pollCandidates: async () => selected,
    },
  });
}

function transport(override?: (url: URL) => Response | undefined) {
  const request = async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const url = new URL(String(input));
    const replaced = override?.(url);
    if (replaced) return replaced;
    if (url.pathname === '/api/v4/groups/7') return Response.json({ id: 7, full_path: 'platform' });
    if (/\/groups\//.test(url.pathname))
      return Response.json([project], { headers: { 'x-next-page': '' } });
    if (/\/projects\/\d+$/.test(url.pathname))
      return Response.json({ ...project, id: Number(url.pathname.split('/').at(-1)) });
    const kind = url.pathname.split('/').at(-1);
    const values =
      kind === 'releases'
        ? [{ tag_name: 'v1.0', name: 'Release', released_at: now.toISOString() }]
        : [
            {
              id: 9,
              project_id: 42,
              status: 'running',
              sha: 'abc123',
              updated_at: now.toISOString(),
              ref: 'main',
              token: 'never-store',
              variables: [{ value: 'secret' }],
            },
          ];
    return Response.json(values, { headers: { 'x-next-page': '' } });
  };
  return Object.assign(vi.fn(request), { preconnect: vi.fn() });
}

afterEach(() => vi.useRealTimers());

test('uses bounded read-only requests and emits events, deploys, catalog and per-project cursors', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const fetch = transport();
  const result = await pollGitLabGroup(config(), fetch, publicLookup);
  expect(fetch).toHaveBeenCalledTimes(8);
  for (const [url, init] of fetch.mock.calls) {
    expect(String(url)).toMatch(/^https:\/\/gitlab\.example\.com\/api\/v4\//);
    expect(init?.method).toBeUndefined();
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({ 'PRIVATE-TOKEN': 'glpat-token' });
  }
  expect(result.evidence).toMatchObject({
    expectedCursor: {},
    cursor: { revision: 1, catalogPage: 1 },
    errorCount: 0,
  });
  expect(result.snapshots.filter((s) => s.metadata.kind === 'gitlab-event')).toHaveLength(5);
  expect(
    result.snapshots.find((s) => s.metadata.kind === 'gitlab-deployment')?.metadata,
  ).toMatchObject({ repo: 'platform/service', sha: 'abc123' });
  expect(
    result.snapshots.find((s) => s.metadata.kind === 'gitlab-poll-state')?.metadata,
  ).toMatchObject({
    active: true,
    failureCategory: null,
    cursor: { turn: 1, pipeline: { page: 1, since: '2026-09-07T23:59:00.000Z', pending: false } },
  });
  expect(JSON.stringify(result.snapshots)).not.toMatch(/never-store|variables|secret/);
});

test('replays a legacy offset cursor from its timestamp window after restarting', async () => {
  const saved = {
    pipeline: { page: 2, since: '2026-09-07T00:00:00Z', until: '2026-09-07T12:00:00Z' },
  };
  const fetch = transport((url) =>
    url.pathname.endsWith('/pipelines') && !url.searchParams.has('source')
      ? Response.json([{ id: 11, status: 'failed', updated_at: '2026-09-07T01:00:00.123456Z' }], {
          headers: { 'x-next-page': '2' },
        })
      : undefined,
  );
  const result = await pollGitLabGroup(
    config({ revision: 3 }, [{ ...candidates[0]!, cursor: saved }]),
    fetch,
    publicLookup,
  );
  const url = new URL(
    String(
      fetch.mock.calls.find(
        ([url]) => String(url).includes('/pipelines?') && !String(url).includes('source='),
      )![0],
    ),
  );
  expect(url.searchParams.get('page')).toBe('1');
  expect(url.searchParams.get('updated_before')).toBe('2026-09-07T12:00:00.000Z');
  expect(result.snapshots.at(-1)?.metadata.cursor).toMatchObject({
    pipeline: {
      page: 1,
      since: '2026-09-07T01:00:00.122Z',
      until: '2026-09-07T12:00:00.000Z',
      pending: true,
    },
  });
});

test.each(['pipelines', 'deployments'])(
  'does not skip unchanged %s when a consumed record leaves the window',
  async (path) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      status: 'success',
      updated_at: new Date(now.getTime() - 3_600_000 + i * 1000).toISOString(),
    }));
    const fetch = transport((url) => {
      if (!url.pathname.endsWith(`/${path}`) || url.searchParams.has('source')) return;
      const from = Date.parse(url.searchParams.get('updated_after')!);
      const to = Date.parse(url.searchParams.get('updated_before')!);
      const filtered = rows.filter((row) => {
        const at = Date.parse(row.updated_at);
        return at >= from && at <= to;
      });
      const size = Number(url.searchParams.get('per_page'));
      const offset = (Number(url.searchParams.get('page')) - 1) * size;
      return Response.json(filtered.slice(offset, offset + size), {
        headers: { 'x-next-page': filtered.length > offset + size ? '2' : '' },
      });
    });
    let cursor: Record<string, unknown> = {};
    const seen = new Set<string>();
    const stream = path === 'pipelines' ? 'pipeline' : 'deployment';
    for (let turn = 0; turn < 10; turn++) {
      const result = await pollGitLabGroup(
        config({}, [{ ...candidates[0]!, cursor }]),
        fetch,
        publicLookup,
      );
      for (const row of result.snapshots)
        if (row.metadata.kind === 'gitlab-event' && row.metadata.eventType === stream)
          seen.add(String((row.metadata.details as { id: string }).id));
      cursor = result.snapshots.at(-1)!.metadata.cursor as Record<string, unknown>;
      if (turn === 0) rows[0]!.updated_at = new Date(now.getTime() + 1000).toISOString();
      if (!(cursor[stream] as { pending: boolean }).pending) break;
    }
    expect(seen).toEqual(new Set(rows.map((row) => String(row.id))));
    expect(cursor[stream]).toMatchObject({ pending: false });
  },
);

test.each([21, 100, 101])(
  'handles %i equal-time records without silently advancing past the boundary',
  async (count) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const rows = Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      status: 'success',
      updated_at: '2026-09-07T23:00:00.123456Z',
    }));
    const fetch = transport((url) => {
      if (!url.pathname.endsWith('/pipelines') || url.searchParams.has('source')) return;
      const size = Number(url.searchParams.get('per_page'));
      return Response.json(rows.slice(0, size), {
        headers: { 'x-next-page': count > size ? '2' : '' },
      });
    });
    let cursor: Record<string, unknown> = {};
    let last;
    for (let turn = 0; turn < 3; turn++) {
      last = await pollGitLabGroup(
        config({}, [{ ...candidates[0]!, cursor }]),
        fetch,
        publicLookup,
      );
      cursor = last.snapshots.at(-1)!.metadata.cursor as Record<string, unknown>;
    }
    if (count > 100) {
      expect(last!.evidence.failureCategory).toBe('timestamp_boundary_limit');
      expect(cursor.pipeline).toMatchObject({ pending: true, since: '2026-09-07T23:00:00.122Z' });
    } else {
      expect(last!.evidence.errorCount).toBe(0);
      expect(cursor.pipeline).toMatchObject({ pending: false });
      expect(last!.snapshots.filter((row) => row.metadata.eventType === 'pipeline')).toHaveLength(
        count + 1,
      );
    }
  },
);

test('refreshes job and release heads without discarding their backlog cursors', async () => {
  const cursor = { turn: 1, job: { page: 9, pending: true }, release: { page: 3, pending: true } };
  const fetch = transport();
  const result = await pollGitLabGroup(
    config({}, [{ ...candidates[0]!, cursor }]),
    fetch,
    publicLookup,
  );
  for (const [input] of fetch.mock.calls.filter(([url]) => /\/(jobs|releases)\?/.test(String(url))))
    expect(new URL(String(input)).searchParams.get('page')).toBe('1');
  expect(result.snapshots.at(-1)?.metadata.cursor).toMatchObject({
    job: { page: 9, pending: true },
    release: { page: 3, pending: true },
  });
});

test('retains active pipelines across empty incremental pages until an explicit terminal state', async () => {
  const candidate = { ...candidates[0]!, cursor: { pipeline: { activeIds: { '10': true } } } };
  const empty = transport((url) =>
    url.pathname.endsWith('/pipelines') ? Response.json([]) : undefined,
  );
  const first = await pollGitLabGroup(config({}, [candidate]), empty, publicLookup);
  expect(first.snapshots.at(-1)?.metadata.cursor).toMatchObject({
    pipeline: { activeIds: { '10': true } },
  });
  const finished = transport((url) =>
    url.pathname.endsWith('/pipelines')
      ? Response.json([{ id: 10, status: 'success' }])
      : undefined,
  );
  const second = await pollGitLabGroup(config({}, [candidate]), finished, publicLookup);
  expect(second.snapshots.at(-1)?.metadata.cursor).toMatchObject({ pipeline: { activeIds: {} } });
});

test('bounds active tracking and preserves its coverage warning across empty successful reads', async () => {
  const activeIds = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [String(i + 1), true]),
  );
  const fetch = transport((url) =>
    url.pathname.endsWith('/pipelines')
      ? Response.json([{ id: 101, status: 'running' }])
      : undefined,
  );
  const first = await pollGitLabGroup(
    config({}, [{ ...candidates[0]!, cursor: { pipeline: { activeIds } } }]),
    fetch,
    publicLookup,
  );
  const cursor = first.snapshots.at(-1)!.metadata.cursor as Record<string, unknown>;
  expect(cursor.pipeline).toMatchObject({ activeOverflow: true });
  expect(Object.keys((cursor.pipeline as { activeIds: object }).activeIds)).toHaveLength(100);
  const empty = transport((url) =>
    url.pathname.endsWith('/pipelines') ? Response.json([]) : undefined,
  );
  const second = await pollGitLabGroup(
    config({}, [{ ...candidates[0]!, cursor }]),
    empty,
    publicLookup,
  );
  expect(second.snapshots.at(-1)?.metadata.cursor).toMatchObject({
    pipeline: { activeOverflow: true },
  });
});

test('retains failed stream cursors and reports partial failures', async () => {
  const saved = { deployment: { page: 4, since: '2026-09-07T00:00:00Z' } };
  const fetch = transport((url) =>
    url.pathname.endsWith('/deployments')
      ? new Response('provider secret', { status: 403 })
      : undefined,
  );
  const result = await pollGitLabGroup(
    config({}, [{ ...candidates[0]!, cursor: saved }]),
    fetch,
    publicLookup,
  );
  expect(result.evidence).toMatchObject({ errorCount: 1, failureCategory: 'permission_denied' });
  expect(result.snapshots.at(-1)?.metadata.cursor).toMatchObject(saved);
  expect(JSON.stringify(result)).not.toContain('provider secret');
});

test('stops group-auth failures and persists a cooldown for rate limiting', async () => {
  const limited = transport((url) =>
    url.pathname.includes('/groups/') ? new Response('', { status: 429 }) : undefined,
  );
  const result = await pollGitLabGroup(config(), limited, publicLookup);
  expect(limited).toHaveBeenCalledTimes(1);
  expect(result.evidence.failureCategory).toBe('rate_limited');
  const next = transport();
  await pollGitLabGroup(config(result.evidence.cursor), next, publicLookup);
  expect(next).not.toHaveBeenCalled();
});

test('bounds work even when the catalog port returns too many candidates', async () => {
  const selected = Array.from({ length: 20 }, (_, index) => ({
    ...candidates[0]!,
    repositoryId: String(index + 1),
  }));
  const fetch = transport();
  const result = await pollGitLabGroup(config({}, selected), fetch, publicLookup);
  expect(fetch).toHaveBeenCalledTimes(26);
  expect(result.snapshots.filter((s) => s.metadata.kind === 'gitlab-poll-state')).toHaveLength(4);
});

test('checks live project scope before polling and drops transferred-out private information', async () => {
  const fetch = transport((url) =>
    url.pathname.endsWith('/projects/42')
      ? Response.json({ ...project, path_with_namespace: 'private/secret' })
      : undefined,
  );
  const result = await pollGitLabGroup(config(), fetch, publicLookup);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(result.snapshots.at(-1)?.metadata).toMatchObject({ projectId: '42', removed: true });
  expect(JSON.stringify(result)).not.toContain('private/secret');
});

test.each([
  { name: 'renamed group', body: { id: 7, full_path: 'renamed' }, status: 200 },
  { name: 'replaced group', body: { id: 8, full_path: 'platform' }, status: 200 },
  { name: 'deleted group', body: {}, status: 404 },
  { name: 'unavailable group', body: {}, status: 503 },
])(
  'does not poll cached projects when group identity is unconfirmed: $name',
  async ({ body, status }) => {
    const fetch = transport((url) =>
      url.pathname === '/api/v4/groups/7' ? Response.json(body, { status }) : undefined,
    );
    const cursor = { revision: 2, catalogPage: 3 };
    const input = config(cursor);
    const select = vi.spyOn(input.repositories!, 'pollCandidates');
    const result = await pollGitLabGroup(input, fetch, publicLookup);
    expect(result.snapshots).toEqual([]);
    expect(result.evidence.errorCount).toBe(1);
    expect(result.evidence.cursor).toEqual(cursor);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  },
);

test('does not opt legacy manual group connections into polling', async () => {
  const fetch = transport();
  const input = config();
  delete input.settings.eventStrategy;
  expect(await makeGitLabConnector(input, fetch, publicLookup).snapshot()).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
