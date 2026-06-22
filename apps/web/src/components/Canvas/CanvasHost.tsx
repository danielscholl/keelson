import type { CanvasDocument, CanvasHtmlAction, CanvasSource, OpenChatSeed } from "@keelson/shared";
import { ribIdFromKey } from "@keelson/shared";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getRunArtifact } from "../../api.ts";
import { useRibActionDispatch } from "../../hooks/useRibActionDispatch.ts";
import { useSnapshot } from "../../hooks/useSnapshot.ts";
import { snapshotToMarkdown } from "../../lib/exploreSeed.ts";
import { MarkdownContent } from "../Chat/MarkdownContent.tsx";
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
  onOpenChat?: (seed: OpenChatSeed) => void;
}

interface CanvasApi {
  openCanvas: (doc: CanvasDocument, opts?: CanvasOpenOptions) => void;
  close: () => void;
}

interface CanvasState {
  doc: CanvasDocument;
  footer: ReactNode;
  onOpenChat?: (seed: OpenChatSeed) => void;
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
      setState({ doc, footer: opts?.footer ?? null, onOpenChat: opts?.onOpenChat }),
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
  onClose,
}: {
  doc: CanvasDocument;
  footer: ReactNode;
  onOpenChat?: (seed: OpenChatSeed) => void;
  onClose: () => void;
}) {
  const title = doc.title ?? "Canvas";
  return (
    <aside className="canvas-drawer" role="dialog" aria-label={title}>
      <header className="canvas-drawer-header">
        <span className="canvas-drawer-title">{title}</span>
        <button
          type="button"
          className="canvas-drawer-close"
          onClick={onClose}
          aria-label="Close canvas"
        >
          ×
        </button>
      </header>
      <div className="canvas-drawer-body">
        <CanvasBody doc={doc} onOpenChat={onOpenChat} />
      </div>
      {footer && <footer className="canvas-drawer-footer">{footer}</footer>}
    </aside>
  );
}

// Closed canvas-kind registry: every CanvasKind has an explicit branch, and a
// new kind makes this a compile error rather than a silent blank render.
function CanvasBody({
  doc,
  onOpenChat,
}: {
  doc: CanvasDocument;
  onOpenChat?: (seed: OpenChatSeed) => void;
}) {
  switch (doc.kind) {
    case "markdown":
      return <MarkdownBody source={doc.source} />;
    case "view":
      // Key by source so switching sources remounts with fresh state.
      return <ViewCanvas key={sourceKey(doc.source)} source={doc.source} onOpenChat={onOpenChat} />;
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
}: {
  source: CanvasSource;
  onOpenChat?: (seed: OpenChatSeed) => void;
}) {
  const ribId = source.type === "snapshot" ? ribIdFromKey(source.key) : null;
  const { close } = useCanvas();
  // Opening a seeded chat navigates away (to a fresh chat); close the drawer so
  // it doesn't linger over the conversation.
  const onOpenChatAndClose = useCallback(
    (seed: OpenChatSeed) => {
      onOpenChat?.(seed);
      close();
    },
    [onOpenChat, close],
  );
  const actions = useRibActionDispatch(ribId, onOpenChat ? { onOpenChat: onOpenChatAndClose } : {});
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
      if (ribId) void run({ type: action.type, payload: action.payload });
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
