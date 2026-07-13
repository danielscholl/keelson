// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ModelInfo, ProviderInfo } from "@keelson/shared";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelRef } from "../../hooks/useSettings.ts";
import { COST_LABEL, groupByVendor, prettyVendor } from "../../lib/modelCatalog.ts";

interface ModelPickerPopoverProps {
  // Element id the chip's popoverTarget attribute references. Anchoring
  // is computed at open-time via getBoundingClientRect on the trigger
  // element (looked up via this id), so the popover follows the chip
  // even if the chip moves.
  popoverId: string;
  // Provider info — drives section headers and the "<providerLabel>" in
  // each row's prefix.
  providers: ProviderInfo[];
  // Empty entries render no section — keeps a signed-out Copilot from
  // showing a blank header.
  modelsByProvider: Record<string, ModelInfo[]>;
  // Currently-selected pair. Used to highlight the active row.
  activeRef: ModelRef | null;
  // ★-pinned models. Rendered in a separate "Favorites" section at the
  // top, in the order the user starred them.
  favorites: ModelRef[];
  // Set when a conversation is in progress — rows from OTHER providers
  // render disabled (the conversation is pinned to its provider in the
  // store; switching mid-stream would mix providers). Pass null on a
  // fresh chat so every row is selectable.
  lockedProviderId: string | null;
  onSelect: (ref: ModelRef) => void;
  onToggleFavorite: (ref: ModelRef) => void;
}

function makeRef(providerId: string, modelId: string): ModelRef {
  return { providerId, modelId };
}

function refKey(ref: ModelRef): string {
  return `${ref.providerId}::${ref.modelId}`;
}

// Cost is the only metadata that differentiates rows here. Vision is
// effectively universal across both providers' catalogs; thinking
// distinguishes providers, which the section header already shows.

