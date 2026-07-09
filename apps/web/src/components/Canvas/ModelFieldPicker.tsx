// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ModelInfo } from "@keelson/shared";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  COST_LABEL,
  groupByVendor,
  type ModelCatalog,
  prettyVendor,
  useModelCatalog,
} from "../../lib/modelCatalog.ts";

function findInfo(
  catalog: ModelCatalog | null,
  modelId: string,
  providerId: string,
): { info: ModelInfo; providerId: string } | null {
  if (!catalog || !modelId) return null;
  for (const p of catalog.providers) {
    if (providerId && p.id !== providerId) continue;
    const info = (catalog.modelsByProvider[p.id] ?? []).find((m) => m.id === modelId);
    if (info) return { info, providerId: p.id };
  }
  return null;
}

// The live provider/model catalog in a searchable popover (the chat picker's
// look, minus favorites) — the shared panel behind both modelPicker renderings:
// the form-field trigger below, and BoardView's direct-from-the-action-button
// path for an action whose only field is the picker. Anchors to the element
// `anchorId` names via the popoverTarget contract.
interface ModelCatalogPopoverProps {
  popoverId: string;
  anchorId: string;
  value: string;
  // The companion provider value currently held, so the active row highlights
  // the exact provider/model pair rather than the first id match.
  providerValue: string;
  // The clear row's label.
  emptyLabel: string;
  // A required field offers no clear row — there's no "none" to pick.
  required: boolean;
  onPick: (modelId: string, providerId: string) => void;
}

