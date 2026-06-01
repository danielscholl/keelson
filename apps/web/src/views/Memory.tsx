// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type {
  Lifecycle,
  ReviewActionKind,
  ReviewItem,
  ReviewStatus,
  ScopeVisibility,
} from "@keelson/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getProjectNotebook,
  listMemories,
  listPendingMemories,
  postReviewAction,
  putProjectNotebook,
  tidyProjectNotebook,
} from "../api.ts";
import { MemoryItem } from "../components/Memory/MemoryItem.tsx";
import { useToast } from "../components/Toast.tsx";
import { useActiveProject } from "../hooks/useActiveProject.ts";

type TopTab = "notebook" | "ledger";
type SubTab = "pending" | "all";

// Stable actor string for review actions. Single-user local — multi-user would replace this.
const REVIEW_ACTOR = "operator";

// "Already resolved" toast verbiage for the silent-no-op shape.
const ALREADY_RESOLVED = "Already resolved (probably by another tab).";

// Mirrors apps/server NOTEBOOK_INJECTION_BUDGET — the always-on chat budget. Used
// only to flag when the notebook is over budget so the user can run Tidy.
const NOTEBOOK_INJECTION_BUDGET = 6000;

// What chat actually injects: everything except every `## Archive` section Tidy
// parks old entries under. Length-only mirror of the server's injectionView.
function injectedLength(content: string): number {
  const kept: string[] = [];
  let skipping = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) skipping = trimmed === "## Archive";
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trim().length;
}

interface FilterState {
  scopeVisibility?: ScopeVisibility;
  lifecycle?: Lifecycle;
  reviewStatus?: ReviewStatus;
}

export function Memory() {
  const [topTab, setTopTab] = useState<TopTab>("notebook");

  return (
    <div className="page memory-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Memory</h1>
          <div className="page-sub">
            {topTab === "notebook"
              ? "The project notebook is durable context injected into every chat for the active project. Edit it freely — it lives only in this Keelson, never in the repo."
              : "Review governed memories before they shape future runs. Confirm promotes a row to instruction-grade; reject discards it."}
          </div>
        </div>
      </header>

      <div className="memory-subtabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={topTab === "notebook"}
          className={`memory-subtab${topTab === "notebook" ? " is-active" : ""}`}
          onClick={() => setTopTab("notebook")}
        >
          Notebook
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={topTab === "ledger"}
          className={`memory-subtab${topTab === "ledger" ? " is-active" : ""}`}
          onClick={() => setTopTab("ledger")}
        >
          Ledger (advanced)
        </button>
      </div>

      {topTab === "notebook" ? <NotebookPanel /> : <LedgerPanel />}
    </div>
  );
}

