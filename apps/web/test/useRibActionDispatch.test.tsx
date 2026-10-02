import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CanvasHtmlAction, OpenChatSeed, RibAction, RibActionResult } from "@keelson/shared";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import * as realApi from "../src/api.ts";
import { ToastHost } from "../src/components/Toast.tsx";

// Mock ONLY postRibAction, spreading the real module so every other export keeps
// its real binding. Mirrors Canvas.test.tsx exactly (reassignable `let` impl +
// `...realApi` spread + the hook imported via top-level await AFTER the mock) so
// the process-global mock.module doesn't leak a broken api.ts into the full
// runner.
let postRibActionImpl: (ribId: string, action: unknown) => Promise<unknown> = async () => ({
  ok: true,
});

mock.module("../src/api.ts", () => ({
  ...realApi,
  postRibAction: (ribId: string, action: unknown) => postRibActionImpl(ribId, action),
}));

const { useHtmlFrameAction, useRibActionDispatch } = await import(
  "../src/hooks/useRibActionDispatch.ts"
);

function wrapper({ children }: { children: ReactNode }) {
  return <ToastHost>{children}</ToastHost>;
}

const ACTION: RibAction = { type: "convene" };
const FRAME_ACTION: CanvasHtmlAction = { type: "inspect", payload: { id: "bead-1" } };

// Records every effect-callback invocation so a test can assert the dispatcher
// routed to the right handler with the right payload.
function recorders() {
  const chats: OpenChatSeed[] = [];
  const launches: Array<{ workflow: string; args: Record<string, string> }> = [];
  const canvases: Array<{ key: string; title?: string }> = [];
  const surfaces: Array<{ surfaceId: string; regionKey?: string }> = [];
  return {
    chats,
    launches,
    canvases,
    surfaces,
    onOpenChat: (seed: OpenChatSeed) => chats.push(seed),
    onLaunchWorkflow: (workflow: string, args: Record<string, string>) =>
      launches.push({ workflow, args }),
    onOpenCanvas: (key: string, title?: string) => canvases.push({ key, title }),
    onOpenSurface: (surfaceId: string, regionKey?: string) =>
      surfaces.push({ surfaceId, regionKey }),
  };
}

function toastText(): string {
  return screen.queryByRole("status")?.textContent ?? "";
}

// Toast identity, not glyph text: the success affordance is a `.keelson-toast-ok`
// node, so a navigate-away path that fired no success toast has zero of them
// regardless of what an unrelated toast's text happens to contain.
function okToastCount(): number {
  return document.querySelectorAll(".keelson-toast-ok").length;
}

function toastCount(): number {
  return document.querySelectorAll(".keelson-toast").length;
}

// run() pushes a toast (a React state update); wrap in act so the toast DOM is
// flushed before a test reads toastText().
async function runAct(
  run: (action: RibAction) => Promise<RibActionResult>,
  action: RibAction,
): Promise<RibActionResult> {
  let res!: RibActionResult;
  await act(async () => {
    res = await run(action);
  });
  return res;
}

async function frameAct(dispatch: (action: CanvasHtmlAction) => void): Promise<void> {
  await act(async () => {
    dispatch(FRAME_ACTION);
    await Promise.resolve();
  });
}

const SEED: OpenChatSeed = { systemPrompt: "Be helpful.", name: "Helper" };

// A promise the test resolves by hand, to observe whether the dispatcher awaits
// the handler before `run()` settles.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  postRibActionImpl = async () => ({ ok: true });
});