export function ModelCatalogPopover({
  popoverId,
  anchorId,
  value,
  providerValue,
  emptyLabel,
  required,
  onPick,
}: ModelCatalogPopoverProps) {
  const { catalog, failed, reload } = useModelCatalog();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  // The body's provider/model rows mount only while the popover is actually
  // open — an idle roster of N cards each holding a 200-model catalog would
  // otherwise sit on N×200 hidden buttons at all times (the popover's own
  // `display: none` when closed hides them visually but not from the DOM).
  const [isOpen, setIsOpen] = useState(false);

  const active = useMemo(
    () => findInfo(catalog, value, providerValue),
    [catalog, value, providerValue],
  );

  // Anchor the popover to the trigger at open-time — the same fixed-position
  // top-layer approach the chat pickers use, so the list escapes any
  // overflow-clipped board container it renders inside.
  const reposition = useCallback(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const trigger = document.getElementById(anchorId);
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom;
    const spaceAbove = rect.top;
    const margin = 6;
    const openDown = spaceBelow >= 240 || spaceBelow >= spaceAbove;
    if (openDown) {
      popoverEl.style.top = `${Math.round(rect.bottom + margin)}px`;
      popoverEl.style.bottom = "auto";
      popoverEl.style.maxHeight = `${Math.max(180, Math.round(spaceBelow - margin * 2))}px`;
    } else {
      popoverEl.style.bottom = `${Math.round(viewportH - rect.top + margin)}px`;
      popoverEl.style.top = "auto";
      popoverEl.style.maxHeight = `${Math.max(180, Math.round(spaceAbove - margin * 2))}px`;
    }
    popoverEl.style.left = `${Math.round(rect.left)}px`;
    popoverEl.style.minWidth = `${Math.max(280, Math.round(rect.width))}px`;
  }, [anchorId]);

  useEffect(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const onToggle = (e: Event) => {
      const evt = e as ToggleEvent;
      const nowOpen = evt.newState === "open";
      setIsOpen(nowOpen);
      if (nowOpen) {
        reposition();
        setQuery("");
        // A transient catalog failure retries on each open, so the popover
        // recovers without a page reload.
        if (!catalog) reload();
        queueMicrotask(() => searchInputRef.current?.focus());
      }
    };
    popoverEl.addEventListener("toggle", onToggle);
    return () => popoverEl.removeEventListener("toggle", onToggle);
  }, [reposition, catalog, reload]);

  useEffect(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const onResize = () => {
      if (!popoverEl.matches(":popover-open")) return;
      reposition();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [reposition]);

  const providers = catalog?.providers ?? [];
  const modelsByProvider = catalog?.modelsByProvider ?? {};

  const filterMatches = useCallback(
    (providerId: string, info: ModelInfo): boolean => {
      if (!query) return true;
      const q = query.toLowerCase();
      if (info.id.toLowerCase().includes(q)) return true;
      if (info.displayName?.toLowerCase().includes(q)) return true;
      const label = providers.find((p) => p.id === providerId)?.displayName.toLowerCase() ?? "";
      return label.includes(q);
    },
    [providers, query],
  );

  const flatVisible = useMemo(() => {
    const out: { providerId: string; info: ModelInfo }[] = [];
    for (const p of providers) {
      for (const info of modelsByProvider[p.id] ?? []) {
        if (filterMatches(p.id, info)) out.push({ providerId: p.id, info });
      }
    }
    return out;
  }, [providers, modelsByProvider, filterMatches]);

  const pick = useCallback(
    (modelId: string, providerId: string) => {
      onPick(modelId, providerId);
      popoverRef.current?.hidePopover?.();
    },
    [onPick],
  );

  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const first = flatVisible[0];
        if (first) pick(first.info.id, first.providerId);
      }
    },
    [flatVisible, pick],
  );

  return (
    <div
      ref={popoverRef}
      id={popoverId}
      popover="auto"
      className="model-picker-popover"
      role="dialog"
      aria-label="Pick a model"
    >
      <div className="model-picker-popover-search-wrap">
        <input
          ref={searchInputRef}
          type="text"
          className="model-picker-popover-search"
          placeholder="Search models or providers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-label="Search models"
        />
      </div>
      <div className="model-picker-popover-body">
        {isOpen && (
          <>
            {!required && !query && (
              <div className={`model-picker-popover-row${value === "" ? " active" : ""}`}>
                <button
                  type="button"
                  className="model-picker-popover-pick"
                  onClick={() => pick("", "")}
                  popoverTarget={popoverId}
                  popoverTargetAction="hide"
                >
                  <span className="model-picker-popover-pick-id cvb-action-field-model-empty">
                    {emptyLabel}
                  </span>
                </button>
              </div>
            )}
            {providers.map((provider) => {
              const visible = (modelsByProvider[provider.id] ?? []).filter((info) =>
                filterMatches(provider.id, info),
              );
              if (visible.length === 0) return null;
              const renderRow = (info: ModelInfo) => {
                const isActive =
                  value !== "" && active?.providerId === provider.id && active.info.id === info.id;
                const showRawId = Boolean(info.displayName) && info.displayName !== info.id;
                const parts: string[] = [];
                if (showRawId) parts.push(info.id);
                if (info.description) parts.push(info.description);
                return (
                  <div
                    key={info.id}
                    className={`model-picker-popover-row${isActive ? " active" : ""}`}
                  >
                    <button
                      type="button"
                      className="model-picker-popover-pick"
                      onClick={() => pick(info.id, provider.id)}
                      popoverTarget={popoverId}
                      popoverTargetAction="hide"
                      title={parts.length > 0 ? parts.join(" — ") : undefined}
                    >
                      <span className="model-picker-popover-pick-id">
                        {info.displayName ?? info.id}
                      </span>
                      {(info.costTier || info.billing === "metered") && (
                        <span className="model-picker-popover-pick-meta">
                          {info.costTier && (
                            <span
                              className={`model-picker-popover-pick-cost cost-${info.costTier}`}
                              role="img"
                              aria-label={`Cost tier: ${info.costTier}`}
                            >
                              {COST_LABEL[info.costTier]}
                            </span>
                          )}
                          {info.billing === "metered" && (
                            <span
                              className="model-picker-popover-pick-billing"
                              role="img"
                              title="Metered — billed per token via an API key"
                              aria-label="Metered: billed per token via an API key"
                            >
                              API
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  </div>
                );
              };
              return (
                <div key={provider.id} className="model-picker-popover-section">
                  <div className="model-picker-popover-section-title">
                    <span>{provider.displayName}</span>
                    <span className="model-picker-popover-section-count">{visible.length}</span>
                  </div>
                  <div className="model-picker-popover-section-rows">
                    {groupByVendor(visible).map((group) => (
                      <Fragment key={group.models[0]?.id ?? group.vendor ?? "vendor"}>
                        {group.vendor && (
                          <div className="model-picker-popover-vendor-title">
                            <span>{prettyVendor(group.vendor)}</span>
                            <span className="model-picker-popover-vendor-count">
                              {group.models.length}
                            </span>
                          </div>
                        )}
                        {group.models.map(renderRow)}
                      </Fragment>
                    ))}
                  </div>
                </div>
              );
            })}
            {flatVisible.length === 0 && (
              <div className="model-picker-popover-empty">
                {catalog ? (
                  "No models match."
                ) : failed ? (
                  <>
                    Couldn’t load the model catalog.{" "}
                    <button type="button" className="model-picker-popover-retry" onClick={reload}>
                      Retry
                    </button>
                  </>
                ) : (
                  "Loading models…"
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// The form-field rendering of a `modelPicker` action field: an input-shaped
// trigger holding the current selection, used when the picker sits alongside
// other fields in an action form. An action whose ONLY field is the picker
// skips this entirely — BoardView wires the action button straight to the
// popover and dispatches on pick.
interface ModelFieldPickerProps {
  id: string;
  value: string;
  providerValue: string;
  placeholder?: string;
  required: boolean;
  disabled: boolean;
  onPick: (modelId: string, providerId: string) => void;
}

export function ModelFieldPicker({
  id,
  value,
  providerValue,
  placeholder,
  required,
  disabled,
  onPick,
}: ModelFieldPickerProps) {
  const { catalog } = useModelCatalog();
  const popoverId = `${useId()}-models`;
  const emptyLabel = placeholder ?? "default";
  const active = useMemo(
    () => findInfo(catalog, value, providerValue),
    [catalog, value, providerValue],
  );
  const triggerLabel = value ? (active?.info.displayName ?? value) : emptyLabel;

  return (
    <>
      <button
        type="button"
        id={id}
        className="cvb-action-field-input cvb-action-field-model"
        popoverTarget={popoverId}
        disabled={disabled}
        aria-haspopup="dialog"
        title="Change model"
      >
        <span className={value ? undefined : "cvb-action-field-model-empty"}>{triggerLabel}</span>
        <span className="cvb-action-field-model-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <ModelCatalogPopover
        popoverId={popoverId}
        anchorId={id}
        value={value}
        providerValue={providerValue}
        emptyLabel={emptyLabel}
        required={required}
        onPick={onPick}
      />
    </>
  );
}
