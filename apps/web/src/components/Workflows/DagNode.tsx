import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { DagFlowNode } from "../../lib/dagLayout.ts";

function formatDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Maps node type → label + class. Falls back to a generic chip for unknown
// types so future node kinds need no UI work beyond a CSS rule.
function typeChip(type: string): { className: string; label: string } {
  const lower = type.toLowerCase();
  if (lower === "bash") return { className: "bash", label: "BASH" };
  if (lower === "prompt") return { className: "prompt", label: "PROMPT" };
  if (lower === "approval") return { className: "approval", label: "APPROVAL" };
  return { className: "generic", label: lower.toUpperCase() };
}

// Custom xyflow node. xyflow gives us `data` already shaped by `dagLayout`;
// the visual rules (border tint, glyph) live in app.css under `.dag-node`.
export function DagNode({ data }: NodeProps<DagFlowNode>) {
  const status = data.status;
  const chip = typeChip(data.type);
  const dur = formatDuration(data.durationMs);

  // xyflow needs explicit handles for the smoothstep edges to anchor. Top
  // for incoming (since rankdir is TB), bottom for outgoing. Both are
  // hidden visually — the edge stroke meets the box edge naturally.
  return (
    <div className={`dag-node ${status}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} className="dag-handle" />
      <div className="dn-row">
        <span className={`dn-type ${chip.className}`}>{chip.label}</span>
        <span className="dn-name">{data.nodeId}</span>
      </div>
      <span className="dn-meta">
        {status === "running" && <span className="runspin" aria-hidden="true" />}
        {status === "succeeded" && <span className="check">✓</span>}
        {status === "failed" && <span className="cross">✗</span>}
        {status === "awaiting" && <span className="awaiting-glyph">◆</span>}
        {dur && <span>{dur}</span>}
        {!dur && status === "pending" && <span>queued</span>}
        {!dur && status === "awaiting" && <span>awaiting</span>}
      </span>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="dag-handle"
      />
    </div>
  );
}
