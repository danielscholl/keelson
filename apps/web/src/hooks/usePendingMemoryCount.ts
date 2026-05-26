// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { useEffect, useState } from "react";
import { listPendingMemories } from "../api.ts";

const POLL_MS = 10_000;

// Drives the magenta pip on the Memory nav tab. Mirrors usePausedRunCount's
// posture: hidden-tab guard + visibility-listener kick to avoid wasted
// polling and stale badges. A future global WS topic would replace this
// poll entirely (one frame per writeback / review action).
export function usePendingMemoryCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        // Limit at the API max so the count is accurate up to 200 pending.
        // Beyond that the badge shows "200+" via the Math.min cap at render
        // sites; the harness was never meant to accumulate that many anyway.
        const page = await listPendingMemories({ limit: 200 });
        if (!cancelled) setCount(page.items.length);
      } catch (err) {
        if (!cancelled) {
          console.warn("[pending-memory-count] fetch failed:", err);
          setCount(0);
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
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
