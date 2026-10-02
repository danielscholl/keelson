import type { CanvasCardAction, RibAction, RibActionResult } from "@keelson/shared";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useRef, useState } from "react";

// `run` drives the visible action buttons — dispatch + toast + (on a surface) a
// post-success reload. `reveal` is the raw round-trip a copy-on-reveal field
// uses: no toast, no reload, it just returns the result so the caller can write
// the returned `data` to the clipboard.
export interface BoardActionApi {
  run: (action: RibAction) => Promise<RibActionResult>;
  reveal: (action: RibAction) => Promise<RibActionResult>;
}

const BoardActionContext = createContext<BoardActionApi | null>(null);

// Supplies the dispatchers a board's `actions` section and copy-on-reveal fields
// call. A surface region or the canvas drawer provides it once it knows the
// owning rib id (from the snapshot key). Absent for inline/artifact boards —
// there `useBoardActions` returns null and the controls render disabled.
export function BoardActionProvider({
  run,
  reveal,
  children,
}: {
  run: BoardActionApi["run"];
  reveal: BoardActionApi["reveal"];
  children: ReactNode;
}) {
  const value = useMemo(() => ({ run, reveal }), [run, reveal]);
  return <BoardActionContext.Provider value={value}>{children}</BoardActionContext.Provider>;
}

export function useBoardActions(): BoardActionApi | null {
  return useContext(BoardActionContext);
}

export function useCardActionDispatch(action: CanvasCardAction | undefined) {
  const ctx = useBoardActions();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const dispatch = () => {
    if (!ctx || !action || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    void ctx
      .run(
        action.payload !== undefined
          ? { type: action.type, payload: action.payload }
          : { type: action.type },
      )
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  };
  return { disabled: !ctx || !action || pending, dispatch };
}
