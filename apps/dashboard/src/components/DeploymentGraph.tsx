import { useEffect, useId, useRef, useState } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { drag, type D3DragEvent } from 'd3-drag';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import type { GraphNode, TopologyGraph, BlastRadius } from '../lib/topology';
import { blastHighlights } from '../lib/topology';
import {
  TopologyLegend,
  HIGHLIGHT_STROKE,
  EDGE_STROKE,
  CIRCUIT_STROKE,
  serviceStatusColour,
} from './TopologyLegend';
export { serviceStatusColour } from './TopologyLegend';

const NODE_R = 13;
const RING_R = NODE_R + 5;

interface SimNode extends SimulationNodeDatum, GraphNode {}
interface SimLink extends SimulationLinkDatum<SimNode> {
  syncType: string;
  circuitBreaker: boolean | 'mixed';
  scope: string;
}

/** Read a link endpoint that d3-force has resolved from an id string to the node object. */
function endpoint(e: SimNode | string | number): SimNode | null {
  return typeof e === 'object' ? e : null;
}

export interface DeploymentGraphProps {
  graph: TopologyGraph;
  blastRadius?: BlastRadius | null;
  selected?: string | null;
  onSelect?: (node: GraphNode) => void;
  width?: number;
  height?: number;
}

/**
 * A force-directed service graph. d3-force computes the layout (settled synchronously so the first
 * paint is stable and deterministic in tests); React renders the nodes/edges as SVG elements. Node
 * fill is current operational status; an outer ring marks a blast-radius highlight. d3-drag
 * re-heats the simulation for a dragged node; d3-zoom pans/zooms the whole scene.
 */
