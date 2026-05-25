import type {
  ContentBlock,
  MessageChunk,
  WorkflowFrame,
  WorkflowNodeStatus,
  WorkflowRunDetail,
  WorkflowRunStatus,
} from "@keelson/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { cancelWorkflowRun, getWorkflowRun, submitApproval } from "../api.ts";
import type { NodeViewStatus } from "../lib/dagLayout.ts";
import { createReconnectingWorkflowRunWs, type ReconnectingWsState } from "../ws.ts";

// Per-node view shape. `status` is the UI-level surface (pending → running
// → terminal); `contentParts` is the accumulator the prompt handler emits
// piecewise via `node_chunk`. `logLines` is the bash handler's stdout/stderr
// channel via `node_log`. `thinkingText` is live-only — thinking chunks are
// excluded from durable contentParts per content-parts.ts policy.
export interface NodeView {
  nodeId: string;
  status: NodeViewStatus;
  type?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: string | null;
  // Mirrors chat-handler's per-turn `contentParts` exactly — same blocks,
  // same accumulator semantics — so MarkdownContent / ToolCallsBlock can
  // render them without translation. Thinking is not persisted here.
  contentParts: ContentBlock[];
  // Live extended-thinking text for prompt nodes; cleared on reload. Same
  // model as Chat.tsx's `thinking` per-message field.
  thinkingText: string;
  logLines: string[];
  // Populated when an approval node is paused. Live source: the
  // `approval_awaiting` frame. Snapshot source: the persisted `outputText`
  // of an `awaiting` node row (the route layer writes the message there
  // at pause time so a page-reload mid-pause can rehydrate the callout).
  awaitingMessage?: string;
}

export interface RunView {
  runId: string;
  workflowName?: string;
  // `status` is computed at the hook boundary from the stored server status
  // PLUS the live nodes map: paused iff any node is `awaiting`; running iff
  // stored is paused but no node is awaiting any longer. Terminal stored
  // values (succeeded / failed / cancelled) always pass through. The
  // derivation makes the run-vs-nodes state slots reconciled at read-time
  // rather than requiring cross-updater ordering between two setState
  // dispatches (which React doesn't guarantee under concurrent mode).
  status: WorkflowRunStatus | "loading" | "unknown";
  startedAt?: number;
  // Frozen by `run_done`. Until then this counter advances each animation
  // frame so the run header's "12.4s" is live.
  completedAt?: number;
  error?: string | null;
  // Surfaces `run_warning` frames so the UI can toast them.
  warnings: { nodeId: string | null; message: string }[];
  // Linked chat conversation id, hydrated from the run snapshot. Null while
  // loading and for legacy runs that predate the conversation link (impossible
  // in practice once migration 12 has run, but defensive against fixtures).
  conversationId?: string | null;
  // Derived: first node currently in `awaiting` status (DAG order). Computed
  // at the hook boundary alongside `status`. Multiple parallel approval nodes
  // can be open simultaneously; this surfaces the first one. The UI can
  // iterate `nodes` directly when it needs the exhaustive set.
  awaitingNodeId?: string;
}

export type UseWorkflowRunStatus = "loading" | "ready" | "error";

export interface UseWorkflowRunResult {
  run: RunView;
  nodes: Record<string, NodeView>;
  status: UseWorkflowRunStatus;
  error: string | null;
  wsState: ReconnectingWsState;
  cancel: () => Promise<void>;
  // Set when the executor pauses at an approval node. Stays defined across
  // reconnects via snapshot rehydration (the node row's status='awaiting'
  // carries the message in outputText).
  awaitingNodeId?: string;
  resume: (nodeId: string, text: string) => Promise<void>;
}

const NODE_TERMINAL_STATUSES: ReadonlySet<NodeViewStatus> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

function mapNodeTerminalStatus(s: WorkflowNodeStatus): NodeViewStatus {
  return s;
}

function emptyNode(nodeId: string): NodeView {
  return {
    nodeId,
    status: "pending",
    contentParts: [],
    thinkingText: "",
    logLines: [],
  };
}

