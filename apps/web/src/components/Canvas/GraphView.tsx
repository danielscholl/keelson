import type { CanvasGraphView } from "@keelson/shared";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { type ViewGraphFlowNode, viewGraphLayout } from "../../lib/viewGraphLayout.ts";

// Generic graph node — label + an optional category chip the producer baked
// into `kind`. Colour stays neutral; the base never enumerates kinds.
function ViewGraphNode({ data }: NodeProps<ViewGraphFlowNode>) {
  return (
    <div className="view-graph-node">
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="view-graph-handle"
      />
      {data.kind && <span className="vgn-kind">{data.kind}</span>}
      <span className="vgn-label">{data.label}</span>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="view-graph-handle"
      />
    </div>
  );
}

const nodeTypes: NodeTypes = { viewGraphNode: ViewGraphNode };

function GraphViewInner({ view }: { view: CanvasGraphView }) {
  const { nodes, edges } = useMemo(() => viewGraphLayout(view), [view]);
  return (
    <div className="canvas-view-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
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
    </div>
  );
}

// ReactFlowProvider wraps each instance so multiple graphs on a page don't
// share pan/zoom state (matches DagGraph).
export function GraphView({ view }: { view: CanvasGraphView }) {
  return (
    <ReactFlowProvider>
      <GraphViewInner view={view} />
    </ReactFlowProvider>
  );
}
