// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useEffect, useRef, useState } from "react";
import type { SnapshotStatus } from "./useSnapshot.ts";

const TICK_MS = 30_000;

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
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const now = Date.now();
      setNowMs(now);
      if (!workflow || !cadenceMs || status === "loading" || liveRef.current.running) return;
      const composedMs = composedAt ? Date.parse(composedAt) : Number.NaN;
      const frameStale = Number.isNaN(composedMs) || now - composedMs >= cadenceMs;
      const backoffOk = now - lastFiredRef.current >= cadenceMs;
      if (frameStale && backoffOk) {
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

  if (running) return { label: "refreshing…", tone: null };
  if (error) return { label: "refresh failed", tone: "error" };
  if (!composedAt) return { label: null, tone: null };
  const composedMs = Date.parse(composedAt);
  if (Number.isNaN(composedMs)) return { label: null, tone: null };
  const ageMs = Math.max(0, nowMs - composedMs);
  const stale = cadenceMs != null && ageMs >= cadenceMs;
  return { label: formatAge(ageMs), tone: stale ? "warn" : null };
}