// Folds a single `node_chunk` into the running NodeView. Mirrors the server-
// side `content-parts.ts` reducer for durable parts (text collapses into the
// last text block; tool_use / tool_result push) plus a live-only thinking
// accumulator. system / error / done chunks have no UI effect at this layer.
function applyChunkToNode(node: NodeView, chunk: MessageChunk): NodeView {
  switch (chunk.type) {
    case "text": {
      if (chunk.content.length === 0) return node;
      const next = [...node.contentParts];
      const last = next[next.length - 1];
      if (last && last.type === "text") {
        next[next.length - 1] = { ...last, text: last.text + chunk.content };
      } else {
        next.push({ type: "text", text: chunk.content });
      }
      return { ...node, contentParts: next };
    }
    case "thinking":
      return { ...node, thinkingText: node.thinkingText + chunk.content };
    case "tool_use":
      return {
        ...node,
        contentParts: [
          ...node.contentParts,
          {
            type: "tool_use",
            id: chunk.id ?? crypto.randomUUID(),
            toolName: chunk.toolName,
            ...(chunk.toolInput !== undefined ? { toolInput: chunk.toolInput } : {}),
          },
        ],
      };
    case "tool_result":
      return {
        ...node,
        contentParts: [
          ...node.contentParts,
          {
            type: "tool_result",
            toolUseId: chunk.toolUseId,
            content: chunk.content,
            ...(chunk.isError !== undefined ? { isError: chunk.isError } : {}),
          },
        ],
      };
    case "system":
    case "error":
    case "done":
      return node;
  }
}

// Hydrates the hook state from the persisted run snapshot. Used on mount and
// on every WS reconnect so a client that joined late catches up to whatever
// the server has written, before the live stream resumes.
function hydrateFromSnapshot(snapshot: WorkflowRunDetail): {
  run: RunView;
  nodes: Record<string, NodeView>;
} {
  const nodes: Record<string, NodeView> = {};
  for (const row of snapshot.nodes) {
    const status = mapNodeTerminalStatus(row.status);
    const started = row.startedAt ? Date.parse(row.startedAt) : undefined;
    const completed = row.completedAt ? Date.parse(row.completedAt) : undefined;
    // Bash nodes persist their stdout in `outputText` and leave
    // `contentParts` null; the WS `node_log` frames aren't replayed on
    // reload, so we lift outputText into `logLines` when contentParts is
    // empty. Prompt nodes populate `contentParts` and would already render
    // their assistant text from those blocks — the outputText there would
    // just duplicate it. An `awaiting` row's outputText is the approval
    // message (not stdout), so it lifts into awaitingMessage and NOT into
    // logLines.
    const isAwaiting = status === "awaiting";
    const hasContentParts = row.contentParts !== null && row.contentParts.length > 0;
    const hydratedLogLines =
      !isAwaiting && !hasContentParts && row.outputText && row.outputText.length > 0
        ? row.outputText.split(/\r?\n/)
        : [];
    nodes[row.nodeId] = {
      nodeId: row.nodeId,
      status,
      startedAt: started,
      // An awaiting node hasn't completed; don't synthesize a duration even
      // if the snapshot happened to have one (it shouldn't, but defensive).
      completedAt: isAwaiting ? undefined : completed,
      durationMs:
        !isAwaiting && started && completed ? Math.max(0, completed - started) : undefined,
      error: row.error,
      contentParts: row.contentParts ?? [],
      thinkingText: "",
      logLines: hydratedLogLines,
      ...(isAwaiting && row.outputText ? { awaitingMessage: row.outputText } : {}),
    };
  }
  // awaitingNodeId is derived from the nodes map at the hook boundary;
  // no stored field on RunView. See deriveExposedRun below.
  const run: RunView = {
    runId: snapshot.runId,
    workflowName: snapshot.workflowName,
    status: snapshot.status,
    startedAt: Date.parse(snapshot.startedAt),
    completedAt: snapshot.completedAt ? Date.parse(snapshot.completedAt) : undefined,
    error: snapshot.error,
    warnings: [],
    conversationId: snapshot.conversationId ?? null,
  };
  return { run, nodes };
}

// Wire-level terminal run statuses. Mirrors TERMINAL_RUN_STATUSES from
// @keelson/shared but kept local to avoid pulling another import path
// for a 3-entry set used only at the hook boundary.
const TERMINAL_RUN_STATUSES_LOCAL: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

