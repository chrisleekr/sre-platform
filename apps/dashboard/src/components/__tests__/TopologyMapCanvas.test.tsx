// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TopologyMapCanvas } from '../TopologyMapCanvas';
import { topologyMapProjection } from '../../lib/topology-map';
import type { MapLayout } from '../../lib/topology-map-layout';
import { discoveryFixture } from './topology-discovery.fixture';
import './topology-map-browser.fixture';
import ELK from 'elkjs/lib/elk.bundled.js';
import { topologyLayoutGraph, topologyLayoutResult } from '../../lib/topology-map-layout';

afterEach(cleanup);

test('renders the routed geometry and destination arrowheads in the same pan and zoom frame as nodes', async () => {
  const graph = discoveryFixture().operational;
  const model = topologyMapProjection(graph.subjects, graph.relations, { focus: 'api' });
  const layout = topologyLayoutResult(await new ELK().layout(topologyLayoutGraph(model)));
  const onEdge = vi.fn();
  render(
    <TopologyMapCanvas
      model={model}
      layout={layout}
      selected={null}
      edgeKey={null}
      onNode={vi.fn()}
      onEdge={onEdge}
    />,
  );
  const svg = screen.getByRole('group', { name: 'Topology relationships' });
  const frame = svg.querySelector(':scope > g')!;
  const assertGeometry = () => {
    const paths = [...frame.querySelectorAll('path[marker-end]')];
    expect(paths.map((path) => path.getAttribute('d'))).toEqual(
      model.edges.flatMap((edge) => layout.edges.get(edge.key)!.paths),
    );
    expect(paths).toHaveLength(model.edges.length);
    for (const path of paths) {
      const marker = svg.querySelector('marker')!;
      expect(path.getAttribute('marker-end')).toBe(`url(#${marker.id})`);
      expect(path.hasAttribute('marker-start')).toBe(false);
      expect(marker.getAttribute('orient')).toBe('auto');
      expect(path.parentElement!.parentElement!.parentElement).toBe(frame);
      expect(path.parentElement!.hasAttribute('transform')).toBe(false);
    }
    for (const node of frame.querySelectorAll('[data-map-node]'))
      expect(node.parentElement).toBe(frame);
  };
  assertGeometry();
  const initial = frame.getAttribute('transform');
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(frame.getAttribute('transform')).not.toBe(initial);
  assertGeometry();
  fireEvent.keyDown(svg, { key: 'ArrowRight' });
  assertGeometry();
  fireEvent.click(screen.getByRole('button', { name: 'Fit all' }));
  assertGeometry();
  fireEvent.click(frame.querySelector('g[role="button"]')!);
  expect(onEdge).toHaveBeenCalledWith(model.edges[0]);
});

function canvas(selected: string | null = null) {
  const graph = discoveryFixture().operational;
  const model = topologyMapProjection(graph.subjects, graph.relations, { focus: 'api' });
  const layout: MapLayout = {
    width: 6000,
    height: 9000,
    nodes: new Map(
      model.nodes.map((node, index) => [
        node.key,
        {
          x: 1500 + index * 700,
          y: 3000 + index * 1500,
          width: 240,
          height: 92,
          container: false,
        },
      ]),
    ),
    edges: new Map(),
  };
  render(
    <TopologyMapCanvas
      model={model}
      layout={layout}
      selected={selected}
      edgeKey={null}
      onNode={vi.fn()}
      onEdge={vi.fn()}
    />,
  );
  const svg = screen.getByRole('group', { name: 'Topology relationships' });
  const transform = () => {
    const value = svg.querySelector(':scope > g')!.getAttribute('transform')!;
    const [, x, y, scale] = value.match(/translate\(([^,]+),([^)]+)\) scale\(([^)]+)\)/)!;
    return { x: Number(x), y: Number(y), scale: Number(scale) };
  };
  return { layout, transform };
}

test('fits the entire overview, including layouts smaller than the usual zoom limit', () => {
  const { layout, transform } = canvas();
  const assertFits = () => {
    const { x, y, scale } = transform();
    expect(scale).toBeLessThan(0.3);
    expect(x).toBeGreaterThanOrEqual(20);
    expect(y).toBeGreaterThanOrEqual(20);
    expect(x + layout.width * scale).toBeLessThanOrEqual(780);
    expect(y + layout.height * scale).toBeLessThanOrEqual(540);
  };
  assertFits();
  fireEvent.click(screen.getByRole('button', { name: 'Readable view' }));
  expect(transform().scale).toBe(0.8);
  fireEvent.click(screen.getByRole('button', { name: 'Fit all' }));
  assertFits();
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
  assertFits();
});

test('readable view centres the selected resource but fit all does not crop its neighbours', () => {
  const { layout, transform } = canvas('api');
  const assertFocused = () => {
    const { x, y, scale } = transform();
    const node = layout.nodes.get('api')!;
    expect(scale).toBe(0.8);
    expect(x + (node.x + node.width / 2) * scale).toBeCloseTo(400);
    expect(y + (node.y + node.height / 2) * scale).toBeCloseTo(280);
  };
  assertFocused();
  fireEvent.click(screen.getByRole('button', { name: 'Fit all' }));
  const { x, y, scale } = transform();
  for (const node of layout.nodes.values()) {
    expect(x + node.x * scale).toBeGreaterThanOrEqual(0);
    expect(y + node.y * scale).toBeGreaterThanOrEqual(0);
    expect(x + (node.x + node.width) * scale).toBeLessThanOrEqual(800);
    expect(y + (node.y + node.height) * scale).toBeLessThanOrEqual(560);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Readable view' }));
  assertFocused();
});
