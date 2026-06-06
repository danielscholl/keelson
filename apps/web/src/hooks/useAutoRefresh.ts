// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useEffect, useRef, useState } from "react";
import type { SnapshotStatus } from "./useSnapshot.ts";

const TICK_MS = 30_000;
// A region that has never loaded a frame retries this often instead of waiting a
// full (possibly multi-hour) cadence, so a failed cold start recovers quickly.
const COLD_RETRY_MS = 60_000;

export interface Freshness {
  label: string | null;
  tone: "warn" | "error" | null;
}

export interface AutoRefreshInput {
  workflow: string | undefined;
  cadenceMs: number | undefined;
  status: SnapshotStatus;
  composedAt: string | null;
  running: boolean;
  error: string | null;
  trigger: () => void;
}

function formatAge(ageMs: number): string {
  if (ageMs < 60_000) return "updated just now";
  const m = Math.floor(ageMs / 60_000);
  if (m < 60) return `updated ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `updated ${h}h ago`;
  return `updated ${Math.floor(h / 24)}d ago`;
}

// Drives a region's stale-while-revalidate auto-refresh and its freshness label.
// A region with both a `workflow` and a `cadenceMs` re-runs its producer when the
// hydrated frame is missing or older than the cadence — on mount (once hydrated),
// on a coarse heartbeat, and when the tab regains focus. `cadenceMs` also spaces
// successive *attempts* (via lastFired), so a failing collector retries at its
// cadence, not every heartbeat. The heartbeat doubles as the clock that keeps
// "updated Xm ago" current; both pause while the tab is hidden.
export function useAutoRefresh(input: AutoRefreshInput): Freshness {
  const { workflow, cadenceMs, status, composedAt, running, error, trigger } = input;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastFiredRef = useRef(0);
  // running/trigger are read through a ref so the heartbeat effect re-subscribes
  // only on real data changes — not on every in-flight toggle, and never on an
  // unstable trigger identity.
  const liveRef = useRef({ running, trigger });
  liveRef.current = { running, trigger };

  useEffect(() => {
    // Only a region declaring both a workflow and a cadence auto-refreshes;
    // others mount no interval and never re-render on the heartbeat.
    if (!workflow || !cadenceMs) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const now = Date.now();
      setNowMs(now);
      if (status === "loading" || liveRef.current.running) return;
      const composedMs = composedAt ? Date.parse(composedAt) : Number.NaN;
      const noFrame = Number.isNaN(composedMs);
      const frameStale = noFrame || now - composedMs >= cadenceMs;
      const retryFloor = noFrame ? Math.min(cadenceMs, COLD_RETRY_MS) : cadenceMs;
      if (frameStale && now - lastFiredRef.current >= retryFloor) {
        lastFiredRef.current = now;
        liveRef.current.trigger();
      }
    };
    tick();
    const id = window.setInterval(tick, TICK_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workflow, cadenceMs, status, composedAt]);

  // Only a cadence-bearing region carries a freshness contract.
  if (!workflow || !cadenceMs) return { label: null, tone: null };
  if (running) return { label: "refreshing…", tone: null };
  const composedMs = composedAt ? Date.parse(composedAt) : Number.NaN;
  const hasFrame = !Number.isNaN(composedMs);
  const ageMs = hasFrame ? Math.max(0, nowMs - composedMs) : Number.POSITIVE_INFINITY;
  const stale = ageMs >= cadenceMs;
  // A past error only matters while the data is actually stale or missing; a
  // fresh frame (repopulated by any path) means current data, so show its age.
  if (error && stale) return { label: "refresh failed", tone: "error" };
  if (!hasFrame) return { label: null, tone: null };
  return { label: formatAge(ageMs), tone: stale ? "warn" : null };
}
