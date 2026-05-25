import type { WorkflowDetail, WorkflowSummary } from "@keelson/shared";
import { useMemo } from "react";

import { parseWorkflowDescription } from "../../lib/parseWorkflowDescription.ts";

export interface WorkflowCardProps {
  workflow: WorkflowSummary;
  // Optional detail (with nodes[]) so the card can show node-type chips
  // and `Use when:` / `Does:` sections without a second fetch. Falls back
  // to the summary when detail isn't preloaded.
  detail?: WorkflowDetail;
  onRun: () => void;
}

// Title-cases a slug: `status-report` → `Status Report`.
function humanTitle(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(" ");
}

function nodeTypeChips(detail: WorkflowDetail | undefined): Array<{
  type: string;
  count: number;
}> {
  if (!detail) return [];
  const counts = new Map<string, number>();
  for (const n of detail.nodes) {
    counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([type, count]) => ({ type, count }));
}

export function WorkflowCard({ workflow, detail, onRun }: WorkflowCardProps) {
  const parsed = useMemo(
    () => parseWorkflowDescription(workflow.description),
    [workflow.description],
  );
  const chips = nodeTypeChips(detail);

  // First letter of slug — same pattern as Archon's iconography but with
  // a CSS gradient instead of the upstream emoji set. Operator-recognizable
  // at a glance without copying their icon vocabulary.
  const initial = workflow.name.slice(0, 2).toUpperCase();

  return (
    <article className="workflow-card">
      <div className="wc-head">
        <div className="wc-icon" aria-hidden="true">
          {initial}
        </div>
        <div>
          <div className="wc-title">{humanTitle(workflow.name)}</div>
          <div className="wc-slug">{workflow.name}</div>
        </div>
      </div>
      <div className="wc-grid">
        {parsed.useWhen && (
          <div className="wc-section">
            <div className="wc-section-label">Use when</div>
            <div className="wc-section-body">{parsed.useWhen}</div>
          </div>
        )}
        {parsed.does && (
          <div className="wc-section">
            <div className="wc-section-label">Does</div>
            <div className="wc-section-body">{parsed.does}</div>
          </div>
        )}
        {parsed.triggers && (
          <div className="wc-section">
            <div className="wc-section-label">Triggers</div>
            <div className="wc-section-body">{parsed.triggers}</div>
          </div>
        )}
        {parsed.notFor && (
          <div className="wc-section">
            <div className="wc-section-label">Not for</div>
            <div className="wc-section-body">{parsed.notFor}</div>
          </div>
        )}
        {parsed.body && !parsed.useWhen && !parsed.does && (
          <div className="wc-section" style={{ gridColumn: "1 / -1" }}>
            <div className="wc-section-body">{parsed.body}</div>
          </div>
        )}
      </div>
      <div className="wc-foot">
        <div className="wc-types">
          {chips.map((c) => (
            <span
              key={c.type}
              className={`wc-type-pill ${c.type}`}
              title={`${c.count} ${c.type} node${c.count === 1 ? "" : "s"}`}
            >
              {c.type}
              {c.count > 1 ? `·${c.count}` : ""}
            </span>
          ))}
          {chips.length === 0 && (
            <span className="wc-type-pill">
              {workflow.nodeCount} node{workflow.nodeCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <button type="button" className="btn-run" onClick={onRun}>
          ▷ Run
        </button>
      </div>
    </article>
  );
}
