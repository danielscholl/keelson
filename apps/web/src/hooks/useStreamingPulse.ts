// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useEffect, useRef, useState } from "react";

// How long a region stays lit after its last frame before decaying to idle.
export const STREAM_QUIET_MS = 3_000;

// Host-derived "streaming now" for an opt-in live region: a `version` bump
// lights the pulse and arms a decay timer that quiets it `quietMs` after the
// last frame. The first observed frame is the baseline load, not a stream
// event, so a region that hydrates once and sits still never pulses.
export function useStreamingPulse(
  version: number | null,
  enabled: boolean,
  quietMs: number = STREAM_QUIET_MS,
): boolean {
  const [streaming, setStreaming] = useState(false);
  const lastVersion = useRef<number | null>(null);
  const seeded = useRef(false);
  // Read through a ref so a changed quietMs never re-runs the effect: a re-run
  // with an unchanged version clears the pending timer but early-returns, which
  // would strand the pulse lit. An in-flight decay keeps the window it armed with.
  const quietRef = useRef(quietMs);
  quietRef.current = quietMs;

  useEffect(() => {
    if (!enabled) {
      setStreaming(false);
      return;
    }
    if (version === null) return;
    if (!seeded.current) {
      seeded.current = true;
      lastVersion.current = version;
      return;
    }
    if (version === lastVersion.current) return;
    lastVersion.current = version;
    setStreaming(true);
    const id = window.setTimeout(() => setStreaming(false), quietRef.current);
    return () => window.clearTimeout(id);
  }, [version, enabled]);

  return enabled && streaming;
}
