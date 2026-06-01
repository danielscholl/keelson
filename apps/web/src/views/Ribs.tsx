// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type {
  CanvasDocument,
  RibActionDescriptor,
  RibSummary,
  RibViewDescriptor,
} from "@keelson/shared";
import { useCallback, useState } from "react";

import { postRibAction } from "../api.ts";
import { useCanvas } from "../components/Canvas/CanvasHost.tsx";
import { useToast } from "../components/Toast.tsx";
import { useRibs } from "../hooks/useRibs.ts";

export function Ribs() {
  const { status, ribs, error, refresh } = useRibs();
  const { openCanvas } = useCanvas();
  const toast = useToast();

  const openView = useCallback(
    (view: RibViewDescriptor) => {
      const doc: CanvasDocument = {
        kind: view.canvasKind,
        source: { type: "snapshot", key: view.key },
        ...(view.title ? { title: view.title } : {}),
      };
      openCanvas(doc);
    },
    [openCanvas],
  );

  const runAction = useCallback(
    async (ribId: string, action: RibActionDescriptor) => {
      try {
        const result = await postRibAction(ribId, { type: action.type });
        if (result.ok) {
          toast.push({ kind: "ok", message: `${action.label} ✓` });
        } else {
          toast.push({ kind: "error", message: `${action.label}: ${result.error}` });
        }
      } catch (err) {
        toast.push({
          kind: "error",
          message: `${action.label} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [toast],
  );

  return (
    <div className="page ribs-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Ribs</h1>
          <div className="page-sub">
            Extensions discovered at boot. Each rib brings its own tools, live views, and actions —
            the harness stays out of the way.
          </div>
        </div>
        <button type="button" className="memory-refresh" onClick={refresh} title="Refresh">
          Refresh
        </button>
      </header>

      {status === "loading" && (
        <div className="page-sub" style={{ padding: "20px 0" }}>
          Loading…
        </div>
      )}
      {status === "error" && (
        <div className="empty-state" role="alert">
          <div className="empty-state-title">Couldn't load ribs</div>
          <div className="empty-state-body">{error}</div>
        </div>
      )}
      {status === "ready" && ribs.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden>
            ◌
          </div>
          <div className="empty-state-title">No ribs installed</div>
          <div className="empty-state-body">
            Ribs ship as <code>@keelson/rib-*</code> packages, discovered from{" "}
            <code>node_modules/@keelson/</code> at boot and filtered by <code>KEELSON_RIBS</code>.
            Install one and restart the server to see it here.
          </div>
        </div>
      )}
      {status === "ready" && ribs.length > 0 && (
        <ul className="ribs-list">
          {ribs.map((rib) => (
            <RibCard key={rib.id} rib={rib} onOpenView={openView} onRunAction={runAction} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RibCard(props: {
  rib: RibSummary;
  onOpenView: (view: RibViewDescriptor) => void;
  onRunAction: (ribId: string, action: RibActionDescriptor) => Promise<void>;
}) {
  const { rib, onOpenView, onRunAction } = props;
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  return (
    <li className="rib-card">
      <div className="rib-card-head">
        <span className="rib-name">{rib.displayName}</span>
        <RibAuthBadge rib={rib} />
      </div>
      {rib.registered.length > 0 && (
        <div className="rib-tools page-sub">Tools: {rib.registered.join(", ")}</div>
      )}
      {rib.views.length > 0 ? (
        <div className="rib-views">
          {rib.views.map((view) => (
            <button
              type="button"
              key={view.key}
              className="rib-view-button"
              onClick={() => onOpenView(view)}
            >
              {view.title ?? view.key}
            </button>
          ))}
        </div>
      ) : (
        <div className="rib-views page-sub">No views</div>
      )}
      {rib.hasOnAction && rib.actions.length > 0 && (
        <div className="rib-actions">
          {rib.actions.map((action) => (
            <button
              type="button"
              key={action.type}
              className="rib-action-button"
              disabled={pendingAction === action.type}
              onClick={async () => {
                if (pendingAction === action.type) return;
                setPendingAction(action.type);
                try {
                  await onRunAction(rib.id, action);
                } finally {
                  setPendingAction(null);
                }
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function RibAuthBadge({ rib }: { rib: RibSummary }) {
  if (!rib.auth) return null;
  const ok = rib.auth.authenticated;
  return (
    <span
      className={`rib-auth-badge${ok ? " is-ok" : " is-warn"}`}
      title={rib.auth.statusMessage ?? (ok ? "Authenticated" : "Needs authentication")}
    >
      {ok ? "Authenticated" : "Needs auth"}
    </span>
  );
}
