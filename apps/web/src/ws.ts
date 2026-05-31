import {
  type ChatFrame,
  type ClientFrame,
  type SnapshotFrame,
  snapshotFrameSchema,
  type WorkflowFrame,
  workflowFrameSchema,
} from "@keelson/shared";

// Use the page origin so chat travels through the same proxy/host as REST.
// In dev that means Vite (port 5173) forwards WS upgrades to the server via
// `/api/chat/ws`; in HTTPS or port-forwarded setups the browser's `wss://`
// flows through whatever fronts the SPA. The server's Origin allow-list still
// validates the browser's page origin, which Vite preserves on upgrade.
function buildWsUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/chat/ws`;
}

function buildWorkflowRunWsUrl(runId: string): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/workflows/runs/${encodeURIComponent(runId)}/ws`;
}

function buildSnapshotWsUrl(key: string): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/snapshots/${encodeURIComponent(key)}/ws`;
}

export interface ChatWsCallbacks {
  onFrame: (frame: ChatFrame) => void;
  onClose: () => void;
  onError: (e: Event) => void;
  // Fires after the inner WebSocket reaches OPEN and any pre-OPEN queue
  // has flushed. Reconnecting wrappers use this to know it's safe to
  // promote state and drain their own queues; without it they'd have to
  // poll readyState and risk acting on a still-pending handshake.
  onOpen?: () => void;
}

export interface ChatWsHandle {
  send: (frame: ClientFrame) => void;
  close: () => void;
}

export function openChatWs(callbacks: ChatWsCallbacks): ChatWsHandle {
  const ws = new WebSocket(buildWsUrl());
  const queue: ClientFrame[] = [];

  ws.onopen = () => {
    for (const f of queue.splice(0)) {
      ws.send(JSON.stringify(f));
    }
    callbacks.onOpen?.();
  };

  ws.onmessage = (e) => {
    try {
      callbacks.onFrame(JSON.parse(e.data as string) as ChatFrame);
    } catch {
      // malformed server frame — ignore
    }
  };

  ws.onclose = () => callbacks.onClose();
  ws.onerror = (e) => callbacks.onError(e);

  return {
    send: (frame) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame));
      } else {
        queue.push(frame);
      }
    },
    close: () => ws.close(),
  };
}

// --- Reconnecting wrappers ---

export type ReconnectingWsState = "connecting" | "open" | "reconnecting" | "closed";

export interface ReconnectingChatWsCallbacks {
  onFrame: (frame: ChatFrame) => void;
  // Fired on every state transition so the UI can render reconnect toasts.
  // The wrapper does NOT replay in-flight requests across reconnects — the
  // server has no resume primitive and we'd otherwise double-fire user turns.
  onStateChange?: (state: ReconnectingWsState) => void;
}

export interface ReconnectingChatWsOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFraction?: number;
}

export interface ReconnectingChatWsHandle {
  send: (frame: ClientFrame) => void;
  close: () => void;
  getState: () => ReconnectingWsState;
}

const DEFAULT_BASE_MS = 500;
const DEFAULT_MAX_MS = 15_000;
const DEFAULT_JITTER = 0.25;

interface ReconnectScheduleOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFraction?: number;
}

function createReconnectSchedule(options: ReconnectScheduleOptions): {
  openingState: () => ReconnectingWsState;
  resetAttempts: () => void;
  schedule: (open: () => void) => void;
  cancel: () => void;
} {
  const baseMs = options.baseDelayMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxDelayMs ?? DEFAULT_MAX_MS;
  const jitterFrac = options.jitterFraction ?? DEFAULT_JITTER;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const computeDelay = (): number => {
    const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10));
    const jitter = exp * jitterFrac * (Math.random() * 2 - 1);
    return Math.max(50, Math.round(exp + jitter));
  };

  return {
    openingState: () => (attempt === 0 ? "connecting" : "reconnecting"),
    resetAttempts: () => {
      attempt = 0;
    },
    schedule: (open) => {
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        open();
      }, computeDelay());
    },
    cancel: () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    },
  };
}

export function createReconnectingChatWs(
  callbacks: ReconnectingChatWsCallbacks,
  options: ReconnectingChatWsOptions = {},
): ReconnectingChatWsHandle {
  const reconnect = createReconnectSchedule(options);
  let state: ReconnectingWsState = "connecting";
  let inner: ChatWsHandle | null = null;
  // Wrapper-owned queue for frames submitted while the inner socket is not
  // yet OPEN. Critically: the wrapper holds these — never the inner handle
  // — so a handshake that closes before opening doesn't drop them. They
  // ride through any number of reconnect attempts until an inner socket
  // actually opens and the onOpen handler drains them.
  let preOpenQueue: ClientFrame[] = [];
  let manualClose = false;

  const setState = (next: ReconnectingWsState): void => {
    if (state === next) return;
    state = next;
    callbacks.onStateChange?.(next);
  };

  const open = (): void => {
    setState(reconnect.openingState());
    inner = openChatWs({
      onFrame: callbacks.onFrame,
      onOpen: () => {
        if (!inner || manualClose) return;
        reconnect.resetAttempts();
        const drained = preOpenQueue;
        preOpenQueue = [];
        for (const f of drained) inner.send(f);
        setState("open");
      },
      onClose: () => {
        inner = null;
        if (manualClose) {
          setState("closed");
          return;
        }
        scheduleReconnect();
      },
      onError: () => {
        // Errors are followed by close on most browsers; let the close
        // handler drive the reconnect to avoid double scheduling.
      },
    });
  };

  const scheduleReconnect = (): void => {
    if (manualClose) return;
    setState("reconnecting");
    reconnect.schedule(open);
  };

  open();

  return {
    send: (frame) => {
      if (manualClose) return;
      if (state === "open" && inner) {
        inner.send(frame);
      } else {
        preOpenQueue.push(frame);
      }
    },
    close: () => {
      manualClose = true;
      reconnect.cancel();
      inner?.close();
      inner = null;
      setState("closed");
    },
    getState: () => state,
  };
}

// --- Workflow-run WS ---

export interface WorkflowRunWsCallbacks {
  onFrame: (frame: WorkflowFrame) => void;
  onClose: () => void;
  onOpen?: () => void;
  onError?: (e: Event) => void;
}

export interface WorkflowRunWsHandle {
  close: () => void;
}

// Single-use, non-reconnecting workflow-run stream. Runs are bounded
// (per-node timeout + abort) and the server's connection manager doesn't
// replay history on reopen — the source of truth for catch-up is
// `getWorkflowRun(runId)` (REST). A dropped client just loses the live
// tail; the reconnecting wrapper below handles the reopen ceremony and
// the hook layer re-fetches the run snapshot on each fresh open.
export function openWorkflowRunWs(
  runId: string,
  callbacks: WorkflowRunWsCallbacks,
): WorkflowRunWsHandle {
  const ws = new WebSocket(buildWorkflowRunWsUrl(runId));
  ws.onopen = () => callbacks.onOpen?.();
  ws.onmessage = (e) => {
    try {
      const frame = workflowFrameSchema.parse(JSON.parse(e.data as string));
      callbacks.onFrame(frame);
    } catch {
      // Malformed / version-mismatched frame — drop. Server enforces
      // version on emit, so this is wire-drift, not per-frame corruption.
    }
  };
  ws.onclose = () => callbacks.onClose();
  ws.onerror = (e) => callbacks.onError?.(e);
  return { close: () => ws.close() };
}

export interface ReconnectingWorkflowRunCallbacks {
  onFrame: (frame: WorkflowFrame) => void;
  onStateChange?: (state: ReconnectingWsState) => void;
}

export interface ReconnectingWorkflowRunOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFraction?: number;
}

export interface ReconnectingWorkflowRunHandle {
  close: () => void;
  // Stops auto-reconnect without closing the live socket. Caller invokes
  // this when the run reaches a terminal status (`run_done`) so the
  // server's clean close doesn't trigger an immediate reopen-and-close
  // loop. Idempotent.
  stopReconnecting: () => void;
  getState: () => ReconnectingWsState;
}

export function createReconnectingWorkflowRunWs(
  runId: string,
  callbacks: ReconnectingWorkflowRunCallbacks,
  options: ReconnectingWorkflowRunOptions = {},
): ReconnectingWorkflowRunHandle {
  const reconnect = createReconnectSchedule(options);
  let state: ReconnectingWsState = "connecting";
  let inner: WorkflowRunWsHandle | null = null;
  let manualClose = false;
  // Soft form of manualClose — set on terminal (run_done) so the server's
  // graceful close doesn't trigger reopen-and-close forever. Distinct so
  // getState() can still report "open" until the server actually closes,
  // instead of jumping to "closed".
  let stoppedReconnecting = false;

  const setState = (next: ReconnectingWsState): void => {
    if (state === next) return;
    state = next;
    callbacks.onStateChange?.(next);
  };

  const open = (): void => {
    setState(reconnect.openingState());
    inner = openWorkflowRunWs(runId, {
      onFrame: callbacks.onFrame,
      onOpen: () => {
        if (!inner || manualClose) return;
        reconnect.resetAttempts();
        setState("open");
      },
      onClose: () => {
        inner = null;
        if (manualClose || stoppedReconnecting) {
          setState("closed");
          return;
        }
        scheduleReconnect();
      },
      onError: () => {
        // close handler drives reconnect; avoid double-scheduling.
      },
    });
  };

  const scheduleReconnect = (): void => {
    if (manualClose || stoppedReconnecting) return;
    setState("reconnecting");
    reconnect.schedule(open);
  };

  open();

  return {
    close: () => {
      manualClose = true;
      reconnect.cancel();
      inner?.close();
      inner = null;
      setState("closed");
    },
    stopReconnecting: () => {
      stoppedReconnecting = true;
      reconnect.cancel();
    },
    getState: () => state,
  };
}

// --- Snapshot WS ---

export interface SnapshotWsCallbacks {
  onFrame: (frame: SnapshotFrame) => void;
  onClose: () => void;
  onOpen?: () => void;
  onError?: (e: Event) => void;
}

export interface SnapshotWsHandle {
  close: () => void;
}

// Single-use snapshot stream for one key. The server does NOT replay the latest
// frame on connect, so the hook layer hydrates via GET /api/snapshots/:key and
// re-hydrates on each fresh open (see createReconnectingSnapshotWs.onOpen).
export function openSnapshotWs(key: string, callbacks: SnapshotWsCallbacks): SnapshotWsHandle {
  const ws = new WebSocket(buildSnapshotWsUrl(key));
  ws.onopen = () => callbacks.onOpen?.();
  ws.onmessage = (e) => {
    try {
      const frame = snapshotFrameSchema.parse(JSON.parse(e.data as string));
      callbacks.onFrame(frame);
    } catch {
      // Malformed / version-mismatched frame — drop. Manager owns the shape.
    }
  };
  ws.onclose = () => callbacks.onClose();
  ws.onerror = (e) => callbacks.onError?.(e);
  return { close: () => ws.close() };
}

export interface ReconnectingSnapshotWsCallbacks {
  onFrame: (frame: SnapshotFrame) => void;
  onStateChange?: (state: ReconnectingWsState) => void;
  // Fired on each fresh OPEN. The server has no on-connect replay, so the hook
  // re-hydrates via GET here (and uses that to detect a key that's gone).
  onOpen?: () => void;
}

export interface ReconnectingSnapshotWsHandle {
  close: () => void;
  getState: () => ReconnectingWsState;
}

// Reconnecting snapshot stream. Unlike the workflow-run wrapper there is no
// terminal frame, so it reconnects like the chat wrapper. The consumer (the
// useSnapshot hook) calls close() when a re-hydrate shows the key is gone, so a
// producer that unregistered its key doesn't drive an endless reopen loop.
export function createReconnectingSnapshotWs(
  key: string,
  callbacks: ReconnectingSnapshotWsCallbacks,
  options: ReconnectingWorkflowRunOptions = {},
): ReconnectingSnapshotWsHandle {
  const reconnect = createReconnectSchedule(options);
  let state: ReconnectingWsState = "connecting";
  let inner: SnapshotWsHandle | null = null;
  let manualClose = false;

  const setState = (next: ReconnectingWsState): void => {
    if (state === next) return;
    state = next;
    callbacks.onStateChange?.(next);
  };

  const open = (): void => {
    setState(reconnect.openingState());
    inner = openSnapshotWs(key, {
      onFrame: callbacks.onFrame,
      onOpen: () => {
        if (!inner || manualClose) return;
        reconnect.resetAttempts();
        setState("open");
        callbacks.onOpen?.();
      },
      onClose: () => {
        inner = null;
        if (manualClose) {
          setState("closed");
          return;
        }
        scheduleReconnect();
      },
      onError: () => {
        // close handler drives reconnect; avoid double-scheduling.
      },
    });
  };

  const scheduleReconnect = (): void => {
    if (manualClose) return;
    setState("reconnecting");
    reconnect.schedule(open);
  };

  open();

  return {
    close: () => {
      manualClose = true;
      reconnect.cancel();
      inner?.close();
      inner = null;
      setState("closed");
    },
    getState: () => state,
  };
}
