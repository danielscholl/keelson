// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibSummary } from "@keelson/shared";
import { useCallback, useEffect, useState } from "react";
import { getRibs } from "../api.ts";

export interface UseRibsState {
  status: "loading" | "ready" | "error";
  ribs: RibSummary[];
  error: string | null;
  refresh: () => void;
}

// Loads the active-rib list from GET /api/ribs. Rib membership only changes on
// a server restart, so there's no interval poll — a manual refresh covers the
// one mutable bit (auth status), and we opportunistically refetch when the tab
// regains focus.
export function useRibs(): UseRibsState {
  const [status, setStatus] = useState<UseRibsState["status"]>("loading");
  const [ribs, setRibs] = useState<RibSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A single loader drives both the mount fetch and manual/visibility refreshes;
  // its returned canceller doubles as the mount effect's cleanup. Keeping the
  // fetch in a stable callback (rather than a tick counter) avoids a spurious
  // exhaustive-deps trigger dependency.
  const load = useCallback(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);
    getRibs()
      .then((list) => {
        if (cancelled) return;
        setRibs(list);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [load]);

  return { status, ribs, error, refresh: load };
}
