import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import { useMemo } from "react";
import "@xyflow/react/dist/style.css";
import type { WorkflowNodeSummary } from "@keelson/shared";

import { dagLayout, type NodeViewStatus } from "../../lib/dagLayout.ts";
import { DagNode } from "./DagNode.tsx";

export interface DagGraphProps {
  nodes: ReadonlyArray<WorkflowNodeSummary>;
  statusByNode: ReadonlyMap<string, NodeViewStatus>;
  durationByNode?: ReadonlyMap<string, number>;
}

const nodeTypes: NodeTypes = { dagNode: DagNode };

// Maps a node's status onto its incoming edges so a fan-in that's half-
// terminal looks half-complete at a glance.
function decorateEdges(edges: ReadonlyArray<Edge<{ status: NodeViewStatus }>>): Edge[] {
  return edges.map((e) => ({
    ...e,
    className: `dag-edge ${e.data?.status ?? "pending"}`,
    animated: e.data?.status === "running" || e.data?.status === "awaiting",
  }));
}

function DagGraphInner({ nodes, statusByNode, durationByNode }: DagGraphProps) {
  // Re-layout when the topology changes or any status flips. Status alone
  // doesn't change positions but does flow into nodeData/edgeData. Dagre
  // is fast enough on the 2-7 nodes typical for v1 workflows that we
  // don't bother memoizing the positions independently.
  const { nodes: rfNodes, edges: rfEdges } = useMemo(
    () => dagLayout({ nodes, statusByNode, durationByNode }),
    [nodes, statusByNode, durationByNode],
  );

  const decorated = useMemo(() => decorateEdges(rfEdges), [rfEdges]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={decorated}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2, includeHiddenNodes: false }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnScroll
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border-soft)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

// Wraps with ReactFlowProvider so multiple instances on a page (catalog
// preview + run-view graph, future) don't share xyflow state. Without
// this the second graph would silently inherit pan/zoom from the first.
export function DagGraph(props: DagGraphProps) {
  return (
    <ReactFlowProvider>
      <DagGraphInner {...props} />
    </ReactFlowProvider>
  );
}