export function ModelPickerPopover({
  popoverId,
  providers,
  modelsByProvider,
  activeRef,
  favorites,
  lockedProviderId,
  onSelect,
  onToggleFavorite,
}: ModelPickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");

  const favoritesKey = useMemo(() => new Set(favorites.map(refKey)), [favorites]);
  const providerLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of providers) m.set(p.id, p.displayName);
    return m;
  }, [providers]);

  // Fast lookup so the Favorites section can resolve metadata for ★
  // entries (whose ref is stored bare in settings) without re-walking
  // modelsByProvider on every render. Missing entries fall back to bare
  // `{ id }` so the row still renders.
  const infoByRef = useMemo(() => {
    const map = new Map<string, ModelInfo>();
    for (const [providerId, models] of Object.entries(modelsByProvider)) {
      for (const info of models) {
        map.set(refKey({ providerId, modelId: info.id }), info);
      }
    }
    return map;
  }, [modelsByProvider]);

  const lookupInfo = useCallback(
    (ref: ModelRef): ModelInfo => infoByRef.get(refKey(ref)) ?? { id: ref.modelId },
    [infoByRef],
  );

  // Anchor the popover relative to the chip on open. The browser
  // positions a popover in the top layer with `margin: auto` by default
  // (centers it on the viewport); we override that via inline top OR
  // bottom + left set from the trigger's bounding rect. Opens upward
  // when there's more headroom above the chip than below — the chip
  // lives in the composer at the bottom of the layout, so the upward
  // path is the common case.
  const reposition = useCallback(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;
    const trigger = document.querySelector<HTMLElement>(`[popovertarget="${popoverId}"]`);
    if (!trigger) {
      // The anchor can vanish between click and toggle (a live board frame can
      // remount it); center rather than paint at the top layer's static
      // fallback — the bottom of the document.
      popoverEl.style.top = `${Math.round(window.innerHeight / 3)}px`;
      popoverEl.style.bottom = "auto";
      // Transform-centre (not width math): on `beforetoggle` the panel is still
      // display:none, so offsetWidth is 0 and width math would mis-centre a frame.
      popoverEl.style.left = "50%";
      popoverEl.style.transform = "translateX(-50%)";
      return;
    }
    // Anchored placement sets an explicit left; clear any centring transform a
    // prior anchor-less frame left behind, or it would shift this by half.
    popoverEl.style.transform = "none";
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
  }, [popoverId]);

  useEffect(() => {
    const popoverEl = popoverRef.current;
    if (!popoverEl) return;

    const onToggle = (e: Event) => {
      const evt = e as ToggleEvent;
      if (evt.newState === "open") {
        reposition();
        // Reset query on each open so a stale filter from last time
        // doesn't hide everything.
        setQuery("");
        // Defer focus until after the toggle commits — the browser
        // moves focus to the popover on open, and our focus call has to
        // win that race for the search input to actually receive it.
        queueMicrotask(() => searchInputRef.current?.focus());
      }
    };

    const onBeforeToggle = (e: Event) => {
      // `toggle` dispatches async (coalesced) — reposition before the first
      // paint too, or the popover shows a beat at its unpositioned fallback.
      if ((e as ToggleEvent).newState === "open") reposition();
    };
    popoverEl.addEventListener("beforetoggle", onBeforeToggle);
    popoverEl.addEventListener("toggle", onToggle);
    return () => {
      popoverEl.removeEventListener("beforetoggle", onBeforeToggle);
      popoverEl.removeEventListener("toggle", onToggle);
    };
  }, [reposition]);

  // Keep the popover anchored when the window resizes mid-open — without
  // this the popover floats away from its trigger. Cheap to wire: only
  // listen while open, and reuse the same anchoring math.
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

  const filterMatches = useCallback(
    (providerId: string, modelId: string): boolean => {
      if (!query) return true;
      const q = query.toLowerCase();
      if (modelId.toLowerCase().includes(q)) return true;
      const label = providerLabels.get(providerId)?.toLowerCase() ?? "";
      if (label.includes(q)) return true;
      // Also match displayName ("Claude Opus 4.7") so users can type "opus".
      const info = infoByRef.get(refKey({ providerId, modelId }));
      const display = info?.displayName?.toLowerCase() ?? "";
      return display.includes(q);
    },
    [infoByRef, providerLabels, query],
  );

  // Flatten the visible rows in render order so Enter-on-search can
  // pick the first match without re-walking the section tree.
  const flatVisible: ModelRef[] = useMemo(() => {
    const out: ModelRef[] = [];
    const seen = new Set<string>();
    // Favorites first
    for (const fav of favorites) {
      if (!filterMatches(fav.providerId, fav.modelId)) continue;
      out.push(fav);
      seen.add(refKey(fav));
    }
    for (const provider of providers) {
      const models = modelsByProvider[provider.id] ?? [];
      for (const info of models) {
        const ref = makeRef(provider.id, info.id);
        if (seen.has(refKey(ref))) continue;
        if (!filterMatches(provider.id, info.id)) continue;
        out.push(ref);
      }
    }
    return out;
  }, [favorites, filterMatches, modelsByProvider, providers]);

  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const first = flatVisible.find((ref) => {
          if (lockedProviderId === null) return true;
          return ref.providerId === lockedProviderId;
        });
        if (first) {
          onSelect(first);
          popoverRef.current?.hidePopover();
        }
      }
    },
    [flatVisible, lockedProviderId, onSelect],
  );

  const handleRowSelect = useCallback(
    (ref: ModelRef) => {
      onSelect(ref);
      // popoverTargetAction="hide" on the button takes care of closing
      // for the click path; this branch covers the keyboard / Enter
      // path where the button click hasn't fired.
      popoverRef.current?.hidePopover();
    },
    [onSelect],
  );

  return (
    <div
      ref={popoverRef}
      id={popoverId}
      // Popover API: light-dismiss on outside click + Esc handled by
      // the browser. Inline top/left set in the toggle handler.
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
        {favorites.length > 0 && (
          <Section title="Favorites">
            {favorites
              .filter((f) => filterMatches(f.providerId, f.modelId))
              .map((ref) => (
                <Row
                  key={`fav-${refKey(ref)}`}
                  popoverId={popoverId}
                  ref_={ref}
                  info={lookupInfo(ref)}
                  providerLabel={providerLabels.get(ref.providerId) ?? ref.providerId}
                  isActive={
                    activeRef !== null &&
                    activeRef.providerId === ref.providerId &&
                    activeRef.modelId === ref.modelId
                  }
                  isFavorite={true}
                  disabled={lockedProviderId !== null && lockedProviderId !== ref.providerId}
                  showProviderPrefix={true}
                  onSelect={() => handleRowSelect(ref)}
                  onToggleFavorite={() => onToggleFavorite(ref)}
                />
              ))}
          </Section>
        )}

        {providers.map((provider) => {
          const models = modelsByProvider[provider.id] ?? [];
          const visible = models.filter((info) => filterMatches(provider.id, info.id));
          if (visible.length === 0) return null;
          const renderRow = (info: ModelInfo) => {
            const ref = makeRef(provider.id, info.id);
            return (
              <Row
                key={refKey(ref)}
                popoverId={popoverId}
                ref_={ref}
                info={info}
                providerLabel={provider.displayName}
                isActive={
                  activeRef !== null &&
                  activeRef.providerId === provider.id &&
                  activeRef.modelId === info.id
                }
                isFavorite={favoritesKey.has(refKey(ref))}
                disabled={lockedProviderId !== null && lockedProviderId !== provider.id}
                showProviderPrefix={false}
                onSelect={() => handleRowSelect(ref)}
                onToggleFavorite={() => onToggleFavorite(ref)}
              />
            );
          };
          return (
            <Section key={provider.id} title={provider.displayName} count={visible.length}>
              {groupByVendor(visible).map((group) => (
                // First model id is globally unique, so it keys each consecutive
                // run distinctly even when a vendor appears in more than one run.
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
            </Section>
          );
        })}

        {flatVisible.length === 0 && (
          <div className="model-picker-popover-empty">No models match.</div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="model-picker-popover-section">
      <div className="model-picker-popover-section-title">
        <span>{title}</span>
        {count != null && <span className="model-picker-popover-section-count">{count}</span>}
      </div>
      <div className="model-picker-popover-section-rows">{children}</div>
    </div>
  );
}

interface RowProps {
  popoverId: string;
  ref_: ModelRef;
  // Bare `{ id }` entries render id-only when metadata is missing.
  info: ModelInfo;
  providerLabel: string;
  isActive: boolean;
  isFavorite: boolean;
  disabled: boolean;
  // True in the Favorites section, where the row also carries a small
  // provider prefix since favorites span providers.
  showProviderPrefix: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}

function Row({
  popoverId,
  ref_,
  info,
  providerLabel,
  isActive,
  isFavorite,
  disabled,
  showProviderPrefix,
  onSelect,
  onToggleFavorite,
}: RowProps) {
  // Show the displayName as the primary (and only visible) label. The raw
  // id is folded into the title tooltip — search still matches it
  // (filterMatches walks ids too), so power users get full discovery
  // without the row carrying a duplicated chunk of low-contrast text.
  const label = info.displayName ?? ref_.modelId;
  const showRawId = Boolean(info.displayName) && info.displayName !== ref_.modelId;
  // Disabled-row title takes precedence — it explains why the row can't
  // be selected. Otherwise concatenate the raw id (when distinct from
  // the label) and the description with an em-dash.
  let buttonTitle: string | undefined;
  if (disabled) {
    buttonTitle = "Start a new conversation to switch providers";
  } else {
    const parts: string[] = [];
    if (showRawId) parts.push(ref_.modelId);
    if (info.description) parts.push(info.description);
    buttonTitle = parts.length > 0 ? parts.join(" — ") : undefined;
  }

  return (
    <div
      className={`model-picker-popover-row${isActive ? " active" : ""}${disabled ? " disabled" : ""}`}
    >
      <button
        type="button"
        className="model-picker-popover-fav"
        onClick={(e) => {
          // Don't bubble — clicking ★ shouldn't also fire the select
          // button next to it (they're siblings, not nested, but the
          // popover wrapper could otherwise close on the star click
          // if we ever wrap the row in a click-through layer).
          e.stopPropagation();
          onToggleFavorite();
        }}
        aria-label={isFavorite ? "Unfavorite" : "Favorite"}
        aria-pressed={isFavorite}
        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
      >
        <span aria-hidden="true">{isFavorite ? "★" : "☆"}</span>
      </button>
      <button
        type="button"
        className="model-picker-popover-pick"
        onClick={onSelect}
        disabled={disabled}
        // Native close-on-click — the browser hides the popover after
        // our onClick handler runs. Skipped on disabled rows so a click
        // on a locked provider's entry doesn't close the popover with
        // no state change (frustrating UX).
        popoverTarget={disabled ? undefined : popoverId}
        popoverTargetAction={disabled ? undefined : "hide"}
        title={buttonTitle}
      >
        {showProviderPrefix && (
          <span className="model-picker-popover-pick-prefix">{providerLabel}</span>
        )}
        <span className="model-picker-popover-pick-id">{label}</span>
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
}
