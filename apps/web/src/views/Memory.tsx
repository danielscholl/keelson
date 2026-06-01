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
import { useCallback, useEffect, useState } from "react";

import { listMemories, listPendingMemories, postReviewAction } from "../api.ts";
import { MemoryItem } from "../components/Memory/MemoryItem.tsx";
import { useToast } from "../components/Toast.tsx";

type SubTab = "pending" | "all";

// Stable actor string for review actions. Single-user local — multi-user would replace this.
const REVIEW_ACTOR = "operator";

// "Already resolved" toast verbiage for the silent-no-op shape.
const ALREADY_RESOLVED = "Already resolved (probably by another tab).";

interface FilterState {
  scopeVisibility?: ScopeVisibility;
  lifecycle?: Lifecycle;
  reviewStatus?: ReviewStatus;
}

export function Memory() {
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
    <div className="page memory-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Memory</h1>
          <div className="page-sub">
            Review memories before they shape future runs. Confirm promotes a row to
            instruction-grade; reject discards it.
          </div>
        </div>
        <button
          type="button"
          className="memory-refresh"
          onClick={() => setRefreshTick((t) => t + 1)}
          title="Refresh"
        >
          Refresh
        </button>
      </header>

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
