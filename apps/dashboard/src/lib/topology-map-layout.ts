import type { ElkNode } from 'elkjs/lib/elk-api';
import { mapRelationLabel, type topologyMapProjection } from './topology-map';

export type MapProjection = ReturnType<typeof topologyMapProjection>;
export interface MapLayout {
  width: number;
  height: number;
  nodes: Map<string, { x: number; y: number; width: number; height: number; container: boolean }>;
  edges: Map<string, { paths: string[]; labels: { x: number; y: number; text: string }[] }>;
}

/** Give the layout engine typed edges and scope containers, not arbitrary grid coordinates. */
export function topologyLayoutGraph(model: MapProjection): ElkNode {
  const children: ElkNode[] = model.nodes.map((node) => ({ id: node.key, width: 240, height: 92 }));
  const contained = new Set(model.nodes.filter((node) => node.parent).map((node) => node.key));
  const parent =
    model.active && contained.size
      ? {
          id: model.active.key,
          children: children.filter((node) => contained.has(node.id)),
          layoutOptions: { 'elk.padding': '[top=58,left=24,bottom=24,right=24]' },
        }
      : null;
  return {
    id: 'topology-root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': model.focused ? 'DOWN' : 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      // The canvas traversal offsets edges by their JSON parent, not ELK's implicit container.
      'elk.json.edgeCoords': 'PARENT',
      'elk.spacing.nodeNode': '36',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
      'elk.spacing.edgeNode': '24',
      'elk.spacing.edgeEdge': '16',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
    },
    children: [...children.filter((node) => !contained.has(node.id)), ...(parent ? [parent] : [])],
    edges: model.edges.map((edge) => {
      const text = `${mapRelationLabel(edge.kind)}${edge.relations.length > 1 ? ` ×${edge.relations.length}` : ''}`;
      return {
        id: edge.key,
        sources: [edge.from],
        targets: [edge.to],
        labels: [{ text, width: text.length * 7 + 12, height: 20 }],
      };
    }),
  };
}

/** Resolve JSON-parent-relative layout coordinates to the canvas while preserving routed paths. */
export function topologyLayoutResult(graph: ElkNode): MapLayout {
  const nodes: MapLayout['nodes'] = new Map(),
    edges: MapLayout['edges'] = new Map();
  const visit = (parent: ElkNode, x: number, y: number) => {
    for (const edge of parent.edges ?? []) {
      edges.set(edge.id, {
        paths: (edge.sections ?? []).map((section) =>
          [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
            .map((point, index) => `${index ? 'L' : 'M'}${point.x + x},${point.y + y}`)
            .join(' '),
        ),
        labels: (edge.labels ?? []).map((label) => ({
          x: (label.x ?? 0) + x + (label.width ?? 0) / 2,
          y: (label.y ?? 0) + y + 14,
          text: label.text ?? '',
        })),
      });
    }
    for (const node of parent.children ?? []) {
      const nx = x + (node.x ?? 0),
        ny = y + (node.y ?? 0);
      nodes.set(node.id, {
        x: nx,
        y: ny,
        width: node.width ?? 0,
        height: node.height ?? 0,
        container: Boolean(node.children?.length),
      });
      visit(node, nx, ny);
    }
  };
  visit(graph, 0, 0);
  return { width: graph.width ?? 0, height: graph.height ?? 0, nodes, edges };
}
