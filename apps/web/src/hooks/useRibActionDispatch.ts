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
    onOpenChat?: (seed: OpenChatSeed) => void | Promise<void>;
    // A successful action may instead carry a `run-workflow` directive; the host
    // wires this to its workflow-launch path (the same path /workflow run uses).
    onLaunchWorkflow?: (workflow: string, args: Record<string, string>) => void | Promise<void>;
    // A successful action may instead carry an `open-canvas` directive; the host
    // opens that snapshot's board in the canvas drawer (the View verb). Sync: it's
    // a setState that opens a drawer, not a paid/duplicable action — no await.
    onOpenCanvas?: (key: string, title?: string) => void;
  },
): BoardActionApi {
  const toast = useToast();
  const onSuccess = opts?.onSuccess;
  const onOpenChat = opts?.onOpenChat;
  const onLaunchWorkflow = opts?.onLaunchWorkflow;
  const onOpenCanvas = opts?.onOpenCanvas;

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
              // Isolate the callback like onSuccess below: a throwing onOpenChat
              // must not turn a successful action into a failure result. Await it
              // so an async rejection is caught here (not an unhandled rejection)
              // and so the caller's `run` stays pending for the whole handler,
              // keeping its button disabled across the navigate-away round-trip.
              try {
                await Promise.resolve(onOpenChat(parsed.data.seed));
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                toast.push({ kind: "error", message: `open-chat handler failed: ${message}` });
              }
              return result;
            }
            // Shaped like open-chat but invalid (e.g. an oversized prompt): report
            // failure so the caller doesn't treat a dropped directive as success.
            const error = `${action.type}: invalid open-chat directive`;
            toast.push({ kind: "error", message: error });
            return { ok: false, error };
          }
          // A run-workflow directive launches a run and focuses the Workflows
          // surface — navigation-away, so no success toast and no region reload,
          // mirroring open-chat above.
          if (onLaunchWorkflow && isRunWorkflowShaped(result.data)) {
            const parsed = ribClientEffectSchema.safeParse(result.data);
            if (parsed.success && parsed.data.effect === "run-workflow") {
              // Isolate the callback like onOpenChat: a throwing handler must not
              // turn a successful action into a failure result. Await it so an
              // async rejection is caught here (not an unhandled rejection) and so
              // the caller's `run` stays pending across the launch — which keeps
              // the action button disabled for the whole round-trip and closes the
              // double-launch window without a separate concurrency guard.
              try {
                await Promise.resolve(
                  onLaunchWorkflow(parsed.data.workflow, parsed.data.args ?? {}),
                );
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                toast.push({ kind: "error", message: `run-workflow handler failed: ${message}` });
              }
              return result;
            }
            const error = `${action.type}: invalid run-workflow directive`;
            toast.push({ kind: "error", message: error });
            return { ok: false, error };
          }
          // An open-canvas directive opens the item's snapshot board in the
          // drawer (navigation-into-drawer) — no success toast and no reload,
          // like the two above. onOpenCanvas is a synchronous setState, so unlike
          // open-chat/run-workflow there's nothing to await or isolate.
          if (onOpenCanvas && isOpenCanvasShaped(result.data)) {
            const parsed = ribClientEffectSchema.safeParse(result.data);
            if (parsed.success && parsed.data.effect === "open-canvas") {
              onOpenCanvas(parsed.data.key, parsed.data.title);
              return result;
            }
            const error = `${action.type}: invalid open-canvas directive`;
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
    [ribId, toast, onSuccess, onOpenChat, onLaunchWorkflow, onOpenCanvas],
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

function isRunWorkflowShaped(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { effect?: unknown }).effect === "run-workflow"
  );
}

function isOpenCanvasShaped(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { effect?: unknown }).effect === "open-canvas"
  );
}