// Snapshot-vs-live run-status reconciliation used during reconnect hydration.
// Tabular form:
//   snapshot terminal     → snapshot (server persisted final state)
//   snapshot paused       → snapshot (missed approval_awaiting frame would
//                            otherwise leave UI thinking it's running)
//   live loading/unknown  → snapshot (live hasn't progressed past mount)
//   live in any other     → live    (WS frames newer than the REST fetch)
function chooseRunStatus(live: RunView["status"], snapshot: RunView["status"]): RunView["status"] {
  if (TERMINAL_RUN_STATUSES_LOCAL.has(snapshot)) return snapshot;
  if (snapshot === "paused") return snapshot;
  if (live === "loading" || live === "unknown") return snapshot;
  return live;
}

// Derives the exposed run view from the stored server status + the live
// nodes map. The presence of any `awaiting` node is what flips the exposed
// status to `paused` (a paused run is by definition a run with an
// awaiting approval). Terminal stored values always win — a server-emitted
// `run_done` cannot be retroactively un-terminated by a stale snapshot
// still showing an awaiting node.
function deriveExposedRun(stored: RunView, nodes: Record<string, NodeView>): RunView {
  let awaitingNodeId: string | undefined;
  for (const id of Object.keys(nodes)) {
    if (nodes[id]!.status === "awaiting") {
      awaitingNodeId = id;
      break;
    }
  }
  let status = stored.status;
  if (status !== "loading" && status !== "unknown" && !TERMINAL_RUN_STATUSES_LOCAL.has(status)) {
    if (awaitingNodeId) status = "paused";
    else if (status === "paused") status = "running";
  }
  return awaitingNodeId ? { ...stored, status, awaitingNodeId } : { ...stored, status };
}

