import type { CanvasDocument, CanvasSource } from "@keelson/shared";
import { ribIdFromKey } from "@keelson/shared";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getRunArtifact } from "../../api.ts";
import { useRibActionDispatch } from "../../hooks/useRibActionDispatch.ts";
import { useSnapshot } from "../../hooks/useSnapshot.ts";
import { MarkdownContent } from "../Chat/MarkdownContent.tsx";
import { BoardActionProvider } from "./BoardActionContext.tsx";
import { ViewBody } from "./ViewBody.tsx";

// Optional host-side extras passed when opening. `footer` is a live ReactNode
// (e.g. an approval composer), kept out of the serializable CanvasDocument so
// the contract stays a pure data shape — the drawer just renders whatever it's
// handed in a docked footer below the scrollable body.
interface CanvasOpenOptions {
  footer?: ReactNode;
}

interface CanvasApi {
  openCanvas: (doc: CanvasDocument, opts?: CanvasOpenOptions) => void;
  close: () => void;
}

interface CanvasState {
  doc: CanvasDocument;
  footer: ReactNode;
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
      setState({ doc, footer: opts?.footer ?? null }),
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
      {state && <CanvasDrawer doc={state.doc} footer={state.footer} onClose={close} />}
    </CanvasContext.Provider>
  );
}

function CanvasDrawer({
  doc,
  footer,
  onClose,
}: {
  doc: CanvasDocument;
  footer: ReactNode;
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
        <CanvasBody doc={doc} />
      </div>
      {footer && <footer className="canvas-drawer-footer">{footer}</footer>}
    </aside>
  );
}

// Closed canvas-kind registry: every CanvasKind has an explicit branch, and a
// new kind makes this a compile error rather than a silent blank render. `html`
// stays reserved until the iframe-origin security pass.
function CanvasBody({ doc }: { doc: CanvasDocument }) {
  switch (doc.kind) {
    case "markdown":
      return <MarkdownBody source={doc.source} />;
    case "view":
      // Key by source so switching sources remounts with fresh state.
      return <ViewCanvas key={sourceKey(doc.source)} source={doc.source} />;
    case "html":
      return (
        <p className="canvas-drawer-note">
          HTML canvases aren't supported yet — pending the iframe-origin security review.
        </p>
      );
    default: {
      const exhaustive: never = doc.kind;
      return exhaustive;
    }
  }
}

// A drawer-rendered board can carry an `actions` section; dispatch it to the
// owning rib (id from the snapshot key). Unlike a surface region there's no
// post-success reload here — the drawer's open WS pushes the recomposed frame.
function ViewCanvas({ source }: { source: CanvasSource }) {
  const ribId = source.type === "snapshot" ? ribIdFromKey(source.key) : null;
  const dispatch = useRibActionDispatch(ribId);
  if (!ribId) return <ViewBody source={source} />;
  return (
    <BoardActionProvider dispatch={dispatch}>
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

function ArtifactBody({ runId, path }: { runId: string; path: string }) {
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
  return <MarkdownContent source={state.text} />;
}

function SnapshotBody({ snapshotKey }: { snapshotKey: string }) {
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
  return <MarkdownContent source={snapshotToMarkdown(snapshot.data)} />;
}

// Coerce a snapshot's opaque `data` to markdown for a `markdown`-kind canvas. A
// plain string or a `{ markdown }` / `{ text }` object renders directly; any
// other shape is shown as a fenced JSON block. A producer wanting structured
// rendering uses a `view`-kind canvas (see ViewBody) instead.
function snapshotToMarkdown(data: unknown): string {
  if (typeof data === "string") return data;
  if (data !== null && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    if (typeof rec.markdown === "string") return rec.markdown;
    if (typeof rec.text === "string") return rec.text;
  }
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}
