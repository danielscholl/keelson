import type { CanvasDocument, CanvasHtmlAction, CanvasSource, OpenChatSeed } from "@keelson/shared";
import { ribIdFromKey } from "@keelson/shared";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getRunArtifact } from "../../api.ts";
import { useRibActionDispatch } from "../../hooks/useRibActionDispatch.ts";
import { useSnapshot } from "../../hooks/useSnapshot.ts";
import { snapshotToMarkdown } from "../../lib/exploreSeed.ts";
import { MarkdownContent } from "../Chat/MarkdownContent.tsx";
import { useCanvasKindForKey } from "../RibsProvider.tsx";
import { BoardActionProvider } from "./BoardActionContext.tsx";
import { SandboxedHtml } from "./SandboxedHtml.tsx";
import { ViewBody } from "./ViewBody.tsx";

// Optional host-side extras passed when opening. `footer` is a live ReactNode
// (e.g. an approval composer), kept out of the serializable CanvasDocument so
// the contract stays a pure data shape — the drawer just renders whatever it's
// handed in a docked footer below the scrollable body.
interface CanvasOpenOptions {
  footer?: ReactNode;
  // A board action rendered in the drawer may return an open-chat directive; the
  // opener (e.g. a surface region) supplies the handler so the drawer's Enter
  // buttons behave like the inline panel's instead of silently no-op'ing.
  onOpenChat?: (seed: OpenChatSeed) => void | Promise<void>;
  // Likewise a run-workflow directive: the opener supplies the launch handler so
  // a drawer launch button isn't swallowed with a success toast.
  onLaunchWorkflow?: (workflow: string, args: Record<string, string>) => void | Promise<void>;
}

interface CanvasApi {
  openCanvas: (doc: CanvasDocument, opts?: CanvasOpenOptions) => void;
  close: () => void;
}

interface CanvasState {
  doc: CanvasDocument;
  footer: ReactNode;
  onOpenChat?: (seed: OpenChatSeed) => void | Promise<void>;
  onLaunchWorkflow?: (workflow: string, args: Record<string, string>) => void | Promise<void>;
}

const CanvasContext = createContext<CanvasApi | null>(null);

export function useCanvas(): CanvasApi {
  const ctx = useContext(CanvasContext);
  if (!ctx) {
    // No-op fallback (mirrors useToast) so components used outside the provider
    // — including in tests that skip the wrapper — don't crash.
    return { openCanvas: () => undefined, close: () => undefined };
  }
  return ctx;
}

// App-level canvas surface: a full-width sheet that presents a CanvasDocument
// at comfortable reading width and, optionally, a docked footer (e.g. the
// approval composer for a paused workflow plan). Escape and the close button
// dismiss it; dismissing never runs a footer action — only the footer's own
// controls do.
export function CanvasProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CanvasState | null>(null);
  const openCanvas = useCallback(
    (doc: CanvasDocument, opts?: CanvasOpenOptions) =>
      setState({
        doc,
        footer: opts?.footer ?? null,
        onOpenChat: opts?.onOpenChat,
        onLaunchWorkflow: opts?.onLaunchWorkflow,
      }),
    [],
  );
  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, close]);

  return (
    <CanvasContext.Provider value={{ openCanvas, close }}>
      {children}
      {state && (
        <CanvasDrawer
          doc={state.doc}
          footer={state.footer}
          {...(state.onOpenChat ? { onOpenChat: state.onOpenChat } : {})}
          {...(state.onLaunchWorkflow ? { onLaunchWorkflow: state.onLaunchWorkflow } : {})}
          onClose={close}
        />
      )}
    </CanvasContext.Provider>
  );
}

