// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useSyncExternalStore } from "react";

export type ClockMode = "since" | "until";

const MINUTE = 60_000;
export const CLOCK_TICK_MS = 30_000;

function span(ms: number): string {
  if (ms < MINUTE) return "under 1 min";
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

export function formatClock(atMs: number, nowMs: number, mode: ClockMode): string {
  if (mode === "since") {
    const elapsed = nowMs - atMs;
    return elapsed < MINUTE ? "just now" : `${span(elapsed)} ago`;
  }
  const remaining = atMs - nowMs;
  if (remaining >= MINUTE) return `${span(remaining)} left`;
  if (remaining > -MINUTE) return "due now";
  return `${span(-remaining)} over`;
}

// One interval shared by every mounted clock, running only while one is mounted.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    // A clock replacing the last one subscribes in the same commit, after
    // getNow's idle refresh has already been skipped, so refresh here.
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, CLOCK_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

// Snapshot must be stable across back-to-back reads, so an idle store refreshes
// only once its value is a full tick stale.
function getNow(): number {
  if (timer === undefined && Math.abs(Date.now() - now) >= CLOCK_TICK_MS) now = Date.now();
  return now;
}

export function useClockNow(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}
