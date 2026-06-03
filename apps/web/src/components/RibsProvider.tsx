// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { createContext, type ReactNode, useContext } from "react";
import { type UseRibsState, useRibs } from "../hooks/useRibs.ts";

// Single rib-list instance shared by the TopBar surface tabs and the Ribs page,
// so the panel's Refresh (or a visibility refetch) updates both at once — and
// /api/ribs is fetched once, not per consumer.
const RibsContext = createContext<UseRibsState | null>(null);

export function RibsProvider({ children }: { children: ReactNode }) {
  return <RibsContext.Provider value={useRibs()}>{children}</RibsContext.Provider>;
}

export function useRibsContext(): UseRibsState {
  const ctx = useContext(RibsContext);
  if (!ctx) throw new Error("useRibsContext must be used within <RibsProvider>");
  return ctx;
}