describe("useRibActionDispatch — run-workflow directive", () => {
  test("launches the named workflow with its args, no success toast", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "run-workflow", workflow: "chamber-genesis", args: { topic: "nav" } },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onLaunchWorkflow: rec.onLaunchWorkflow }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({
      ok: true,
      data: { effect: "run-workflow", workflow: "chamber-genesis", args: { topic: "nav" } },
    });
    expect(rec.launches).toEqual([{ workflow: "chamber-genesis", args: { topic: "nav" } }]);
    // Navigate-away path: no success toast at all (assert identity, not glyph).
    expect(okToastCount()).toBe(0);
    expect(toastCount()).toBe(0);
  });

  test("passes an empty args record when args is omitted", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "run-workflow", workflow: "chamber-genesis" },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onLaunchWorkflow: rec.onLaunchWorkflow }),
      { wrapper },
    );
    await runAct(result.current.run, ACTION);
    expect(rec.launches).toEqual([{ workflow: "chamber-genesis", args: {} }]);
  });

  test("a shaped-but-invalid run-workflow returns an error result and toasts", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "run-workflow", workflow: "" },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onLaunchWorkflow: rec.onLaunchWorkflow }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({ ok: false, error: "convene: invalid run-workflow directive" });
    expect(rec.launches).toEqual([]);
    expect(toastText()).toContain("invalid run-workflow directive");
  });

  test("a throwing onLaunchWorkflow toasts but keeps the result ok", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "run-workflow", workflow: "chamber-genesis" },
    });
    const { result } = renderHook(
      () =>
        useRibActionDispatch("rib:demo", {
          onLaunchWorkflow: () => {
            throw new Error("nav failed");
          },
        }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({
      ok: true,
      data: { effect: "run-workflow", workflow: "chamber-genesis" },
    });
    expect(toastText()).toContain("run-workflow handler failed: nav failed");
    // The toast is the failure toast, not a success toast hiding behind it.
    expect(toastText()).not.toContain("✓");
    expect(okToastCount()).toBe(0);
  });

  test("an async-rejecting onLaunchWorkflow toasts but keeps the result ok", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "run-workflow", workflow: "chamber-genesis" },
    });
    const { result } = renderHook(
      () =>
        useRibActionDispatch("rib:demo", {
          // The real App handler is async; a rejected promise must be caught here,
          // not escape as an unhandled rejection.
          onLaunchWorkflow: async () => {
            throw new Error("nav rejected");
          },
        }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({
      ok: true,
      data: { effect: "run-workflow", workflow: "chamber-genesis" },
    });
    expect(toastText()).toContain("run-workflow handler failed: nav rejected");
    expect(okToastCount()).toBe(0);
  });

  test("run() stays pending until an async onLaunchWorkflow resolves", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "run-workflow", workflow: "chamber-genesis" },
    });
    const gate = deferred();
    const order: string[] = [];
    const { result } = renderHook(
      () =>
        useRibActionDispatch("rib:demo", {
          onLaunchWorkflow: async () => {
            order.push("handler-start");
            await gate.promise;
            order.push("handler-end");
          },
        }),
      { wrapper },
    );
    let settled!: RibActionResult;
    await act(async () => {
      // Kick off run() but do NOT await it yet — it must hang on the launch.
      const running = result.current.run(ACTION).then((r) => {
        order.push("run-resolved");
        settled = r;
      });
      // Let the dispatch reach (and await) the handler.
      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual(["handler-start"]);
      // Now release the launch; run() may resolve.
      gate.resolve();
      await running;
    });
    // run-resolved comes AFTER handler-end: the dispatcher awaited the launch, so
    // BoardView's `pending` spans the whole round-trip (the double-launch guard).
    expect(order).toEqual(["handler-start", "handler-end", "run-resolved"]);
    expect(settled.ok).toBe(true);
  });

  test("a strict-reject (extra key) run-workflow directive returns an error, no launch", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "run-workflow", workflow: "g", extra: 1 },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onLaunchWorkflow: rec.onLaunchWorkflow }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({ ok: false, error: "convene: invalid run-workflow directive" });
    expect(rec.launches).toEqual([]);
    expect(toastText()).toContain("invalid run-workflow directive");
  });

  test("falls through to the normal success path when onLaunchWorkflow is absent", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "run-workflow", workflow: "chamber-genesis" },
    });
    const onSuccessCalls: RibAction[] = [];
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onSuccess: (a) => onSuccessCalls.push(a) }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res.ok).toBe(true);
    // Not intercepted: the success toast fires and onSuccess runs.
    expect(toastText()).toContain("convene ✓");
    expect(onSuccessCalls).toEqual([ACTION]);
  });
});

