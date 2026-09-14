import { useEffect, useId, useRef, useState } from 'react';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import type { MapLayout, MapProjection } from '../lib/topology-map-layout';
import type { TopologyMapEdge, TopologyMapNode } from '../lib/topology-map';
import { mapRelationLabel } from '../lib/topology-map';
import { evidenceLabels } from './TopologyEvidence';

const control =
  'rounded-md border border-line-strong bg-surface px-3 py-2 text-xs font-medium hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-focus';
const short = (value: string, size = 31) =>
  value.length > size ? `${value.slice(0, size - 1)}…` : value;

/** Render routed topology at a readable scale, with keyboard and pointer navigation. */
export function TopologyMapCanvas({
  model,
  layout,
  selected,
  edgeKey,
  onNode,
  onEdge,
}: {
  model: MapProjection;
  layout: MapLayout;
  selected: string | null;
  edgeKey: string | null;
  onNode: (node: TopologyMapNode) => void;
  onEdge: (edge: TopologyMapEdge) => void;
}) {
  const svg = useRef<SVGSVGElement>(null),
    host = useRef<HTMLDivElement>(null);
  const behavior = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [width, setWidth] = useState(800),
    [transform, setTransform] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const arrow = useId();
  const height = 560;
  const fit = (all = false) => {
    const scale = Math.max(
      all ? 0 : 0.8,
      Math.min(
        1,
        (width - 40) / Math.max(1, layout.width),
        (height - 40) / Math.max(1, layout.height),
      ),
    );
    const focused = !all && selected ? layout.nodes.get(selected) : null;
    return zoomIdentity
      .translate(
        focused && layout.width * scale > width - 40
          ? width / 2 - (focused.x + focused.width / 2) * scale
          : Math.max(20, (width - layout.width * scale) / 2),
        focused && layout.height * scale > height - 40
          ? height / 2 - (focused.y + focused.height / 2) * scale
          : Math.max(20, (height - layout.height * scale) / 2),
      )
      .scale(scale);
  };
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(240, entry!.contentRect.width)),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const z = zoom<SVGSVGElement, unknown>()
      .extent([
        [0, 0],
        [width, height],
      ])
      .scaleExtent([Math.min(0.3, fit(true).k), 3])
      .filter((event) =>
        event.type === 'wheel'
          ? event.ctrlKey
          : !event.button && !event.target.closest?.('[data-map-node]'),
      )
      .on('zoom', (event) => setTransform(event.transform.toString()));
    behavior.current = z;
    select(element).call(z).on('dblclick.zoom', null).call(z.transform, fit(!selected));
    return () => {
      select(element).on('.zoom', null);
      behavior.current = null;
    };
  }, [layout, width]);
  const highlighted = hovered ?? selected;
  const connected = new Set(
    model.edges
      .filter((edge) => edge.from === highlighted || edge.to === highlighted)
      .flatMap((edge) => [edge.from, edge.to]),
  );
  if (highlighted) connected.add(highlighted);
  const names = new Map(model.nodes.map((node) => [node.key, node.name]));
  return (
    <div ref={host} className="relative min-w-0 overflow-hidden bg-canvas">
      <div
        className="flex flex-wrap justify-end gap-1 border-b border-line p-3"
        aria-label="Topology map controls"
      >
        {(['Fit all', 'Readable view'] as const).map((label) => (
          <button
            key={label}
            className={control}
            onClick={() => {
              if (svg.current && behavior.current)
                select(svg.current).call(behavior.current.transform, fit(label === 'Fit all'));
            }}
          >
            {label}
          </button>
        ))}
        {[
          ['Zoom in', 1.3, '+'],
          ['Zoom out', 1 / 1.3, '−'],
        ].map(([label, factor, text]) => (
          <button
            key={label}
            aria-label={String(label)}
            className={control}
            onClick={() => {
              if (svg.current && behavior.current)
                select(svg.current).call(behavior.current.scaleBy, Number(factor));
            }}
          >
            {text}
          </button>
        ))}
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        className="h-[35rem] w-full"
        tabIndex={0}
        role="group"
        aria-label="Topology relationships"
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !behavior.current) return;
          const delta: Record<string, [number, number]> = {
            ArrowLeft: [80, 0],
            ArrowRight: [-80, 0],
            ArrowUp: [0, 80],
            ArrowDown: [0, -80],
          };
          const move = delta[event.key];
          if (move) {
            event.preventDefault();
            select(event.currentTarget).call(behavior.current.translateBy, ...move);
          }
        }}
      >
        <defs>
          <marker
            id={arrow}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0 0 L10 5 L0 10z" fill="context-stroke" />
          </marker>
        </defs>
        <g transform={transform}>
          {model.active &&
            (() => {
              const box = layout.nodes.get(model.active.key);
              return (
                box && (
                  <g aria-label={`Scope container ${model.active.name}`}>
                    <rect
                      x={box.x}
                      y={box.y}
                      width={box.width}
                      height={box.height}
                      rx={16}
                      fill="var(--sre-surface)"
                      stroke="var(--sre-line-strong)"
                      strokeDasharray="6 4"
                    />
                    <text x={box.x + 20} y={box.y + 30} fill="var(--sre-ink-muted)" fontSize={14}>
                      Namespace / scope · {short(model.active.name, 50)}
                    </text>
                  </g>
                )
              );
            })()}
          {model.edges.map((edge) => {
            const route = layout.edges.get(edge.key);
            if (!route) return null;
            const dim = highlighted && edge.from !== highlighted && edge.to !== highlighted;
            const description = `${names.get(edge.from)} → ${mapRelationLabel(edge.kind)} → ${names.get(edge.to)} · ${evidenceLabels[edge.evidence]} · ${edge.relations.length} relationships${edge.staleCount ? ` · ${edge.staleCount} stale` : ''}`;
            return (
              <g
                key={edge.key}
                role="button"
                tabIndex={0}
                aria-label={description}
                className="cursor-pointer focus-visible:outline-2 focus-visible:outline-focus"
                opacity={dim ? 0.2 : 1}
                onClick={() => onEdge(edge)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onEdge(edge);
                  }
                }}
              >
                <title>{description}</title>
                {route.paths.map((path, index) => (
                  <g key={index}>
                    <path d={path} stroke="transparent" strokeWidth={16} fill="none" />
                    <path
                      d={path}
                      stroke={
                        edge.evidence === 'inferred' ? 'var(--sre-warning)' : 'var(--sre-info)'
                      }
                      strokeWidth={edgeKey === edge.key ? 3 : 1.7}
                      fill="none"
                      strokeLinejoin="round"
                      strokeDasharray={
                        edge.evidence === 'inferred'
                          ? '2 5'
                          : edge.evidence === 'declared'
                            ? '8 5'
                            : undefined
                      }
                      markerEnd={`url(#${arrow})`}
                      opacity={edge.stale ? 0.55 : 1}
                    />
                  </g>
                ))}
                {route.labels.map((label, index) => (
                  <text
                    key={index}
                    x={label.x}
                    y={label.y}
                    textAnchor="middle"
                    fontSize={13}
                    fill="var(--sre-ink-muted)"
                    stroke="var(--sre-canvas)"
                    strokeWidth={6}
                    paintOrder="stroke"
                  >
                    {label.text}
                  </text>
                ))}
              </g>
            );
          })}
          {model.nodes.map((node) => {
            const point = layout.nodes.get(node.key);
            if (!point) return null;
            const active = node.key === selected;
            const stale = node.members.some((member) => member.stale);
            const sourceNames = [
              ...new Set(
                node.members.flatMap((member) =>
                  member.sources.map((source) => source.connectorName),
                ),
              ),
            ]
              .sort()
              .join(' + ');
            const kind = node.group
              ? `${node.members.length} resources · ${sourceNames}`
              : node.members[0]!.kind;
            const scope = node.members[0]!.scope;
            const context = node.group
              ? scope.cluster
                ? `Cluster · ${scope.cluster.length > 18 ? `…${scope.cluster.slice(-12)}` : scope.cluster}`
                : scope.project
                  ? `Project ${scope.project}`
                  : 'Source scope'
              : [scope.environment, scope.namespace, sourceNames].filter(Boolean).join(' · ');
            return (
              <g
                key={node.key}
                data-map-node="true"
                transform={`translate(${point.x},${point.y})`}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                opacity={highlighted && !connected.has(node.key) ? 0.35 : 1}
                aria-label={
                  node.group
                    ? `Open group ${node.name} · ${node.members.length} resources · ${node.scope}`
                    : `Inspect ${node.name} · ${node.members[0]!.kind} · ${node.scope}`
                }
                className="cursor-pointer focus-visible:outline-2 focus-visible:outline-focus"
                onMouseEnter={() => setHovered(node.key)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(node.key)}
                onBlur={() => setHovered(null)}
                onClick={() => onNode(node)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onNode(node);
                  }
                }}
              >
                <title>
                  {node.name} · {node.scope} · {kind}
                  {stale ? ' · Stale evidence' : ''}
                </title>
                <rect
                  width={point.width}
                  height={point.height}
                  rx={8}
                  fill="var(--sre-surface)"
                  stroke={active ? 'var(--sre-accent)' : 'var(--sre-line-strong)'}
                  strokeWidth={active ? 2.5 : 1.2}
                />
                <rect
                  width={4}
                  height={point.height}
                  rx={2}
                  fill={node.group ? 'var(--sre-info)' : 'var(--sre-accent)'}
                />
                <text x={16} y={23} fill="var(--sre-ink-muted)" fontSize={12}>
                  {short(kind)}
                </text>
                <text x={16} y={48} fill="var(--sre-ink)" fontSize={15} fontWeight={600}>
                  {short(node.name, 26)}
                </text>
                <text
                  x={16}
                  y={73}
                  fill={stale ? 'var(--sre-warning)' : 'var(--sre-ink-muted)'}
                  fontSize={12}
                >
                  {stale ? 'Stale evidence · ' : ''}
                  {short(context, stale ? 17 : 31)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <p className="border-t border-line px-3 py-2 text-xs text-ink-muted">
        Fit all shows the whole view · Readable view enlarges labels · Drag or use arrow keys to pan
        · Ctrl + scroll to zoom
      </p>
    </div>
  );
}
