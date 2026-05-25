import type { NodeViewStatus } from "../../lib/dagLayout.ts";

// Pill renderer shared by run header + recent-runs table + HITL callouts.
// Status → class mapping uses `.status-pill.{state}` lookups so future
// Tailwind/CSS-only consumers can pick up the class set directly.
export interface StatusBadgeProps {
  status: NodeViewStatus | "running" | "pending";
  // Optional override label so the run header can say "succeeded" while
  // a child row says "completed" — both map to .completed for color.
  label?: string;
}

const LABELS: Record<NodeViewStatus, string> = {
  pending: "pending",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
  awaiting: "awaiting",
};

// `succeeded` maps to `.completed` so designers see one canonical visual
// state across both pill and dot.
function statusClass(status: NodeViewStatus): string {
  switch (status) {
    case "succeeded":
      return "completed";
    default:
      return status;
  }
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const klass = statusClass(status as NodeViewStatus);
  return (
    <span className={`status-pill ${klass}`}>
      {label ?? LABELS[status as NodeViewStatus] ?? status}
    </span>
  );
}

// Small dot-only variant — for inline contexts where the pill would crowd
// the row (catalog list items, sidebar entries).
export function StatusDot({ status }: { status: NodeViewStatus }) {
  return <span className={`status-dot ${statusClass(status)}`} aria-hidden="true" />;
}
