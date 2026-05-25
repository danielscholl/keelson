import { useMemo, useState } from "react";
import type { WorkflowDetail, WorkflowSummary } from "@keelson/shared";

import { WorkflowCard } from "./WorkflowCard.tsx";

type FilterKind = "all" | "bash" | "prompt" | "mixed";

function nodeTypesSet(detail: WorkflowDetail | undefined): Set<string> {
  if (!detail) return new Set();
  return new Set(detail.nodes.map((n) => n.type));
}

function matchesFilter(
  filter: FilterKind,
  types: Set<string>,
): boolean {
  if (filter === "all") return true;
  if (filter === "bash") return types.size === 1 && types.has("bash");
  if (filter === "prompt") return types.size === 1 && types.has("prompt");
  if (filter === "mixed") return types.size > 1;
  return true;
}

export interface WorkflowListProps {
  workflows: ReadonlyArray<WorkflowSummary>;
  details: ReadonlyMap<string, WorkflowDetail>;
  onRun: (workflow: WorkflowSummary) => void;
}

export function WorkflowList({ workflows, details, onRun }: WorkflowListProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workflows.filter((w) => {
      if (q) {
        const hay = `${w.name} ${w.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const types = nodeTypesSet(details.get(w.name));
      return matchesFilter(filter, types);
    });
  }, [workflows, details, query, filter]);

  if (workflows.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⊘</div>
        <div className="empty-state-title">No workflows discovered</div>
        <div className="empty-state-body">
          Drop YAML files into <code>.keelson/workflows/</code> and restart
          the server.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="toolbar">
        <div className="search">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="Search workflows"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="chip-row">
          {(["all", "bash", "prompt", "mixed"] as const).map((k) => (
            <button
              type="button"
              key={k}
              className={`chip${filter === k ? " active" : ""}`}
              onClick={() => setFilter(k)}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">No matches</div>
          <div className="empty-state-body">Try clearing the search or filter.</div>
        </div>
      ) : (
        <div className="catalog-grid">
          {filtered.map((w) => (
            <WorkflowCard
              key={w.name}
              workflow={w}
              detail={details.get(w.name)}
              onRun={() => onRun(w)}
            />
          ))}
        </div>
      )}
    </>
  );
}