describe("useRibActionDispatch — rib success message", () => {
  test("a success carrying data.message toasts that text instead of <type> ✓", async () => {
    postRibActionImpl = async () => ({ ok: true, data: { message: "  Posted in #swarm-s9x3g " } });
    const { result } = renderHook(() => useRibActionDispatch("rib:demo"), { wrapper });
    await runAct(result.current.run, ACTION);
    expect(toastText()).toContain("Posted in #swarm-s9x3g");
    expect(toastText()).not.toContain("convene ✓");
  });

  test("a blank or non-string message falls back to <type> ✓", async () => {
    for (const data of [{ message: "   " }, { message: 42 }, "copied"]) {
      postRibActionImpl = async () => ({ ok: true, data });
      const { result, unmount } = renderHook(() => useRibActionDispatch("rib:demo"), { wrapper });
      await runAct(result.current.run, ACTION);
      expect(toastText()).toContain("convene ✓");
      unmount();
    }
  });
});

describe("useRibActionDispatch — open-chat regressions", () => {
  test("a valid open-chat directive still opens a chat with no success toast", async () => {
    postRibActionImpl = async () => ({ ok: true, data: { effect: "open-chat", seed: SEED } });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onOpenChat: rec.onOpenChat }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({ ok: true, data: { effect: "open-chat", seed: SEED } });
    expect(rec.chats).toEqual([SEED]);
    // Navigate-away path: no success toast at all (assert identity, not glyph).
    expect(okToastCount()).toBe(0);
    expect(toastCount()).toBe(0);
  });

  test("an async-rejecting onOpenChat toasts but keeps the result ok", async () => {
    postRibActionImpl = async () => ({ ok: true, data: { effect: "open-chat", seed: SEED } });
    const { result } = renderHook(
      () =>
        useRibActionDispatch("rib:demo", {
          onOpenChat: async () => {
            throw new Error("seed rejected");
          },
        }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({ ok: true, data: { effect: "open-chat", seed: SEED } });
    expect(toastText()).toContain("open-chat handler failed: seed rejected");
    expect(okToastCount()).toBe(0);
  });

  test("a shaped-but-invalid open-chat directive still returns an error result", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-chat", seed: { systemPrompt: "", name: "Bad" } },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onOpenChat: rec.onOpenChat }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({ ok: false, error: "convene: invalid open-chat directive" });
    expect(rec.chats).toEqual([]);
  });
});

describe("useRibActionDispatch — open-canvas directive", () => {
  test("opens the snapshot canvas with key + title, no success toast", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-canvas", key: "rib:demo:session-7", title: "Session 7" },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onOpenCanvas: rec.onOpenCanvas }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({
      ok: true,
      data: { effect: "open-canvas", key: "rib:demo:session-7", title: "Session 7" },
    });
    expect(rec.canvases).toEqual([{ key: "rib:demo:session-7", title: "Session 7" }]);
    // Navigate-into-drawer: no success toast at all (assert identity, not glyph).
    expect(okToastCount()).toBe(0);
    expect(toastCount()).toBe(0);
  });

  test("passes an undefined title when title is omitted", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-canvas", key: "rib:demo:session-7" },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onOpenCanvas: rec.onOpenCanvas }),
      { wrapper },
    );
    await runAct(result.current.run, ACTION);
    expect(rec.canvases).toEqual([{ key: "rib:demo:session-7", title: undefined }]);
  });

  test("a shaped-but-invalid open-canvas (empty key) returns an error result and toasts", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-canvas", key: "" },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onOpenCanvas: rec.onOpenCanvas }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({ ok: false, error: "convene: invalid open-canvas directive" });
    expect(rec.canvases).toEqual([]);
    expect(toastText()).toContain("invalid open-canvas directive");
  });

  test("falls through to the normal success path when onOpenCanvas is absent", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-canvas", key: "rib:demo:session-7" },
    });
    const onSuccessCalls: RibAction[] = [];
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onSuccess: (a) => onSuccessCalls.push(a) }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res.ok).toBe(true);
    // Not intercepted: the success toast fires and onSuccess runs (not swallowed).
    expect(toastText()).toContain("convene ✓");
    expect(onSuccessCalls).toEqual([ACTION]);
  });
});

