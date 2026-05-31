import dagre from "@dagrejs/dagre";
import type { CanvasGraphView } from "@keelson/shared";
import type { Edge, Node as RFNode } from "@xyflow/react";

// Generic node-link layout for `kind: "view"` graph payloads. Mirrors the
// workflow DAG's dagre recipe (lib/dagLayout.ts) but stays domain-free — no
// workflow-node status, just id/label/kind the producer baked in.
export const VIEW_NODE_WIDTH = 180;
export const VIEW_NODE_HEIGHT = 56;

export interface ViewGraphNodeData {
  label: string;
  kind?: string;
  [key: string]: unknown;
}
export type ViewGraphFlowNode = RFNode<ViewGraphNodeData, "viewGraphNode">;

// Pure: parsed graph view → positioned xyflow nodes + edges. Edges to/from an
// unknown node id are dropped so a dangling edge can't spawn a phantom dagre
// node. Falls back to seed positions if dagre throws.
export function viewGraphLayout(view: CanvasGraphView): {
  nodes: ViewGraphFlowNode[];
  edges: Edge[];
} {
  const nodeIds = new Set(view.nodes.map((n) => n.id));
  const liveEdges = view.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  const nodes: ViewGraphFlowNode[] = view.nodes.map((n, i) => ({
    id: n.id,
    type: "viewGraphNode",
    position: { x: 0, y: i * 90 },
    data: { label: n.label ?? n.id, kind: n.kind },
  }));
  const edges: Edge[] = liveEdges.map((e, i) => ({
    id: `${e.source}->${e.target}#${i}`,
    source: e.source,
    target: e.target,
    label: e.label,
    type: "smoothstep",
  }));

  try {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: "TB", ranksep: 70, nodesep: 40 });
    for (const n of nodes) g.setNode(n.id, { width: VIEW_NODE_WIDTH, height: VIEW_NODE_HEIGHT });
    for (const e of liveEdges) g.setEdge(e.source, e.target);
    dagre.layout(g);
    const positioned = nodes.map((n) => {
      const pos = g.node(n.id) as { x: number; y: number } | undefined;
      if (!pos) return n;
      return {
        ...n,
        position: { x: pos.x - VIEW_NODE_WIDTH / 2, y: pos.y - VIEW_NODE_HEIGHT / 2 },
      };
    });
    return { nodes: positioned, edges };
  } catch (err) {
    console.error("[viewGraphLayout] dagre failed, using fallback positions:", err);
    return { nodes, edges };
  }
}
