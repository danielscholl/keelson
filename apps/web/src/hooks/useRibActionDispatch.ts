import type { RibAction, RibActionResult } from "@keelson/shared";
import { useCallback } from "react";
import { postRibAction } from "../api.ts";
import { useToast } from "../components/Toast.tsx";

// Dispatches a board action to its owning rib over POST /api/ribs/:id/action,
// unifying the toast + error shaping shared by the surface region and the canvas
// drawer. `onSuccess` lets a caller react to an ok result (e.g. re-hydrate the
// region's snapshot). A null ribId yields a dispatcher that resolves to an error
// without a request — callers gate the action UI on a non-null id.
export function useRibActionDispatch(
  ribId: string | null,
  opts?: {
    onSuccess?: (action: RibAction, result: Extract<RibActionResult, { ok: true }>) => void;
  },
): (action: RibAction) => Promise<RibActionResult> {
  const toast = useToast();
  const onSuccess = opts?.onSuccess;
  return useCallback(
    async (action: RibAction): Promise<RibActionResult> => {
      if (!ribId) return { ok: false, error: "key is not rib-namespaced" };
      try {
        const result = await postRibAction(ribId, action);
        if (result.ok) {
          toast.push({ kind: "ok", message: `${action.type} ✓` });
          onSuccess?.(action, result);
        } else {
          toast.push({ kind: "error", message: `${action.type}: ${result.error}` });
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.push({ kind: "error", message: `${action.type} failed: ${message}` });
        return { ok: false, error: message };
      }
    },
    [ribId, toast, onSuccess],
  );
}
