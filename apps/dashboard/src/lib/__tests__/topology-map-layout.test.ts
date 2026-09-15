import { expect, test } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { TopologySubject, OperationalTopology } from '@sre/contracts';
import { topologyMapProjection, topologyMapGroups } from '../topology-map';
import {
  topologyLayoutGraph,
  topologyLayoutResult,
  type MapLayout,
  type MapProjection,
} from '../topology-map-layout';

function expectAttached(model: MapProjection, layout: MapLayout) {
  const onBorder = (point: number[], key: string) => {
    const box = layout.nodes.get(key)!;
    const [x, y] = point as [number, number];
    const close = (a: number, b: number) => Math.abs(a - b) < 0.01;
    return (
      ((close(x, box.x) || close(x, box.x + box.width)) &&
        y >= box.y - 0.01 &&
        y <= box.y + box.height + 0.01) ||
      ((close(y, box.y) || close(y, box.y + box.height)) &&
        x >= box.x - 0.01 &&
        x <= box.x + box.width + 0.01)
    );
  };
  for (const edge of model.edges) {
    const paths = layout.edges.get(edge.key)!.paths;
    expect(paths).toHaveLength(1);
    const points = paths.flatMap((path) => path.match(/-?\d+(?:\.\d+)?/g)!.map(Number));
    expect(
      onBorder(points.slice(0, 2), edge.from),
      `Source attachment: ${edge.from} -> ${edge.to}`,
    ).toBe(true);
    expect(
      onBorder(points.slice(-2), edge.to),
      `Target attachment: ${edge.from} -> ${edge.to}`,
    ).toBe(true);
  }
}

const subject = (key: string): TopologySubject => ({
  key,
  name: key,
  kind: 'service',
  scope: { namespace: 'shared', cluster: 'one' },
  resourceKeys: [key],
  sources: [],
  stale: false,
});
const link = (
  from: string,
  to: string,
  evidence: 'observed' | 'declared' = 'observed',
): OperationalTopology['relations'][number] => ({
  from,
  to,
  evidence,
  kind: 'calls',
  evidenceKeys: [from + to + evidence],
  stale: false,
});

test('routes directed, cyclic, parallel and self edges without crossing unrelated node interiors', async () => {
  const subjects = ['checkout', 'payments', 'ledger', 'inventory'].map(subject);
  const links = [
    link('checkout', 'payments'),
    link('checkout', 'payments', 'declared'),
    link('payments', 'ledger'),
    link('ledger', 'checkout'),
    link('checkout', 'inventory'),
    link('ledger', 'ledger'),
  ];
  const model = topologyMapProjection(subjects, links, { mode: 'dependencies' });
  const elk = new ELK();
  const input = topologyLayoutGraph(model);
  const graph = await elk.layout(input);
  const layout = topologyLayoutResult(graph);
  expect(layout.nodes.size).toBe(4);
  expect(layout.edges.size).toBe(6);
  expectAttached(model, layout);
  for (const edge of model.edges) {
    const route = layout.edges.get(edge.key)!;
    expect(route.paths.length).toBeGreaterThan(0);
    expect(route.labels[0]?.text).toContain('calls');
    for (const path of route.paths) {
      const coords = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      for (let i = 2; i < coords.length; i += 2) {
        const x1 = coords[i - 2]!,
          y1 = coords[i - 1]!,
          x2 = coords[i]!,
          y2 = coords[i + 1]!;
        expect(x1 === x2 || y1 === y2).toBe(true);
        for (const [key, box] of layout.nodes) {
          if (key === edge.from || key === edge.to) continue;
          const crosses =
            x1 === x2
              ? x1 > box.x &&
                x1 < box.x + box.width &&
                Math.max(y1, y2) > box.y &&
                Math.min(y1, y2) < box.y + box.height
              : y1 > box.y &&
                y1 < box.y + box.height &&
                Math.max(x1, x2) > box.x &&
                Math.min(x1, x2) < box.x + box.width;
          expect(crosses, `Edge crosses unrelated ${key}`).toBe(false);
        }
      }
    }
  }
  expect(topologyLayoutResult(await elk.layout(topologyLayoutGraph(model)))).toEqual(layout);
});

