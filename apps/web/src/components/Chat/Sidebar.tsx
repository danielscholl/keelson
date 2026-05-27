import type { Conversation } from "@keelson/shared";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmModal } from "../ConfirmModal.tsx";
import { SkeletonStack } from "../Skeleton.tsx";

interface SidebarProps {
  conversations: Conversation[];
  loading: boolean;
  activeId: string | null;
  streamingId?: string | null;
  // Display map: providerId → human label. Source: GET /api/providers.
  // Sidebar shows a small badge next to each conversation; falls back to
  // the bare providerId when the map doesn't carry it (e.g. a provider
  // was registered earlier and later removed).
  providerLabels: Map<string, string>;
  // True collapses to a narrow rail; inner sections are display:none so
  // React state survives a toggle.
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

type Bucket = "today" | "yesterday" | "earlier-week" | "older";

const BUCKET_ORDER: Bucket[] = ["today", "yesterday", "earlier-week", "older"];

const BUCKET_LABEL: Record<Bucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "earlier-week": "Earlier this week",
  older: "Older",
};

// Date thresholds expressed as start-of-local-day boundaries so a
// conversation updated 5 minutes after midnight still groups as "Today"
// and one updated 23 hours ago can still be "Yesterday." The "earlier
// this week" bucket spans the prior six days (days -6 through -2 from
// today, since -1 lives in Yesterday); anything older falls through.
function dateBucket(iso: string, now: Date = new Date()): Bucket {
  const ts = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeekWindow = new Date(startOfToday);
  startOfWeekWindow.setDate(startOfWeekWindow.getDate() - 6);
  if (ts >= startOfToday) return "today";
  if (ts >= startOfYesterday) return "yesterday";
  if (ts >= startOfWeekWindow) return "earlier-week";
  return "older";
}

function timestampOf(conv: Conversation): string {
  return conv.updatedAt ?? conv.createdAt;
}

