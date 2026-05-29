import type { CanvasDocument } from "@keelson/shared";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getRunArtifact } from "../../api.ts";
import { MarkdownContent } from "../Chat/MarkdownContent.tsx";

interface CanvasApi {
  openCanvas: (doc: CanvasDocument) => void;
  close: () => void;
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

// App-level canvas surface: a right-side drawer that presents a CanvasDocument
// at comfortable reading width. Deliberately NON-modal — no click-capturing
// backdrop and no aria-modal/focus-trap — so an approval composer (or any
// surface) underneath stays usable while the drawer is open. Escape and the
// close button dismiss it.
export function CanvasProvider({ children }: { children: ReactNode }) {
  const [doc, setDoc] = useState<CanvasDocument | null>(null);
  const openCanvas = useCallback((d: CanvasDocument) => setDoc(d), []);
  const close = useCallback(() => setDoc(null), []);

  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [doc, close]);

  return (
    <CanvasContext.Provider value={{ openCanvas, close }}>
      {children}
      {doc && <CanvasDrawer doc={doc} onClose={close} />}
    </CanvasContext.Provider>
  );
}

function CanvasDrawer({ doc, onClose }: { doc: CanvasDocument; onClose: () => void }) {
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
    </aside>
  );
}

function CanvasBody({ doc }: { doc: CanvasDocument }) {
  if (doc.kind !== "markdown") {
    return (
      <p className="canvas-drawer-note">This canvas type ('{doc.kind}') is not yet supported.</p>
    );
  }
  if (doc.source.type === "inline") {
    return <MarkdownContent source={doc.source.text} />;
  }
  if (doc.source.type === "artifact") {
    // Key by identity so switching to a different artifact while the drawer is
    // open remounts with fresh loading state (no stale-content flash).
    return (
      <ArtifactBody
        key={`${doc.source.runId}/${doc.source.path}`}
        runId={doc.source.runId}
        path={doc.source.path}
      />
    );
  }
  // `snapshot` source is reserved — wired in a later stage.
  return (
    <p className="canvas-drawer-note">
      This canvas source ('{doc.source.type}') is not yet supported.
    </p>
  );
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