describe("useHtmlFrameAction — frame effects", () => {
  for (const data of [
    { effect: "open-canvas", key: "rib:demo:inspector", title: "Inspector" },
    { effect: "open-canvas", key: "rib:demo:inspector" },
  ]) {
    test(`opens a canvas with ${"title" in data ? "a title" : "no title"} without a toast`, async () => {
      const calls: Array<{ ribId: string; action: unknown }> = [];
      postRibActionImpl = async (ribId, action) => {
        calls.push({ ribId, action });
        return { ok: true, data };
      };
      const rec = recorders();
      const { result } = renderHook(
        () => useHtmlFrameAction("demo", { onOpenCanvas: rec.onOpenCanvas }),
        { wrapper },
      );
      await frameAct(result.current);
      await waitFor(() => expect(rec.canvases).toEqual([{ key: data.key, title: data.title }]));
      expect(calls).toEqual([
        {
          ribId: "demo",
          action: { type: "inspect", payload: { id: "bead-1" }, origin: "canvas-html" },
        },
      ]);
      expect(toastCount()).toBe(0);
    });
  }

  for (const data of [
    { effect: "open-chat", seed: SEED },
    { effect: "run-workflow", workflow: "ship" },
    { effect: "open-surface", surfaceId: "surface:demo:rooms" },
    { effect: "open-run", runId: "run-1", workflow: "ship" },
  ]) {
    test(`does not forward ${data.effect} or unrelated options`, async () => {
      postRibActionImpl = async () => ({ ok: true, data });
      const rec = recorders();
      const runs: string[] = [];
      const successes: RibAction[] = [];
      const widerOptions = {
        onOpenCanvas: rec.onOpenCanvas,
        onOpenChat: rec.onOpenChat,
        onLaunchWorkflow: rec.onLaunchWorkflow,
        onOpenSurface: rec.onOpenSurface,
        onOpenRun: (_workflow: string, runId: string) => runs.push(runId),
        onSuccess: (action: RibAction) => successes.push(action),
      };
      const { result } = renderHook(() => useHtmlFrameAction("demo", widerOptions), { wrapper });
      await frameAct(result.current);
      await waitFor(() => expect(toastText()).toContain("inspect ✓"));
      expect(rec.canvases).toEqual([]);
      expect(rec.chats).toEqual([]);
      expect(rec.launches).toEqual([]);
      expect(rec.surfaces).toEqual([]);
      expect(runs).toEqual([]);
      expect(successes).toEqual([]);
      expect(okToastCount()).toBe(1);
    });
  }

  test("without options an open-canvas response retains the success toast", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-canvas", key: "rib:demo:inspector" },
    });
    const { result } = renderHook(() => useHtmlFrameAction("demo"), { wrapper });
    await frameAct(result.current);
    await waitFor(() => expect(toastText()).toContain("inspect ✓"));
  });

  test("a null rib id never posts an action", async () => {
    const calls: unknown[] = [];
    postRibActionImpl = async (...args) => {
      calls.push(args);
      return { ok: true };
    };
    const rec = recorders();
    const { result } = renderHook(
      () => useHtmlFrameAction(null, { onOpenCanvas: rec.onOpenCanvas }),
      { wrapper },
    );
    await frameAct(result.current);
    expect(calls).toEqual([]);
    expect(rec.canvases).toEqual([]);
    expect(toastCount()).toBe(0);
  });

  test("a malformed canvas response reports an error instead of opening", async () => {
    postRibActionImpl = async () => ({ ok: true, data: { effect: "open-canvas", key: "" } });
    const rec = recorders();
    const { result } = renderHook(
      () => useHtmlFrameAction("demo", { onOpenCanvas: rec.onOpenCanvas }),
      { wrapper },
    );
    await frameAct(result.current);
    await waitFor(() => expect(toastText()).toContain("invalid open-canvas directive"));
    expect(rec.canvases).toEqual([]);
    expect(okToastCount()).toBe(0);
  });

  test("an unsuccessful response reports its error without opening", async () => {
    postRibActionImpl = async () => ({ ok: false, error: "not allowed" });
    const rec = recorders();
    const { result } = renderHook(
      () => useHtmlFrameAction("demo", { onOpenCanvas: rec.onOpenCanvas }),
      { wrapper },
    );
    await frameAct(result.current);
    await waitFor(() => expect(toastText()).toContain("inspect: not allowed"));
    expect(rec.canvases).toEqual([]);
    expect(okToastCount()).toBe(0);
  });
});