export function Sidebar({
  conversations,
  loading,
  activeId,
  streamingId,
  providerLabels,
  collapsed,
  onToggleCollapse,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: SidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  const startRename = useCallback((conv: Conversation) => {
    setRenamingId(conv.id);
    setDraftName(conv.name ?? "");
  }, []);

  const commitRename = useCallback(async () => {
    if (!renamingId) return;
    const trimmed = draftName.trim();
    const original = conversations.find((c) => c.id === renamingId);
    setRenamingId(null);
    setDraftName("");
    // No-op when the name didn't change or was cleared to empty — avoids
    // a 400 from the server (rename body requires min length 1).
    if (!trimmed || trimmed === (original?.name ?? "")) return;
    try {
      await onRename(renamingId, trimmed);
    } catch {
      // Errors propagate to the parent's toast host via onRename's
      // rejection — caller in Chat.tsx wraps with a try/catch + push.
    }
  }, [conversations, draftName, onRename, renamingId]);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setDraftName("");
  }, []);

  const onRenameKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commitRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelRename();
      }
    },
    [cancelRename, commitRename],
  );

  const handleDelete = useCallback((conv: Conversation) => {
    setPendingDelete(conv);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    try {
      await onDelete(id);
    } catch {
      // Caller surfaces toast on failure.
    }
  }, [onDelete, pendingDelete]);

  const buckets = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? conversations.filter((c) => (c.name ?? "Untitled").toLowerCase().includes(q))
      : conversations;
    const sorted = filtered.slice().sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)));
    const buckets: Record<Bucket, Conversation[]> = {
      today: [],
      yesterday: [],
      "earlier-week": [],
      older: [],
    };
    const now = new Date();
    for (const conv of sorted) {
      buckets[dateBucket(timestampOf(conv), now)].push(conv);
    }
    return buckets;
  }, [conversations, query]);

  const totalVisible = useMemo(
    () => BUCKET_ORDER.reduce((sum, b) => sum + buckets[b].length, 0),
    [buckets],
  );

  // Collapsed rail: only the expand toggle (and the "New" button as an
  // icon). Search-query / rename state survives the toggle because the
  // Sidebar component itself stays mounted across the conditional return —
  // hook order is identical in both branches, so useState retains its
  // value when collapsed flips and we swap which JSX subtree React renders.
  if (collapsed) {
    return (
      <aside className="chat-sidebar collapsed" aria-label="Conversations (collapsed)">
        <button
          type="button"
          className="chat-sidebar-collapse-toggle"
          onClick={onToggleCollapse}
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <span aria-hidden="true">›</span>
        </button>
        <button
          type="button"
          className="chat-sidebar-new-rail"
          onClick={onNew}
          aria-label="Start a new conversation"
          title="New conversation"
        >
          <span aria-hidden="true">＋</span>
        </button>
      </aside>
    );
  }

  return (
    <>
      <aside className="chat-sidebar">
        <div className="chat-sidebar-header">
          <button
            type="button"
            className="chat-sidebar-collapse-toggle"
            onClick={onToggleCollapse}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <span aria-hidden="true">‹</span>
          </button>
          <span className="chat-sidebar-title">Conversations</span>
          <button
            type="button"
            className="chat-sidebar-new"
            onClick={onNew}
            aria-label="Start a new conversation"
          >
            New
          </button>
        </div>

        <div className="chat-sidebar-search-wrap">
          <input
            type="search"
            className="chat-sidebar-search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search conversations"
          />
        </div>

        {loading && conversations.length === 0 && (
          <div className="chat-sidebar-list">
            <SkeletonStack rows={3} height="2.4em" />
          </div>
        )}

        {!loading && conversations.length === 0 && (
          <div className="empty-state">No conversations yet.</div>
        )}

        {!loading && conversations.length > 0 && totalVisible === 0 && (
          <div className="empty-state">No matches.</div>
        )}

        {BUCKET_ORDER.map((bucket) => {
          const list = buckets[bucket];
          if (list.length === 0) return null;
          return (
            <div key={bucket} className="chat-sidebar-group">
              <div className="chat-sidebar-group-label">{BUCKET_LABEL[bucket]}</div>
              <ul className="chat-sidebar-list">
                {list.map((conv) => renderConversationItem(conv))}
              </ul>
            </div>
          );
        })}
      </aside>
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete conversation"
        body={
          pendingDelete ? (
            <>
              Delete <strong>{pendingDelete.name ?? "Untitled"}</strong> and all its messages?
            </>
          ) : null
        }
        mode={{ kind: "simple" }}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );

  function renderConversationItem(conv: Conversation) {
    const isActive = conv.id === activeId;
    const isStreaming = conv.id === streamingId;
    const isRenaming = conv.id === renamingId;
    const label = conv.name ?? "Untitled";
    const providerLabel = providerLabels.get(conv.providerId) ?? conv.providerId;
    return (
      <li key={conv.id} className={`chat-sidebar-item${isActive ? " active" : ""}`}>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="chat-sidebar-rename"
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={onRenameKey}
            maxLength={120}
            aria-label="Rename conversation"
          />
        ) : (
          <button
            type="button"
            className="chat-sidebar-link"
            onClick={() => onSelect(conv.id)}
            onDoubleClick={() => startRename(conv)}
            title="Double-click to rename"
          >
            <span className="chat-sidebar-name">
              {label}
              {isStreaming && (
                <span className="chat-sidebar-streaming-dot" role="img" aria-label="active" />
              )}
            </span>
            <span className="chat-sidebar-meta">
              <span className="pill chat-sidebar-provider">{providerLabel}</span>
            </span>
          </button>
        )}
        {!isRenaming && (
          <button
            type="button"
            className="chat-sidebar-delete"
            onClick={() => void handleDelete(conv)}
            aria-label={`Delete conversation ${label}`}
            title="Delete conversation"
          >
            ×
          </button>
        )}
      </li>
    );
  }
}
