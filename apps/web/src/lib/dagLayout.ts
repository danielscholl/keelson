import dagre from "@dagrejs/dagre";
import type { WorkflowNodeStatus, WorkflowNodeSummary } from "@keelson/shared";
import type { Edge, Node as RFNode } from "@xyflow/react";

// Box dims match Archon's recipe — keeps fan-outs/convergence laying out
// the same way operators see in workflow editors they've seen elsewhere.
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 80;

// UI-side status surface. The wire schema's `workflowNodeStatusSchema` only
// carries terminal states (succeeded / failed / skipped); the executor's
// `node_started` frame moves a row to `running` and our pre-run state is
// `pending`. `cancelled` falls out of `run_done.status === "cancelled"`
// applied to the still-running node. `awaiting` covers HITL approval pauses.
export type NodeViewStatus =
  | "pending"
  | "running"
  | WorkflowNodeStatus // "succeeded" | "failed" | "skipped"
  | "cancelled"
  | "awaiting";

export interface DagNodeData {
  nodeId: string;
  type: string;
  status: NodeViewStatus;
  durationMs?: number | null;
  // `when:` / `trigger_rule` are surfaced as small footer chips on hover
  // so operators can tell why a node skipped without re-reading the YAML.
  when?: string;
  triggerRule?: string;
  [key: string]: unknown;
}

export interface DagEdgeData {
  status: NodeViewStatus;
  [key: string]: unknown;
}

export type DagFlowNode = RFNode<DagNodeData, "dagNode">;
export type DagFlowEdge = Edge<DagEdgeData>;

// Pure layout helper — given xyflow nodes/edges with id+data, returns the
// same nodes with `position` populated by dagre. Falls back to the input
// (which may have x:0,y:0) on failure so the graph still renders.
export function layoutWithDagre(
  nodes: DagFlowNode[],
  edges: DagFlowEdge[],
): { nodes: DagFlowNode[]; edges: DagFlowEdge[] } {
  try {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: "TB", ranksep: 80, nodesep: 40 });

    for (const node of nodes) {
      g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    for (const edge of edges) {
      g.setEdge(edge.source, edge.target);
    }

    dagre.layout(g);

    const layoutedNodes = nodes.map((node) => {
      const pos = g.node(node.id) as { x: number; y: number } | undefined;
      if (!pos) return node;
      return {
        ...node,
        position: {
          x: pos.x - NODE_WIDTH / 2,
          y: pos.y - NODE_HEIGHT / 2,
        },
      };
    });
    return { nodes: layoutedNodes, edges };
  } catch (err) {
    console.error("[dagLayout] dagre failed, using fallback positions:", err);
    return { nodes, edges };
  }
}

export interface DagLayoutInput {
  nodes: ReadonlyArray<WorkflowNodeSummary>;
  // Caller maps real node status by id; absent ids default to "pending".
  // Decoupling layout from frame accumulation keeps this pure + memo-friendly.
  statusByNode?: ReadonlyMap<string, NodeViewStatus>;
  durationByNode?: ReadonlyMap<string, number>;
}

// Build positioned xyflow nodes + edges from the shared schema. Edges adopt
// the *target* node's status so an edge into a failed node turns red even
// while the source already succeeded — matches the mockup.
export function dagLayout({ nodes, statusByNode, durationByNode }: DagLayoutInput): {
  nodes: DagFlowNode[];
  edges: DagFlowEdge[];
} {
  const rfNodes: DagFlowNode[] = nodes.map((n, i) => ({
    id: n.id,
    type: "dagNode",
    position: { x: 0, y: i * 100 },
    data: {
      nodeId: n.id,
      type: n.type,
      status: statusByNode?.get(n.id) ?? "pending",
      durationMs: durationByNode?.get(n.id),
      when: n.when,
      triggerRule: n.triggerRule,
    },
  }));

  const rfEdges: DagFlowEdge[] = [];
  for (const n of nodes) {
    const targetStatus = statusByNode?.get(n.id) ?? "pending";
    for (const dep of n.dependsOn ?? []) {
      rfEdges.push({
        id: `${dep}->${n.id}`,
        source: dep,
        target: n.id,
        type: "smoothstep",
        data: { status: targetStatus },
      });
    }
  }

  return layoutWithDagre(rfNodes, rfEdges);
}

// Kahn's algorithm — true when a cycle exists. Mirrors Archon's helper so
// future schema validation can reuse the same primitive.
export function hasCycle(
  nodeIds: ReadonlySet<string>,
  edges: ReadonlyArray<{ source: string; target: string }>,
): boolean {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target) {
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
      adjacency.get(edge.source)?.push(edge.target);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }
  let visited = 0;
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    visited++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }
  return visited < nodeIds.size;
}

// Layer index per node — max depth across convergent paths, not parent+1.
// Exported for future polish (collapsing layers, depth indicators).
export function computeTopologicalLayers(
  nodes: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ source: string; target: string }>,
): Map<string, number> {
  const layers = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adjacency.set(n.id, []);
  }
  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    adjacency.get(edge.source)?.push(edge.target);
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
      layers.set(id, 0);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    const currentLayer = layers.get(current) ?? 0;
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);

      const existing = layers.get(neighbor);
      const candidate = currentLayer + 1;
      if (existing === undefined || candidate > existing) {
        layers.set(neighbor, candidate);
      }
      if (newDegree === 0) queue.push(neighbor);
    }
  }
  return layers;
}
