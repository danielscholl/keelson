// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { RIBS_VERSION_SNAPSHOT_KEY } from "@keelson/shared";
import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";
import { type UseRibsState, useRibs } from "../hooks/useRibs.ts";
import { useSnapshot } from "../hooks/useSnapshot.ts";

// Single rib-list instance shared by the TopBar surface tabs and the Ribs page,
// so the panel's Refresh (or a visibility refetch) updates both at once — and
// /api/ribs is fetched once, not per consumer.
const RibsContext = createContext<UseRibsState | null>(null);

export function RibsProvider({ children }: { children: ReactNode }) {
  const ribs = useRibs();
  // The server bumps this beacon's frame on every runtime region add/remove;
  // re-fetch the manifest so a newly-authored panel (e.g. a lens) shows without
  // a manual refresh. The first observed version also refetches, which closes
  // the gap if a region registered between the mount fetch and this first frame.
  const beacon = useSnapshot(RIBS_VERSION_SNAPSHOT_KEY);
  const seenVersion = useRef<number | null>(null);
  const refresh = ribs.refresh;
  useEffect(() => {
    if (beacon.version === null || beacon.version === seenVersion.current) return;
    seenVersion.current = beacon.version;
    refresh();
  }, [beacon.version, refresh]);
  return <RibsContext.Provider value={ribs}>{children}</RibsContext.Provider>;
}

export function useRibsContext(): UseRibsState {
  const ctx = useContext(RibsContext);
  if (!ctx) throw new Error("useRibsContext must be used within <RibsProvider>");
  return ctx;
}