function CanvasDrawer({
  doc,
  footer,
  onOpenChat,
  onLaunchWorkflow,
  onClose,
}: {
  doc: CanvasDocument;
  footer: ReactNode;
  onOpenChat?: (seed: OpenChatSeed) => void | Promise<void>;
  onLaunchWorkflow?: (workflow: string, args: Record<string, string>) => void | Promise<void>;
  onClose: () => void;
}) {
  const title = doc.title ?? "Canvas";
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus into the dialog on open and restore it to the opener on close,
  // so a keyboard/SR user lands in the modal and returns to where they were
  // (the drawer only mounts while open, so mount/unmount bracket the lifetime).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

  // Trap Tab/Shift+Tab within the dialog: the page beneath the sheet isn't
  // inert, so without this Tab would walk focus to controls hidden behind it.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  return (
    <>
      <div className="canvas-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        ref={dialogRef}
        className={`canvas-drawer canvas-drawer-${doc.kind}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
      >
        <header className="canvas-drawer-header">
          <span className="canvas-drawer-title">{title}</span>
          <button
            ref={closeRef}
            type="button"
            className="canvas-drawer-close"
            onClick={onClose}
            aria-label="Close canvas"
          >
            ×
          </button>
        </header>
        <div className="canvas-drawer-body">
          <CanvasBody doc={doc} onOpenChat={onOpenChat} onLaunchWorkflow={onLaunchWorkflow} />
        </div>
        {footer && <footer className="canvas-drawer-footer">{footer}</footer>}
      </aside>
    </>
  );
}

// Closed canvas-kind registry: every CanvasKind has an explicit branch, and a
// new kind makes this a compile error rather than a silent blank render.
function CanvasBody({
  doc,
  onOpenChat,
  onLaunchWorkflow,
}: {
  doc: CanvasDocument;
  onOpenChat?: (seed: OpenChatSeed) => void | Promise<void>;
  onLaunchWorkflow?: (workflow: string, args: Record<string, string>) => void | Promise<void>;
}) {
  switch (doc.kind) {
    case "markdown":
      return <MarkdownBody source={doc.source} />;
    case "view":
      // Key by source so switching sources remounts with fresh state.
      return (
        <ViewCanvas
          key={sourceKey(doc.source)}
          source={doc.source}
          onOpenChat={onOpenChat}
          onLaunchWorkflow={onLaunchWorkflow}
        />
      );
    case "html":
      return <HtmlCanvas key={sourceKey(doc.source)} source={doc.source} />;
    default: {
      const exhaustive: never = doc.kind;
      return exhaustive;
    }
  }
}

// A drawer-rendered board can carry an `actions` section; dispatch it to the
// owning rib (id from the snapshot key). Unlike a surface region there's no
// post-success reload here — the drawer's open WS pushes the recomposed frame.
function ViewCanvas({
  source,
  onOpenChat,
  onLaunchWorkflow,
}: {
  source: CanvasSource;
  onOpenChat?: (seed: OpenChatSeed) => void | Promise<void>;
  onLaunchWorkflow?: (workflow: string, args: Record<string, string>) => void | Promise<void>;
}) {
  const ribId = source.type === "snapshot" ? ribIdFromKey(source.key) : null;
  const { openCanvas, close } = useCanvas();
  const resolveCanvasKind = useCanvasKindForKey();
  // Each wrapper is wired into the dispatcher only when its handler is present
  // (the spread guard below), so the presence check here is the single source of
  // truth — an unwired wrapper must never navigate away on a swallowed effect, so
  // close() only fires once the handler has. close() stays synchronous (navigate
  // away immediately), but the wrapper returns the handler's promise so the
  // dispatcher's await still spans the launch, keeping the awaited contract
  // uniform with the inline path.
  const onOpenChatAndClose = useCallback(
    (seed: OpenChatSeed) => {
      if (!onOpenChat) return;
      const pending = Promise.resolve(onOpenChat(seed));
      close();
      return pending;
    },
    [onOpenChat, close],
  );
  const onLaunchWorkflowAndClose = useCallback(
    (workflow: string, args: Record<string, string>) => {
      if (!onLaunchWorkflow) return;
      const pending = Promise.resolve(onLaunchWorkflow(workflow, args));
      close();
      return pending;
    },
    [onLaunchWorkflow, close],
  );
  // An open-canvas directive from a board rendered IN the drawer drills into
  // another snapshot by replacing this drawer's doc — openCanvas is context-
  // available here, so it's sourced locally rather than threaded from the opener
  // (the key difference from onOpenChat/onLaunchWorkflow). Pass the drawer's own
  // effect handlers into the replacement doc's opts so its board acts like inline.
  const onOpenCanvas = useCallback(
    (key: string, title?: string) =>
      openCanvas(
        {
          kind: resolveCanvasKind(key),
          source: { type: "snapshot", key },
          ...(title ? { title } : {}),
        },
        {
          ...(onOpenChat ? { onOpenChat } : {}),
          ...(onLaunchWorkflow ? { onLaunchWorkflow } : {}),
        },
      ),
    [openCanvas, onOpenChat, onLaunchWorkflow, resolveCanvasKind],
  );
  const actions = useRibActionDispatch(ribId, {
    ...(onOpenChat ? { onOpenChat: onOpenChatAndClose } : {}),
    ...(onLaunchWorkflow ? { onLaunchWorkflow: onLaunchWorkflowAndClose } : {}),
    onOpenCanvas,
  });
  if (!ribId) return <ViewBody source={source} />;
  return (
    <BoardActionProvider run={actions.run} reveal={actions.reveal}>
      <ViewBody source={source} />
    </BoardActionProvider>
  );
}

function sourceKey(source: CanvasSource): string {
  switch (source.type) {
    case "inline":
      return `inline:${source.text}`;
    case "artifact":
      return `artifact:${source.runId}/${source.path}`;
    case "snapshot":
      return `snapshot:${source.key}`;
  }
}

function MarkdownBody({ source }: { source: CanvasSource }) {
  if (source.type === "inline") {
    return <MarkdownContent source={source.text} />;
  }
  if (source.type === "artifact") {
    // Key by identity so switching to a different artifact while the drawer is
    // open remounts with fresh loading state (no stale-content flash).
    return (
      <ArtifactBody
        key={`${source.runId}/${source.path}`}
        runId={source.runId}
        path={source.path}
      />
    );
  }
  if (source.type === "snapshot") {
    // Key by the snapshot key so switching keys remounts with fresh state.
    return <SnapshotBody key={source.key} snapshotKey={source.key} />;
  }
  // CanvasSource is inline | artifact | snapshot — all handled above. A new
  // member makes this a compile error rather than a silent blank render.
  const exhaustive: never = source;
  return exhaustive;
}

type ArtifactState =
  | { status: "loading" }
  | { status: "ok"; text: string }
  | { status: "gone" }
  | { status: "error"; error: string };

function ArtifactBody({
  runId,
  path,
  render = (text) => <MarkdownContent source={text} />,
}: {
  runId: string;
  path: string;
  render?: (text: string) => ReactNode;
}) {
  const [state, setState] = useState<ArtifactState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getRunArtifact(runId, path)
      .then((res) => {
        if (cancelled) return;
        // null === 404: the run finished and its scratch dir was cleaned up.
        setState(res === null ? { status: "gone" } : { status: "ok", text: res.content });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [runId, path]);

  if (state.status === "loading") {
    return <p className="canvas-drawer-note">Loading {path}…</p>;
  }
  if (state.status === "gone") {
    return (
      <p className="canvas-drawer-note">
        This artifact is no longer available — the run has finished and its scratch files were
        cleaned up.
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="canvas-drawer-note canvas-drawer-error">
        Failed to load {path}: {state.error}
      </p>
    );
  }
  return render(state.text);
}

function SnapshotBody({
  snapshotKey,
  render = (data) => <MarkdownContent source={snapshotToMarkdown(data)} />,
}: {
  snapshotKey: string;
  render?: (data: unknown) => ReactNode;
}) {
  const snapshot = useSnapshot(snapshotKey);
  if (snapshot.status === "loading") {
    return <p className="canvas-drawer-note">Loading…</p>;
  }
  if (snapshot.status === "error") {
    return <p className="canvas-drawer-note canvas-drawer-error">Failed to load this snapshot.</p>;
  }
  if (snapshot.status === "empty") {
    return <p className="canvas-drawer-note">Waiting for the first update…</p>;
  }
  return render(snapshot.data);
}

// A `kind: "html"` canvas: untrusted rib markup rendered in a sandboxed iframe.
// Actions the frame posts dispatch to the rib that owns the source's snapshot key
// (derived host-side, like ViewCanvas); inline/artifact html has no owning rib, so
// its actions are a silent no-op rather than reaching an arbitrary one.
function HtmlCanvas({ source }: { source: CanvasSource }) {
  const ribId = source.type === "snapshot" ? ribIdFromKey(source.key) : null;
  const { run } = useRibActionDispatch(ribId);
  const onAction = useCallback(
    (action: CanvasHtmlAction) => {
      // Stamp origin "canvas-html" so the owning rib can gate this untrusted
      // frame-relayed verb. Only `type`/`payload` come from the frame; the frame
      // never sees or sets `origin`, so it can't pass itself off as a board action.
      if (ribId) void run({ type: action.type, payload: action.payload, origin: "canvas-html" });
    },
    [ribId, run],
  );
  return <HtmlBody source={source} onAction={onAction} />;
}

function HtmlBody({
  source,
  onAction,
}: {
  source: CanvasSource;
  onAction: (action: CanvasHtmlAction) => void;
}) {
  if (source.type === "inline") {
    return <SandboxedHtml html={source.text} onAction={onAction} />;
  }
  if (source.type === "artifact") {
    return (
      <ArtifactBody
        key={`${source.runId}/${source.path}`}
        runId={source.runId}
        path={source.path}
        render={(text) => <SandboxedHtml html={text} onAction={onAction} />}
      />
    );
  }
  if (source.type === "snapshot") {
    // A `kind: "html"` snapshot frame must carry an HTML string; structured data
    // (e.g. a `view` payload published under the wrong key) fails closed to a note.
    return (
      <SnapshotBody
        key={source.key}
        snapshotKey={source.key}
        render={(data) =>
          typeof data === "string" ? (
            <SandboxedHtml html={data} onAction={onAction} />
          ) : (
            <p className="canvas-drawer-note canvas-drawer-error">
              This HTML canvas expected text but received structured data.
            </p>
          )
        }
      />
    );
  }
  const exhaustive: never = source;
  return exhaustive;
}