// Always-on per-project notebook: a plain markdown doc injected into every chat
// for the active project. Editing here is the primary way to seed it (PR1);
// agent-driven growth and compaction land in later slices.
function NotebookPanel() {
  const toast = useToast();
  const { activeProject, activeProjectId } = useActiveProject();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Last persisted content — the dirty check compares against this, not the
  // initial empty string, so a freshly loaded notebook isn't reported dirty.
  const savedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeProjectId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getProjectNotebook(activeProjectId)
      .then((nb) => {
        if (cancelled) return;
        setContent(nb.content);
        savedRef.current = nb.content;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const dirty = savedRef.current !== null && content !== savedRef.current;

  const handleSave = useCallback(async () => {
    if (!activeProjectId) return;
    setSaving(true);
    try {
      const nb = await putProjectNotebook(activeProjectId, content);
      savedRef.current = nb.content;
      setContent(nb.content);
      toast.push({ kind: "ok", message: "Notebook saved." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({ kind: "error", message: `Save failed: ${msg}` });
    } finally {
      setSaving(false);
    }
  }, [activeProjectId, content, toast]);

  // Tidy operates on the server-stored notebook, so a dirty editor is disabled
  // (Save first) to avoid clobbering unsaved edits with the tidied result.
  const handleTidy = useCallback(async () => {
    if (!activeProjectId) return;
    const projectId = activeProjectId;
    setTidying(true);
    try {
      const res = await tidyProjectNotebook(projectId);
      savedRef.current = res.content;
      setContent(res.content);
      if (res.archivedCount > 0) {
        const previous = res.previousContent;
        const n = res.archivedCount;
        toast.push({
          kind: "ok",
          message: `Tidied — moved ${n} ${n === 1 ? "entry" : "entries"} to Archive.`,
          action: {
            label: "Undo",
            onClick: () => {
              void putProjectNotebook(projectId, previous)
                .then((nb) => {
                  savedRef.current = nb.content;
                  setContent(nb.content);
                })
                .catch((err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  toast.push({ kind: "error", message: `Undo failed: ${msg}` });
                });
            },
          },
        });
      } else {
        toast.push({ kind: "info", message: "Already within budget — nothing to tidy." });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.push({ kind: "error", message: `Tidy failed: ${msg}` });
    } finally {
      setTidying(false);
    }
  }, [activeProjectId, toast]);

  const overBudget = injectedLength(content) > NOTEBOOK_INJECTION_BUDGET;

  if (!activeProjectId) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No active project</div>
        <div className="empty-state-body">Pick a project in Chat to give it a notebook.</div>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          margin: "12px 0",
        }}
      >
        <span className="page-sub" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          Project · {activeProject?.name ?? "…"}
          {overBudget && (
            <span
              role="status"
              title="The notebook exceeds the always-on chat budget; Tidy archives the oldest log entries."
              style={{ color: "var(--warn, #b58900)", fontWeight: 600 }}
            >
              Over budget — Tidy recommended.
            </span>
          )}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="memory-refresh"
            disabled={dirty || saving || tidying}
            onClick={handleTidy}
            title={dirty ? "Save your edits before tidying." : "Archive the oldest log entries."}
          >
            {tidying ? "Tidying…" : "Tidy"}
          </button>
          <button
            type="button"
            className="memory-refresh"
            disabled={!dirty || saving || tidying}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {loading && (
        <div className="page-sub" style={{ padding: "20px 0" }}>
          Loading…
        </div>
      )}
      {error && (
        <div className="empty-state" role="alert">
          <div className="empty-state-title">Couldn't load the notebook</div>
          <div className="empty-state-body">{error}</div>
        </div>
      )}
      {!loading && !error && (
        <textarea
          aria-label="Project notebook"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          placeholder={
            "## Conventions\n## Gotchas\n## Decisions\n\nNotes about this project the agent should always know…"
          }
          style={{
            width: "100%",
            minHeight: 360,
            boxSizing: "border-box",
            padding: 12,
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontSize: 13,
            lineHeight: 1.5,
            resize: "vertical",
          }}
        />
      )}
    </div>
  );
}

// The governed memory ledger — provenance-tracked, review-gated rows. Demoted
// behind the notebook (the primary surface); kept for audited workflow memories.
function LedgerPanel() {
  const toast = useToast();

  const [subTab, setSubTab] = useState<SubTab>("pending");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  // Memory rows currently being acted on — keyed by memoryId. Used to disable
  // the action bar so a slow server response can't be double-fired.
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());

  const [filters, setFilters] = useState<FilterState>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is a deliberate re-fetch trigger bumped after a review action
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetcher =
      subTab === "pending"
        ? listPendingMemories({
            limit: 50,
            ...(filters.scopeVisibility ? { scopeVisibility: filters.scopeVisibility } : {}),
          })
        : listMemories({
            limit: 50,
            ...(filters.scopeVisibility ? { scopeVisibility: filters.scopeVisibility } : {}),
            ...(filters.lifecycle ? { lifecycle: filters.lifecycle } : {}),
            ...(filters.reviewStatus ? { reviewStatus: filters.reviewStatus } : {}),
          });

    fetcher
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [subTab, filters, refreshTick]);

  const handleAction = useCallback(
    async (memoryId: string, action: ReviewActionKind) => {
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.add(memoryId);
        return next;
      });
      try {
        const verdict = await postReviewAction({
          memoryId,
          action,
          actor: REVIEW_ACTOR,
        });
        if (!verdict.applied) {
          toast.push({ kind: "info", message: ALREADY_RESOLVED });
        } else {
          toast.push({ kind: "ok", message: actionToastLabel(action) });
        }
        // Pending tab: optimistically remove the row. All tab: re-fetch so
        // the new review_status surfaces in the listing.
        if (subTab === "pending") {
          setItems((prev) => prev.filter((i) => i.memoryId !== memoryId));
        } else {
          setRefreshTick((t) => t + 1);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.push({ kind: "error", message: `Action failed: ${msg}` });
      } finally {
        setPendingActions((prev) => {
          const next = new Set(prev);
          next.delete(memoryId);
          return next;
        });
      }
    },
    [toast, subTab],
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          margin: "12px 0",
        }}
      >
        <div className="memory-subtabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={subTab === "pending"}
            className={`memory-subtab${subTab === "pending" ? " is-active" : ""}`}
            onClick={() => setSubTab("pending")}
          >
            Pending
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === "all"}
            className={`memory-subtab${subTab === "all" ? " is-active" : ""}`}
            onClick={() => setSubTab("all")}
          >
            All
          </button>
        </div>
        <button
          type="button"
          className="memory-refresh"
          onClick={() => setRefreshTick((t) => t + 1)}
          title="Refresh"
        >
          Refresh
        </button>
      </div>

      <div className="memory-filters">
        <label className="memory-filter">
          <span>Scope</span>
          <select
            value={filters.scopeVisibility ?? ""}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                scopeVisibility: (e.target.value || undefined) as ScopeVisibility | undefined,
              }))
            }
          >
            <option value="">any</option>
            <option value="project">project</option>
            <option value="personal">personal</option>
          </select>
        </label>
        {subTab === "all" && (
          <>
            <label className="memory-filter">
              <span>Status</span>
              <select
                value={filters.reviewStatus ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    reviewStatus: (e.target.value || undefined) as ReviewStatus | undefined,
                  }))
                }
              >
                <option value="">any</option>
                <option value="pending">pending</option>
                <option value="confirmed">confirmed</option>
                <option value="evidence_only">evidence-only</option>
                <option value="restricted">restricted</option>
                <option value="rejected">rejected</option>
                <option value="stale">stale</option>
                <option value="merged">merged</option>
              </select>
            </label>
            <label className="memory-filter">
              <span>Lifecycle</span>
              <select
                value={filters.lifecycle ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    lifecycle: (e.target.value || undefined) as Lifecycle | undefined,
                  }))
                }
              >
                <option value="">any</option>
                <option value="active">active</option>
                <option value="stale">stale</option>
                <option value="superseded">superseded</option>
                <option value="disputed">disputed</option>
                <option value="rejected">rejected</option>
              </select>
            </label>
          </>
        )}
      </div>

      {loading && (
        <div className="page-sub" style={{ padding: "20px 0" }}>
          Loading…
        </div>
      )}
      {error && (
        <div className="empty-state" role="alert">
          <div className="empty-state-title">Couldn't load memory</div>
          <div className="empty-state-body">{error}</div>
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden>
            ◌
          </div>
          <div className="empty-state-title">
            {subTab === "pending"
              ? "No memory awaiting review"
              : "No memories matching these filters"}
          </div>
          <div className="empty-state-body">
            {subTab === "pending" ? (
              <>
                Memories arrive here from chat (click "Save to memory" on a message) or from
                workflows with a <code>memory:</code> block.
              </>
            ) : (
              "Try widening the filter — or save something from chat to seed the list."
            )}
          </div>
        </div>
      )}
      {!loading && !error && items.length > 0 && (
        <ul className="memory-list">
          {items.map((item) => (
            <MemoryItem
              key={item.memoryId}
              item={item}
              onAction={
                subTab === "all" ? null : pendingActions.has(item.memoryId) ? null : handleAction
              }
              readOnly={subTab === "all"}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function actionToastLabel(action: ReviewActionKind): string {
  switch (action) {
    case "confirm":
      return "Confirmed — promoted to instruction.";
    case "evidence_only":
      return "Marked evidence-only.";
    case "restrict":
      return "Restricted.";
    case "reject":
      return "Rejected.";
    case "merge":
      return "Merged.";
    case "mark_stale":
      return "Marked stale.";
  }
}
