// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { useEffect, useState } from "react";
import { listPausedRuns } from "../api.ts";

// 10s polling cadence. The per-run WS already broadcasts `approval_awaiting`
// to whichever client is watching that run; this poll is the cross-tab badge
// signal only. A global WS topic would replace this entirely.
const POLL_MS = 10_000;

export function usePausedRunCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      // Skip polling while the tab is hidden — a background tab otherwise hits
      // the server every 10s forever for a signal nobody is looking at.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const runs = await listPausedRuns();
        if (!cancelled) setCount(runs.length);
      } catch (err) {
        if (!cancelled) {
          console.warn("[paused-run-count] fetch failed:", err);
          setCount(0);
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    // Refresh immediately when the tab becomes visible so a returning user
    // doesn't wait up to 10s for the badge to update.
    const onVisibility = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return count;
}
