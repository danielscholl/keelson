import {
  type OpenChatSeed,
  type RibAction,
  type RibActionResult,
  ribClientEffectSchema,
} from "@keelson/shared";
import { useCallback, useMemo } from "react";
import { postRibAction } from "../api.ts";
import type { BoardActionApi } from "../components/Canvas/BoardActionContext.tsx";
import { useToast } from "../components/Toast.tsx";

// Builds the two board-action dispatchers a region / the canvas drawer hands to
// BoardActionProvider, over POST /api/ribs/:id/action:
//   - `run`    — visible buttons: dispatch + toast + optional `onSuccess`
//                (e.g. re-hydrate the region's snapshot).
//   - `reveal` — copy-on-reveal fields: a raw round-trip with no toast and no
//                reload; the caller writes the returned `data` to the clipboard.
// A null ribId yields dispatchers that resolve to an error without a request —
// callers gate the action UI on a non-null id.
export function useRibActionDispatch(
  ribId: string | null,
  opts?: {
    onSuccess?: (action: RibAction, result: Extract<RibActionResult, { ok: true }>) => void;
    // A successful action may carry an `open-chat` directive in `data`; the host
    // wires this to its "open a seeded conversation" path (the ✦ flow).
    onOpenChat?: (seed: OpenChatSeed) => void;
  },
): BoardActionApi {
  const toast = useToast();
  const onSuccess = opts?.onSuccess;
  const onOpenChat = opts?.onOpenChat;

  const run = useCallback(
    async (action: RibAction): Promise<RibActionResult> => {
      if (!ribId) return { ok: false, error: "key is not rib-namespaced" };
      try {
        const result = await postRibAction(ribId, action);
        if (result.ok) {
          // An open-chat directive navigates away to a fresh seeded chat — no
          // success toast, no region reload. A directive that's shaped like
          // open-chat but fails validation (e.g. an oversized prompt) surfaces an
          // error rather than a misleading ✓.
          if (onOpenChat && isOpenChatShaped(result.data)) {
            const parsed = ribClientEffectSchema.safeParse(result.data);
            if (parsed.success && parsed.data.effect === "open-chat") {
              onOpenChat(parsed.data.seed);
              return result;
            }
            // Shaped like open-chat but invalid (e.g. an oversized prompt): report
            // failure so the caller doesn't treat a dropped directive as success.
            const error = `${action.type}: invalid open-chat directive`;
            toast.push({ kind: "error", message: error });
            return { ok: false, error };
          }
          toast.push({ kind: "ok", message: `${action.type} ✓` });
          // Isolate the callback: a throwing onSuccess must not turn a
          // successful action into a failure result.
          try {
            onSuccess?.(action, result);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            toast.push({ kind: "error", message: `post-success handler failed: ${message}` });
          }
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
    [ribId, toast, onSuccess, onOpenChat],
  );

  // Raw: no toast, no reload. The copy button shows its own flash and the
  // returned secret goes straight to the clipboard — it never reaches state here.
  const reveal = useCallback(
    async (action: RibAction): Promise<RibActionResult> => {
      if (!ribId) return { ok: false, error: "key is not rib-namespaced" };
      try {
        return await postRibAction(ribId, action);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [ribId],
  );

  return useMemo(() => ({ run, reveal }), [run, reveal]);
}

// Cheap pre-check so non-directive `data` (undefined, a copy-on-reveal string)
// flows through the normal success path untouched; only data that announces
// itself as an open-chat directive gets validated/handled.
function isOpenChatShaped(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { effect?: unknown }).effect === "open-chat"
  );
}
