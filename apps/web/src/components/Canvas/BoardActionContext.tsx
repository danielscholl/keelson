import type { RibAction, RibActionResult } from "@keelson/shared";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

export interface BoardActionApi {
  dispatch: (action: RibAction) => Promise<RibActionResult>;
}

const BoardActionContext = createContext<BoardActionApi | null>(null);

// Supplies the dispatcher a board's `actions` section calls. A surface region or
// the canvas drawer provides it once it knows the owning rib id (from the
// snapshot key). Absent for inline/artifact boards — there `useBoardActions`
// returns null and the buttons render disabled.
export function BoardActionProvider({
  dispatch,
  children,
}: {
  dispatch: BoardActionApi["dispatch"];
  children: ReactNode;
}) {
  const value = useMemo(() => ({ dispatch }), [dispatch]);
  return <BoardActionContext.Provider value={value}>{children}</BoardActionContext.Provider>;
}

export function useBoardActions(): BoardActionApi | null {
  return useContext(BoardActionContext);
}
