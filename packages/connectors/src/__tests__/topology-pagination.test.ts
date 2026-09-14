import { expect, test } from 'vitest';
import {
  makeGrafanaConnector,
  makeStatusCakeConnector,
  makePrometheusConnector,
  type ConnectorConfig,
} from '../index';
import type { TopologyScanProgress } from '@sre/contracts';
import { repositoryTopology } from '../repository-topology';

const config = (type: ConnectorConfig['type']): ConnectorConfig => ({
  id: 'source',
  tenantId: 'tenant',
  name: type,
  type,
  settings: { baseUrl: 'https://grafana.example' },
  getCredential: async () => 'private-token',
});
const lookup = async () => ['93.184.216.34'];

test('Prometheus targets and Grafana backends advance beyond their projection batch within bounded list responses', async () => {
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/search') return Response.json([]);
    if (path === '/api/datasources')
      return Response.json(
        Array.from({ length: 1001 }, (_, i) => ({
          uid: String(i).padStart(4, '0'),
          name: `Backend ${i}`,
        })),
      );
    return Response.json({
      status: 'success',
      data: {
        activeTargets: Array.from({ length: 1001 }, (_, i) => ({
          scrapePool: 'workloads',
          scrapeUrl: `https://metrics.example/${String(i).padStart(4, '0')}`,
          labels: { job: `Target ${i}` },
        })),
      },
    });
  }) as typeof fetch;
  const sources = [
    [makeGrafanaConnector(config('grafana'), fetchImpl, lookup), 'datasources'],
    [
      makePrometheusConnector(
        { ...config('prometheus'), getCredential: async () => JSON.stringify({ type: 'none' }) },
        fetchImpl,
        lookup,
      ),
      'targets',
    ],
  ] as const;
  for (const [source, key] of sources) {
    const first = (await source.topology!.discover()).collections.find((c) => c.key === key)!;
    expect(first.scan).toEqual({ cursor: '1000', incomplete: false });
    const last = (
      await source.topology!.discover({ scans: { [key]: first.scan! } })
    ).collections.find((c) => c.key === key)!;
    expect(last.completeness).toBe('complete');
    expect(last.scan).toEqual({ cursor: null, incomplete: false });
    expect(last.entities.some((e) => e.name.endsWith('1000'))).toBe(true);
  }
});

test('Grafana reads subsequent search pages and carries missing panel evidence to the end of a scan', async () => {
  const pages: string[] = [],
    reads: string[] = [];
  let fail = false;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/datasources') return Response.json([]);
    if (url.pathname === '/api/search') {
      pages.push(url.searchParams.get('page')!);
      expect(url.searchParams.get('limit')).toBe('25');
      return Response.json(
        url.searchParams.get('page') === '1'
          ? Array.from({ length: 25 }, (_, i) => ({
              uid: `dashboard-${i}`,
              title: `Dashboard ${i}`,
            }))
          : [{ uid: 'last', title: 'Last dashboard' }],
      );
    }
    reads.push(url.pathname);
    return fail ? new Response('', { status: 403 }) : Response.json({ dashboard: { panels: [] } });
  }) as typeof fetch;
  for (const missing of [false, true]) {
    fail = missing;
    const source = makeGrafanaConnector(config('grafana'), fetchImpl, lookup);
    const first = (await source.topology!.discover()).collections.find(
      (c) => c.key === 'dashboards',
    )!;
    expect(first.scan).toEqual({ cursor: '2', incomplete: missing });
    expect(first.completeness).toBe('partial');
    fail = false;
    const second = (
      await source.topology!.discover({ scans: { dashboards: first.scan! } })
    ).collections.find((c) => c.key === 'dashboards')!;
    expect(second.entities.map((e) => e.name)).toEqual(['Last dashboard']);
    expect(second.scan).toEqual({ cursor: null, incomplete: missing });
    expect(second.completeness).toBe(missing ? 'partial' : 'complete');
  }
  expect(pages).toEqual(['1', '2', '1', '2']);
  expect(reads).toHaveLength(52);
});

test('StatusCake resumes after the five-page batch instead of rereading its first monitors', async () => {
  const pages: number[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/uptime'))
      return Response.json({ data: [], metadata: { page_count: 0 } });
    const page = Number(url.searchParams.get('page'));
    pages.push(page);
    return Response.json({
      data: [{ id: String(page), name: `Monitor ${page}` }],
      metadata: { page_count: 6 },
    });
  }) as typeof fetch;
  const source = makeStatusCakeConnector(config('statuscake'), fetchImpl);
  const first = (await source.topology!.discover()).collections[0]!;
  expect(first.scan).toEqual({ cursor: '6', incomplete: false });
  const second = (await source.topology!.discover({ scans: { uptime: first.scan! } }))
    .collections[0]!;
  expect(second.scan).toEqual({ cursor: null, incomplete: false });
  expect(second.completeness).toBe('complete');
  expect(pages).toEqual([1, 2, 3, 4, 5, 6]);
});

test('repository inventory walks admitted catalog identifiers beyond the first hundred', async () => {
  const entries = Array.from({ length: 205 }, (_, i) => ({
    repositoryId: String(i).padStart(4, '0'),
    fullName: `team/repo-${i}`,
    defaultBranch: 'main',
    htmlUrl: `https://git.example/team/repo-${i}`,
    private: true,
    archived: false,
  }));
  const requested: Array<string | null> = [];
  const source = repositoryTopology({
    ...config('gitlab'),
    repositories: {
      search: async () => {
        throw new Error('Must use paged catalog');
      },
      resolve: async () => [],
      recentEvents: async () => [],
      page: async (after, limit) => {
        requested.push(after);
        return entries
          .filter((entry) => after === null || entry.repositoryId > after)
          .slice(0, limit);
      },
    },
  })!;
  let previous: TopologyScanProgress | undefined;
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const page = (await source.discover({ scans: previous ? { repositories: previous } : {} }))
      .collections[0]!;
    seen.push(...page.entities.map((e) => e.ref.id));
    previous = page.scan;
    expect(page.completeness).toBe(i === 2 ? 'complete' : 'partial');
  }
  expect(new Set(seen).size).toBe(205);
  expect(requested).toEqual([null, '0099', '0199']);
  expect(previous).toEqual({ cursor: null, incomplete: false });
});