export function DeploymentGraph({
  graph,
  blastRadius,
  selected,
  onSelect,
  width = 820,
  height = 560,
}: DeploymentGraphProps) {
  const arrowId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const nodesLayerRef = useRef<SVGGElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [links, setLinks] = useState<SimLink[]>([]);
  const [transform, setTransform] = useState('');

  const highlights = blastHighlights(blastRadius);
  // Read mutable operational fields from the LIVE graph prop, not the settled node copies. The layout
  // is frozen on the node/edge set, but a poll or incident update must still recolour the service.
  const liveByName = new Map(graph.nodes.map((n) => [n.name, n]));

  // Build + settle the simulation when node identity or visible edge metadata changes. The scalar key
  // avoids relayout for an equal polled graph while keeping sync and circuit-breaker styling current.
  const nodeKey = JSON.stringify(graph.nodes.map((n) => n.name).sort());
  const edgeKey = JSON.stringify(
    graph.edges
      .map((edge) => [
        edge.upstream,
        edge.downstream,
        edge.syncType,
        edge.circuitBreaker,
        edge.protocol,
        edge.environment,
      ])
      .sort(),
  );
  useEffect(() => {
    const simNodes: SimNode[] = [...graph.nodes]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => ({ ...n }));
    const present = new Set(simNodes.map((n) => n.name));
    const groups = new Map<string, typeof graph.edges>();
    for (const edge of graph.edges) {
      if (!present.has(edge.upstream) || !present.has(edge.downstream)) continue;
      const key = JSON.stringify([edge.upstream, edge.downstream]);
      groups.set(key, [...(groups.get(key) ?? []), edge]);
    }
    const simLinks: SimLink[] = [...groups.values()].map((edges) => ({
      source: edges[0]!.upstream,
      target: edges[0]!.downstream,
      syncType: edges.every((edge) => edge.syncType === edges[0]!.syncType)
        ? edges[0]!.syncType
        : 'mixed',
      circuitBreaker: edges.every((edge) => edge.circuitBreaker === edges[0]!.circuitBreaker)
        ? edges[0]!.circuitBreaker
        : 'mixed',
      scope: [...new Set(edges.map((edge) => edge.environment || 'environment unspecified'))].join(
        ', ',
      ),
    }));

    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.name)
          .distance(160),
      )
      .force('charge', forceManyBody().strength(-320))
      .force('center', forceCenter(width / 2, height / 2))
      .force('x', forceX(width / 2).strength(0.08))
      .force('y', forceY(height / 2).strength(0.08))
      .force(
        'collide',
        forceCollide<SimNode>((node) => Math.max(NODE_R + 25, Math.min(node.name.length * 4, 160))),
      );

    sim.stop(); // halt the auto-timer; settle synchronously instead (deterministic, no post-unmount ticks)
    sim.tick(300);
    // Live re-render only while the internal timer runs (i.e. during a drag re-heat, below).
    sim.on('tick', () => setNodes([...simNodes]));

    simRef.current = sim;
    simNodesRef.current = simNodes;
    setNodes([...simNodes]);
    setLinks([...simLinks]);

    return () => {
      sim.on('tick', null);
      sim.stop();
      simRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKey, edgeKey, width, height]);

  // d3-zoom: pan/zoom the whole scene by transforming the root <g>.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const z = zoom<SVGSVGElement, unknown>()
      .extent([
        [0, 0],
        [width, height],
      ])
      .scaleExtent([0.25, 4])
      .on('zoom', (ev: D3ZoomEvent<SVGSVGElement, unknown>) => {
        const { x, y, k } = ev.transform;
        setTransform(`translate(${x},${y}) scale(${k})`);
      });
    zoomRef.current = z;
    select(svg).call(z);
    return () => {
      select(svg).on('.zoom', null);
      zoomRef.current = null;
    };
  }, [height, width]);

  // d3-drag: dragging a node re-heats the simulation and pins the node under the pointer. The drag
  // subject is resolved from the circle's data-node attribute (React owns the DOM, so d3 has no bound
  // datum). Rebind when a graph or viewport change replaces the simulation, but not on every tick, so
  // an active drag gesture is never rebound mid-stream.
  const nodesReady = nodes.length > 0;
  useEffect(() => {
    const layer = nodesLayerRef.current;
    const sim = simRef.current;
    if (!layer || !sim || !nodesReady) return;
    const byName = new Map(simNodesRef.current.map((n) => [n.name, n]));
    const behavior = drag<SVGCircleElement, unknown, SimNode>()
      .subject(function () {
        const name = this.getAttribute('data-node') ?? '';
        return byName.get(name) ?? ({ name } as SimNode);
      })
      .on('start', (ev: D3DragEvent<SVGCircleElement, unknown, SimNode>) => {
        if (!ev.active) sim.alphaTarget(0.3).restart();
        ev.subject.fx = ev.subject.x;
        ev.subject.fy = ev.subject.y;
      })
      .on('drag', (ev: D3DragEvent<SVGCircleElement, unknown, SimNode>) => {
        ev.subject.fx = ev.x;
        ev.subject.fy = ev.y;
      })
      .on('end', (ev: D3DragEvent<SVGCircleElement, unknown, SimNode>) => {
        if (!ev.active) sim.alphaTarget(0);
        ev.subject.fx = null;
        ev.subject.fy = null;
      });
    const sel = select(layer).selectAll<SVGCircleElement, unknown>('circle[data-node]');
    sel.call(behavior);
    return () => {
      sel.on('.drag', null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeKey, height, nodeKey, nodesReady, width]);

  const fitServices = () => {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    const simulatedNodes = simNodesRef.current;
    if (!svg || !behavior || simulatedNodes.length === 0) return;

    const xs = simulatedNodes.map((node) => node.x ?? width / 2);
    const ys = simulatedNodes.map((node) => node.y ?? height / 2);
    const minX = Math.min(
      ...simulatedNodes.map((node, index) => xs[index]! - Math.max(RING_R, node.name.length * 3.5)),
    );
    const maxX = Math.max(
      ...simulatedNodes.map((node, index) => xs[index]! + Math.max(RING_R, node.name.length * 3.5)),
    );
    const minY = Math.min(...ys) - RING_R;
    const maxY = Math.max(...ys) + RING_R + 16;
    const contentWidth = Math.max(maxX - minX, RING_R * 2);
    const contentHeight = Math.max(maxY - minY, RING_R * 2);
    const padding = 48;
    const scale = Math.min(
      4,
      Math.max(
        0.25,
        Math.min((width - padding * 2) / contentWidth, (height - padding * 2) / contentHeight),
      ),
    );
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const fitted = zoomIdentity
      .translate(width / 2, height / 2)
      .scale(scale)
      .translate(-centerX, -centerY);
    select(svg).call(behavior.transform, fitted);
  };

  const resetView = () => {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (svg && behavior) select(svg).call(behavior.transform, zoomIdentity);
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap gap-2" aria-label="Map view controls">
        <button
          type="button"
          onClick={fitServices}
          className="sre-action focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Fit services
        </button>
        <button
          type="button"
          onClick={resetView}
          className="sre-action focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Reset view
        </button>
      </div>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label="Service dependency graph"
        className="h-auto w-full max-w-full rounded border border-line bg-surface"
      >
        <defs>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="var(--sre-ink-faint)" />
          </marker>
        </defs>
        <g transform={transform || undefined}>
          <g>
            {links.map((link) => {
              const source = endpoint(link.source);
              const target = endpoint(link.target);
              if (!source || !target) return null;
              const isAsync = link.syncType === 'async';
              const dx = (target.x ?? 0) - (source.x ?? 0);
              const dy = (target.y ?? 0) - (source.y ?? 0);
              const length = Math.hypot(dx, dy) || 1;
              const ux = dx / length;
              const uy = dy / length;
              const offset = graph.edges.some(
                (edge) => edge.upstream === target.name && edge.downstream === source.name,
              )
                ? 5
                : 0;
              const margin = Math.min(RING_R + 2, length / 2);
              return (
                <line
                  key={`${source.name}->${target.name}`}
                  data-edge={`${source.name}->${target.name}`}
                  data-sync={link.syncType}
                  data-circuit-breaker={String(link.circuitBreaker)}
                  x1={(source.x ?? 0) + ux * margin - uy * offset}
                  y1={(source.y ?? 0) + uy * margin + ux * offset}
                  x2={(target.x ?? 0) - ux * margin - uy * offset}
                  y2={(target.y ?? 0) - uy * margin + ux * offset}
                  stroke={
                    link.circuitBreaker === 'mixed'
                      ? 'var(--sre-warning-solid)'
                      : link.circuitBreaker
                        ? CIRCUIT_STROKE
                        : EDGE_STROKE
                  }
                  strokeWidth={1.5}
                  strokeDasharray={
                    link.syncType === 'mixed' ? '8 3 2 3' : isAsync ? '4 3' : undefined
                  }
                  markerEnd={`url(#${arrowId})`}
                >
                  <title>
                    {source.name} calls {target.name}, {link.syncType}
                    {link.circuitBreaker === 'mixed'
                      ? ', mixed circuit-breaker declarations'
                      : link.circuitBreaker
                        ? ', circuit breaker'
                        : ''}
                    {`, ${link.scope}`}
                  </title>
                </line>
              );
            })}
          </g>
          <g ref={nodesLayerRef}>
            {nodes.map((node) => {
              const liveNode = liveByName.get(node.name) ?? node;
              const highlight = highlights.get(node.name);
              const ringStroke = highlight ? HIGHLIGHT_STROKE[highlight] : null;
              const cx = node.x ?? 0;
              const cy = node.y ?? 0;
              return (
                <g
                  key={node.name}
                  data-node-group={node.name}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.name}, ${liveNode.status ?? 'unknown'}`}
                  aria-pressed={selected === node.name}
                  className="cursor-pointer focus:outline-2 focus:outline-offset-2 focus:outline-focus"
                  onClick={() => onSelect?.(liveNode)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onSelect?.(liveNode);
                  }}
                >
                  {ringStroke && (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={RING_R}
                      fill="none"
                      stroke={ringStroke}
                      strokeWidth={2.5}
                      data-highlight={highlight}
                    />
                  )}
                  <circle
                    data-node={node.name}
                    cx={cx}
                    cy={cy}
                    r={NODE_R}
                    fill={serviceStatusColour(liveNode.status)}
                    stroke={selected === node.name ? 'var(--sre-ink)' : 'var(--sre-surface)'}
                    strokeWidth={selected === node.name ? 2.5 : 1.5}
                  />
                  <text
                    x={cx}
                    y={cy + RING_R + 12}
                    textAnchor="middle"
                    className="pointer-events-none select-none fill-ink-secondary text-[14px]"
                  >
                    {node.name}
                  </text>
                </g>
              );
            })}
          </g>
        </g>
      </svg>
      <TopologyLegend />
    </div>
  );
}