// Subscribes to a workflow run's live stream + persists view state. Used by
// `<RunView>` and reusable as-is by the chat-side workflow surface — the
// hook doesn't care which UI consumes its outputs.
export function useWorkflowRun(runId: string | null): UseWorkflowRunResult {
  const [run, setRun] = useState<RunView>(() => ({
    runId: runId ?? "",
    status: "loading",
    warnings: [],
  }));
  const [nodes, setNodes] = useState<Record<string, NodeView>>({});
  const [status, setStatus] = useState<UseWorkflowRunStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [wsState, setWsState] = useState<ReconnectingWsState>("connecting");

  // Holds the latest WS open generation so an in-flight snapshot fetch
  // from a stale generation can no-op rather than clobbering newer state.
  const openGenRef = useRef(0);
  // Synchronous-readable mirror of `nodes` so the onFrame closure can
  // inspect the pre-apply state without forcing a re-render-and-then-
  // dispatch dance. Kept in sync by a separate effect below.
  const latestNodesRef = useRef<Record<string, NodeView>>({});
  useEffect(() => {
    latestNodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    if (!runId) {
      setStatus("loading");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);
    setRun({ runId, status: "loading", warnings: [] });
    setNodes({});

    const hydrate = async (gen: number) => {
      try {
        const snapshot = await getWorkflowRun(runId);
        if (cancelled || gen !== openGenRef.current) return;
        const hydrated = hydrateFromSnapshot(snapshot);
        // Snapshot is the floor: live state already accumulated by the WS
        // between open and snapshot-arrival is preserved by *merging* the
        // snapshot under the in-memory nodes rather than over them.
        setNodes((live) => {
          const merged: Record<string, NodeView> = { ...hydrated.nodes };
          for (const [id, node] of Object.entries(live)) {
            const base = merged[id] ?? emptyNode(id);
            merged[id] = mergeNode(base, node);
          }
          return merged;
        });
        setRun((live) => ({
          ...hydrated.run,
          // Snapshot vs. live status precedence:
          //   1. Snapshot terminal (succeeded/failed/cancelled) — wins
          //      always; the server persisted a final state.
          //   2. Snapshot paused — wins over live running. A reconnect gap
          //      can miss the `approval_awaiting` frame that would have
          //      flipped live; the REST snapshot is the only signal left
          //      and the UI must enable the composer.
          //   3. Live in a real status (not loading/unknown) — wins,
          //      since it reflects WS frames newer than the snapshot fetch.
          //   4. Otherwise — snapshot.
          status: chooseRunStatus(live.status, hydrated.run.status),
          warnings: live.warnings,
        }));
        setStatus("ready");
      } catch (err) {
        if (cancelled || gen !== openGenRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus("error");
      }
    };

    // Initial hydrate while WS connects in parallel — paints fast and
    // catches up post-WS-open via the onStateChange handler below.
    const initialGen = ++openGenRef.current;
    void hydrate(initialGen);

    const handle = createReconnectingWorkflowRunWs(runId, {
      onFrame: (frame) => {
        if (cancelled) return;
        // Late subscribers / mid-run reconnects may receive a `node_done`
        // for a node whose `node_started` + `node_chunk` frames they
        // missed. Detect that case BEFORE applying the frame (the apply
        // overwrites status to terminal), then trigger a fresh REST
        // hydrate so the persisted contentParts / outputText backfill
        // the empty live row.
        const shouldRehydrateAfter =
          frame.type === "node_done"
            ? isLiveNodeEmpty(latestNodesRef.current[frame.nodeId])
            : false;
        applyFrame(frame, setRun, setNodes);
        if (shouldRehydrateAfter) {
          const gen = ++openGenRef.current;
          void hydrate(gen);
        }
        // Terminal frame → stop the reconnect ceremony so the server's
        // clean close after run_done doesn't trigger an immediate reopen
        // and another close (the run is already terminal — re-subscribing
        // would just emit a duplicate run_done and close again, forever
        // while the run view remains mounted).
        if (frame.type === "run_done") {
          handle.stopReconnecting();
          // run_done also can backfill — for short runs that completed
          // before the client subscribed, the open-time hydrate may have
          // raced with persistence finishing. One more pull settles it.
          const gen = ++openGenRef.current;
          void hydrate(gen);
        }
      },
      onStateChange: (next) => {
        if (cancelled) return;
        setWsState(next);
        if (next === "open") {
          // Each fresh open re-hydrates from the persisted snapshot so the
          // catch-up window between disconnect and reconnect doesn't leave
          // a gap. New generation invalidates any stale fetch in flight.
          const gen = ++openGenRef.current;
          void hydrate(gen);
        }
      },
    });

    return () => {
      cancelled = true;
      handle.close();
    };
  }, [runId]);

  const cancel = useCallback(async () => {
    if (!runId) return;
    await cancelWorkflowRun(runId);
  }, [runId]);

  // Resume the paused approval node. The server flips run status back to
  // running and the executor proceeds; we don't optimistic-update here
  // because the next `node_done` (or a snapshot reload) is the source of
  // truth for what happened.
  const resume = useCallback(
    async (nodeId: string, text: string) => {
      if (!runId) return;
      await submitApproval(runId, nodeId, text);
    },
    [runId],
  );

  // Derive the exposed run view (status + awaitingNodeId) from the stored
  // server status PLUS the nodes map. This collapses the run-vs-nodes
  // state-slot ordering problem: both pieces are React state, but their
  // reconciliation happens at read time rather than via cross-updater
  // closure variables (which React doesn't sequence across slots in
  // concurrent mode).
  const exposedRun = deriveExposedRun(run, nodes);

  return {
    run: exposedRun,
    nodes,
    status,
    error,
    wsState,
    cancel,
    awaitingNodeId: exposedRun.awaitingNodeId,
    resume,
  };
}

// Keep the snapshot's terminal fields, but a live node that's already
// moved past pending should win over a snapshot that hasn't caught up.
const TERMINAL_NODE_STATUSES: ReadonlySet<NodeViewStatus> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

// True when the live row carries no observable output yet — used to
// decide whether a fresh `node_done` is a late-subscriber arrival that
// needs a REST rehydrate to backfill missed contentParts/logLines.
function isLiveNodeEmpty(node: NodeView | undefined): boolean {
  if (!node) return true;
  return (
    node.contentParts.length === 0 && node.logLines.length === 0 && node.thinkingText.length === 0
  );
}

function mergeNode(snapshotSide: NodeView, liveSide: NodeView): NodeView {
  // Reconnect-after-disconnect repair: pick the more-advanced status and
  // the longer content. Status preference order:
  //   1. Either side that's terminal wins (snapshot terminal + live still
  //      running is exactly the WS-gap case where the client missed the
  //      node_done frame — snapshot is the only source of truth there).
  //   2. Snapshot `awaiting` beats live `running`. The server only writes
  //      `awaiting` after opening the pause; if the client missed the
  //      `approval_awaiting` frame during a reconnect gap, the REST snapshot
  //      is the only signal that the run paused, and the composer must
  //      enable. Symmetric to the snapshot-terminal rule.
  //   3. Otherwise live wins once it left pending; else snapshot.
  // For contentParts / logLines we always pick the longer side, since
  // persistence collapses streamed deltas into compact blocks and either
  // side can be the more complete representation depending on the gap.
  const snapTerminal = TERMINAL_NODE_STATUSES.has(snapshotSide.status);
  const liveTerminal = TERMINAL_NODE_STATUSES.has(liveSide.status);
  let winningStatus: NodeViewStatus;
  // Snapshot is the persisted source of truth, so it wins whenever it
  // has a terminal row. Specifically: if the run was cancelled after a
  // node completed while the WS was disconnected, the hook's run_done
  // handler infers `cancelled` for every still-running node — but the
  // server already persisted the real terminal status (succeeded/failed)
  // on that row. Choosing snapshot here keeps persisted completions
  // from being overwritten by inferred cancellation.
  if (snapTerminal) winningStatus = snapshotSide.status;
  else if (snapshotSide.status === "awaiting" && !TERMINAL_NODE_STATUSES.has(liveSide.status)) {
    // Snapshot says the server has the node paused. Live's pre-pause
    // `running` (or `pending`) must NOT clobber that.
    winningStatus = snapshotSide.status;
  } else if (liveTerminal) winningStatus = liveSide.status;
  else if (liveSide.status !== "pending") winningStatus = liveSide.status;
  else winningStatus = snapshotSide.status;
  const liveTextLen = totalTextLength(liveSide.contentParts);
  const snapTextLen = totalTextLength(snapshotSide.contentParts);
  const winningParts =
    snapTextLen >= liveTextLen ? snapshotSide.contentParts : liveSide.contentParts;
  const winningLogs =
    snapshotSide.logLines.join("\n").length >= liveSide.logLines.join("\n").length
      ? snapshotSide.logLines
      : liveSide.logLines;
  // Spread snapshot first, then live, then explicit winners last. Without
  // the explicit fields, the live spread would null out snapshot's
  // terminal-only fields (completedAt, durationMs, error) when live is
  // still mid-flight. Choose the side whose status won for those fields.
  const winningSide = winningStatus === liveSide.status ? liveSide : snapshotSide;
  // When winningStatus is `awaiting`, the approval message must come from
  // whichever side actually has it (snapshot writes it at pause time; live
  // only has it if the WS approval_awaiting frame arrived). Live's spread
  // would otherwise overwrite snapshot's message with undefined.
  const winningAwaitingMessage =
    winningStatus === "awaiting"
      ? (liveSide.awaitingMessage ?? snapshotSide.awaitingMessage)
      : undefined;
  return {
    ...snapshotSide,
    ...liveSide,
    status: winningStatus,
    completedAt: winningSide.completedAt ?? liveSide.completedAt ?? snapshotSide.completedAt,
    durationMs: winningSide.durationMs ?? liveSide.durationMs ?? snapshotSide.durationMs,
    error: winningSide.error ?? liveSide.error ?? snapshotSide.error,
    contentParts: winningParts,
    // Thinking is live-only (not persisted) — snapshot side is always "".
    thinkingText: liveSide.thinkingText || snapshotSide.thinkingText,
    logLines: winningLogs,
    awaitingMessage: winningAwaitingMessage,
  };
}

function totalTextLength(parts: ContentBlock[]): number {
  let n = 0;
  for (const p of parts) {
    if (p.type === "text") n += p.text.length;
    else if (p.type === "tool_result") n += p.content.length;
    // tool_use has no comparable text — counted by presence via block count.
    n += 1;
  }
  return n;
}

function applyFrame(
  frame: WorkflowFrame,
  setRun: React.Dispatch<React.SetStateAction<RunView>>,
  setNodes: React.Dispatch<React.SetStateAction<Record<string, NodeView>>>,
): void {
  switch (frame.type) {
    case "run_started":
      setRun((prev) => ({
        ...prev,
        runId: frame.runId,
        workflowName: frame.workflowName,
        status: "running",
        startedAt: prev.startedAt ?? Date.now(),
        warnings: prev.warnings,
      }));
      return;

    case "node_started":
      setNodes((prev) => {
        const base = prev[frame.nodeId] ?? emptyNode(frame.nodeId);
        return {
          ...prev,
          [frame.nodeId]: {
            ...base,
            status: "running",
            startedAt: base.startedAt ?? Date.now(),
          },
        };
      });
      return;

    case "node_chunk":
      setNodes((prev) => {
        const base = prev[frame.nodeId] ?? emptyNode(frame.nodeId);
        // Don't roll a terminal node back to running just because a stray
        // chunk arrived after its node_done. The server shouldn't emit
        // these, but defensive against ordering glitches over WS.
        const folded = applyChunkToNode(base, frame.chunk);
        return {
          ...prev,
          [frame.nodeId]: {
            ...folded,
            status: NODE_TERMINAL_STATUSES.has(base.status) ? base.status : "running",
            startedAt: base.startedAt ?? Date.now(),
          },
        };
      });
      return;

    case "node_log":
      setNodes((prev) => {
        const base = prev[frame.nodeId] ?? emptyNode(frame.nodeId);
        return {
          ...prev,
          [frame.nodeId]: {
            ...base,
            status: NODE_TERMINAL_STATUSES.has(base.status) ? base.status : "running",
            startedAt: base.startedAt ?? Date.now(),
            logLines: [...base.logLines, frame.line],
          },
        };
      });
      return;

    case "node_done":
      // Single setNodes — the derived exposedRun in deriveExposedRun
      // picks up the change at read time and adjusts run.status +
      // awaitingNodeId accordingly. No cross-updater coordination needed.
      setNodes((prev) => {
        const base = prev[frame.nodeId] ?? emptyNode(frame.nodeId);
        const completed = Date.now();
        return {
          ...prev,
          [frame.nodeId]: {
            ...base,
            status: mapNodeTerminalStatus(frame.status),
            completedAt: completed,
            durationMs: base.startedAt ? Math.max(0, completed - base.startedAt) : undefined,
            error: frame.error,
            // Approval node resolved — clear its message so the callout
            // doesn't linger after resume.
            awaitingMessage: undefined,
          },
        };
      });
      return;

    case "run_warning":
      setRun((prev) => ({
        ...prev,
        warnings: [...prev.warnings, { nodeId: frame.nodeId, message: frame.message }],
      }));
      return;

    case "approval_awaiting":
      // Mark the node awaiting + stash the approval message. The exposed
      // run.status / awaitingNodeId are derived from this nodes map (see
      // deriveExposedRun), so a single setNodes call is enough; no parallel
      // setRun for stored status. The stored run.status only changes when
      // the server explicitly broadcasts a new run-level state (run_done,
      // hydrate, etc.).
      setNodes((prev) => {
        const base = prev[frame.nodeId] ?? emptyNode(frame.nodeId);
        return {
          ...prev,
          [frame.nodeId]: {
            ...base,
            status: "awaiting",
            startedAt: base.startedAt ?? Date.now(),
            awaitingMessage: frame.message,
          },
        };
      });
      return;

    case "run_done":
      setRun((prev) => ({
        ...prev,
        status: frame.status,
        completedAt: prev.completedAt ?? Date.now(),
      }));
      // Cancellation propagates to any still-running, pending, OR awaiting
      // node — the server doesn't emit a node_done for nodes the abort
      // caught mid-flight. `awaiting` is included so a DELETE during an
      // approval pause clears the callout (otherwise deriveExposedRun would
      // still surface awaitingNodeId from the lingering row).
      if (frame.status === "cancelled") {
        setNodes((prev) => {
          const next: Record<string, NodeView> = { ...prev };
          let changed = false;
          for (const id of Object.keys(next)) {
            const node = next[id]!;
            if (
              node.status === "running" ||
              node.status === "pending" ||
              node.status === "awaiting"
            ) {
              next[id] = {
                ...node,
                status: "cancelled",
                awaitingMessage: undefined,
              };
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      return;
  }
}