describe("useRibActionDispatch — open-surface directive", () => {
  test("opens the target surface with region key, no success toast", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: {
        effect: "open-surface",
        surfaceId: "surface:chamber:rooms",
        regionKey: "rib:chamber:room-7",
      },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onOpenSurface: rec.onOpenSurface }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({
      ok: true,
      data: {
        effect: "open-surface",
        surfaceId: "surface:chamber:rooms",
        regionKey: "rib:chamber:room-7",
      },
    });
    expect(rec.surfaces).toEqual([
      { surfaceId: "surface:chamber:rooms", regionKey: "rib:chamber:room-7" },
    ]);
    expect(okToastCount()).toBe(0);
    expect(toastCount()).toBe(0);
  });

  test("passes an undefined region key when omitted", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-surface", surfaceId: "surface:chamber:rooms" },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onOpenSurface: rec.onOpenSurface }),
      { wrapper },
    );
    await runAct(result.current.run, ACTION);
    expect(rec.surfaces).toEqual([{ surfaceId: "surface:chamber:rooms", regionKey: undefined }]);
  });

  test("a shaped-but-invalid open-surface returns an error result and toasts", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-surface", surfaceId: "" },
    });
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onOpenSurface: rec.onOpenSurface }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({ ok: false, error: "convene: invalid open-surface directive" });
    expect(rec.surfaces).toEqual([]);
    expect(toastText()).toContain("invalid open-surface directive");
  });

  test("falls through to the normal success path when onOpenSurface is absent", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-surface", surfaceId: "surface:chamber:rooms" },
    });
    const onSuccessCalls: RibAction[] = [];
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onSuccess: (a) => onSuccessCalls.push(a) }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res.ok).toBe(true);
    expect(toastText()).toContain("convene ✓");
    expect(onSuccessCalls).toEqual([ACTION]);
  });
});

describe("useRibActionDispatch — open-run directive", () => {
  test("opens the run with its workflow, no success toast", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-run", runId: "run-1", workflow: "ship" },
    });
    const runs: Array<{ workflow: string; runId: string }> = [];
    const { result } = renderHook(
      () =>
        useRibActionDispatch("rib:demo", {
          onOpenRun: (workflow, runId) => runs.push({ workflow, runId }),
        }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res.ok).toBe(true);
    expect(runs).toEqual([{ workflow: "ship", runId: "run-1" }]);
    expect(toastCount()).toBe(0);
  });

  test("a directive without its workflow returns an error result and toasts", async () => {
    postRibActionImpl = async () => ({ ok: true, data: { effect: "open-run", runId: "run-1" } });
    const runs: string[] = [];
    const { result } = renderHook(
      () => useRibActionDispatch("rib:demo", { onOpenRun: (_w, runId) => runs.push(runId) }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({ ok: false, error: "convene: invalid open-run directive" });
    expect(runs).toEqual([]);
    expect(toastText()).toContain("invalid open-run directive");
  });

  test("falls through to the normal success path when onOpenRun is absent", async () => {
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-run", runId: "run-1", workflow: "ship" },
    });
    const { result } = renderHook(() => useRibActionDispatch("rib:demo"), { wrapper });
    const res = await runAct(result.current.run, ACTION);
    expect(res.ok).toBe(true);
    expect(toastText()).toContain("convene ✓");
  });
});

describe("useRibActionDispatch — non-directive and guards", () => {
  test("plain (non-directive) success data reaches neither effect handler", async () => {
    postRibActionImpl = async () => ({ ok: true, data: undefined });
    const rec = recorders();
    const { result } = renderHook(
      () =>
        useRibActionDispatch("rib:demo", {
          onOpenChat: rec.onOpenChat,
          onLaunchWorkflow: rec.onLaunchWorkflow,
        }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res.ok).toBe(true);
    expect(rec.chats).toEqual([]);
    expect(rec.launches).toEqual([]);
    expect(toastText()).toContain("convene ✓");
  });

  test("a null ribId short-circuits with an error and issues no request", async () => {
    let called = false;
    postRibActionImpl = async () => {
      called = true;
      return { ok: true };
    };
    const rec = recorders();
    const { result } = renderHook(
      () => useRibActionDispatch(null, { onLaunchWorkflow: rec.onLaunchWorkflow }),
      { wrapper },
    );
    const res = await runAct(result.current.run, ACTION);
    expect(res).toEqual({ ok: false, error: "key is not rib-namespaced" });
    expect(called).toBe(false);
    expect(rec.launches).toEqual([]);
  });
});
