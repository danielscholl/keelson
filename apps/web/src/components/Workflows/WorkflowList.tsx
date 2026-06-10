import type { WorkflowDetail, WorkflowSummary } from "@keelson/shared";
import { useMemo, useState } from "react";

import { useSettings } from "../../hooks/useSettings.ts";
import { ribAccent } from "../../lib/rib.ts";
import { WorkflowCard } from "./WorkflowCard.tsx";

type FilterKind = "all" | "bash" | "prompt" | "mixed";
// "all" | "local" | a rib id.
type SourceFilter = string;

function nodeTypesSet(detail: WorkflowDetail | undefined): Set<string> {
  if (!detail) return new Set();
  return new Set(detail.nodes.map((n) => n.type));
}

function matchesFilter(filter: FilterKind, types: Set<string>): boolean {
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
  const {
    settings,
    isWorkflowSourceHidden,
    toggleHiddenWorkflowSource,
    setShowBackgroundWorkflows,
  } = useSettings();
  const showBackground = settings.showBackgroundWorkflows ?? false;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [source, setSource] = useState<SourceFilter>("all");

  // Ribs that actually contributed workflows, for the source filter row.
  const ribs = useMemo(() => {
    const byId = new Map<string, string>();
    let hasLocal = false;
    for (const w of workflows) {
      if (w.source.kind === "rib" && w.source.ribId) {
        byId.set(w.source.ribId, w.source.ribName ?? w.source.ribId);
      } else {
        hasLocal = true;
      }
    }
    return {
      hasLocal,
      list: [...byId.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [workflows]);

  const hiddenCount = useMemo(
    () =>
      workflows.filter(
        (w) => w.source.kind === "rib" && w.source.ribId && isWorkflowSourceHidden(w.source.ribId),
      ).length,
    [workflows, isWorkflowSourceHidden],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workflows.filter((w) => {
      const ribId = w.source.kind === "rib" ? w.source.ribId : undefined;
      // View-only hide: a hidden rib's workflows drop out entirely.
      if (ribId && isWorkflowSourceHidden(ribId)) return false;
      // Background producers are auto-refresh machinery; off unless asked for.
      if (w.background && !showBackground) return false;
      // Source filter.
      if (source === "local" && w.source.kind !== "local") return false;
      if (source !== "all" && source !== "local" && ribId !== source) return false;
      if (q) {
        const hay = `${w.name} ${w.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return matchesFilter(filter, nodeTypesSet(details.get(w.name)));
    });
  }, [workflows, details, query, filter, source, showBackground, isWorkflowSourceHidden]);

  if (workflows.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⊘</div>
        <div className="empty-state-title">No workflows discovered</div>
        <div className="empty-state-body">
          Drop YAML files into <code>.keelson/workflows/</code> or install a rib that contributes
          them.
        </div>
      </div>
    );
  }

  const sourceChip = (key: SourceFilter, label: string, accent?: ReturnType<typeof ribAccent>) => {
    const active = source === key;
    return (
      <button
        type="button"
        key={`src-${key}`}
        className={`chip${active ? " active" : ""}`}
        onClick={() => setSource(key)}
        style={active && accent ? { color: accent.color, borderColor: accent.border } : undefined}
      >
        {label}
      </button>
    );
  };

  return (
    <>
      <div className="toolbar">
        <div className="search">
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
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
      {ribs.list.length > 0 && (
        <div className="toolbar source-toolbar">
          <div className="chip-row">
            <span className="chip-row-label">Source</span>
            {sourceChip("all", "all")}
            {ribs.hasLocal && sourceChip("local", "local")}
            {ribs.list.map((r) => {
              const accent = ribAccent(r.id);
              const hidden = isWorkflowSourceHidden(r.id);
              return (
                <span className="chip-group" key={`grp-${r.id}`}>
                  {sourceChip(r.id, r.name, accent)}
                  <button
                    type="button"
                    className={`chip-eye${hidden ? " is-hidden" : ""}`}
                    aria-label={`${hidden ? "Show" : "Hide"} ${r.name} workflows`}
                    title={
                      hidden
                        ? `${r.name} workflows are hidden — click to show`
                        : `Hide ${r.name} workflows from this view (its lanes keep refreshing)`
                    }
                    onClick={() => {
                      if (!hidden && source === r.id) setSource("all");
                      toggleHiddenWorkflowSource(r.id);
                    }}
                  >
                    {hidden ? "🚫" : "👁"}
                  </button>
                </span>
              );
            })}
          </div>
          <label className="bg-toggle">
            <input
              type="checkbox"
              checked={showBackground}
              onChange={(e) => setShowBackgroundWorkflows(e.target.checked)}
            />
            Show background
          </label>
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">No matches</div>
          <div className="empty-state-body">
            {hiddenCount > 0
              ? `${hiddenCount} workflow${hiddenCount === 1 ? "" : "s"} hidden by a rib filter. Try clearing the search/filter or showing a hidden rib.`
              : "Try clearing the search or filter."}
          </div>
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