test('keeps exact resources inside a scope container and routes cross-scope edges', async () => {
  const subjects = ['api', 'worker', 'repository'].map((key) => ({
    ...subject(key),
    kind: 'workload' as const,
    scope: { namespace: key === 'repository' ? 'source' : 'apps', cluster: 'one' },
  }));
  const links = [link('api', 'worker'), link('api', 'repository')].map((edge) => ({
    ...edge,
    kind: 'manages' as const,
  }));
  const group = topologyMapGroups(subjects).find((entry) => entry.name === 'apps')!;
  const model = topologyMapProjection(subjects, links, { expanded: group.key });
  const result = topologyLayoutResult(await new ELK().layout(topologyLayoutGraph(model)));
  const parent = result.nodes.get(group.key)!;
  for (const key of ['api', 'worker']) {
    const child = result.nodes.get(key)!;
    expect(child.x).toBeGreaterThan(parent.x);
    expect(child.y).toBeGreaterThan(parent.y + 40);
    expect(child.x + child.width).toBeLessThan(parent.x + parent.width);
  }
  expect(result.edges.size).toBe(2);
  expect([...result.edges.values()].every((edge) => edge.paths.length > 0)).toBe(true);
  expectAttached(model, result);
});

test.each(['expanded', 'focused', 'overview'] as const)(
  'keeps endpoints and labels aligned in %s resource views',
  async (view) => {
    const subjects = ['controller', 'api', 'database', 'service'].map((key) => ({
      ...subject(key),
      kind: 'workload' as const,
      scope: { namespace: key === 'controller' ? 'control' : 'runtime', cluster: 'one' },
    }));
    const links = [
      link('controller', 'api'),
      link('controller', 'database'),
      link('controller', 'service'),
      link('service', 'api'),
      link('service', 'database'),
      link('database', 'api'),
      link('api', 'database', 'declared'),
    ].map((edge) => ({ ...edge, kind: 'routes_to' as const }));
    const group = topologyMapGroups(subjects).find((entry) => entry.name === 'runtime')!;
    const model = topologyMapProjection(
      subjects,
      links,
      view === 'expanded' ? { expanded: group.key } : view === 'focused' ? { focus: 'api' } : {},
    );
    const elk = new ELK();
    const graph = topologyLayoutGraph(model);
    const actual = topologyLayoutResult(await elk.layout(graph));
    expectAttached(model, actual);
    const rootGraph = topologyLayoutGraph(model);
    rootGraph.layoutOptions!['elk.json.edgeCoords'] = 'ROOT';
    const absolute = topologyLayoutResult(await elk.layout(rootGraph));
    expect(actual.edges).toEqual(absolute.edges);
  },
);

test('accumulates node, route and label offsets through nested JSON parents', () => {
  const result = topologyLayoutResult({
    id: 'root',
    width: 900,
    height: 600,
    children: [
      {
        id: 'outer',
        x: 300,
        y: 100,
        width: 500,
        height: 400,
        children: [
          {
            id: 'inner',
            x: 50,
            y: 40,
            width: 400,
            height: 300,
            children: [
              { id: 'source', x: 20, y: 30, width: 100, height: 60 },
              { id: 'target', x: 220, y: 30, width: 100, height: 60 },
            ],
            edges: [
              {
                id: 'edge',
                sources: ['source'],
                targets: ['target'],
                sections: [
                  { id: 'section', startPoint: { x: 120, y: 60 }, endPoint: { x: 220, y: 60 } },
                ],
                labels: [{ text: 'routes to', x: 140, y: 70, width: 60, height: 20 }],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(result.nodes.get('source')).toMatchObject({ x: 370, y: 170 });
  expect(result.nodes.get('target')).toMatchObject({ x: 570, y: 170 });
  expect(result.edges.get('edge')).toEqual({
    paths: ['M470,200 L570,200'],
    labels: [{ x: 520, y: 224, text: 'routes to' }],
  });
});
