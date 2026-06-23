import { afterEach, describe, expect, mock, test } from "bun:test";
import type { OpenChatSeed, RibAction, RibActionResult } from "@keelson/shared";
import { act, renderHook, screen } from "@testing-library/react";
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

const { useRibActionDispatch } = await import("../src/hooks/useRibActionDispatch.ts");

function wrapper({ children }: { children: ReactNode }) {
  return <ToastHost>{children}</ToastHost>;
}

const ACTION: RibAction = { type: "convene" };

// Records every effect-callback invocation so a test can assert the dispatcher
// routed to the right handler with the right payload.
function recorders() {
  const chats: OpenChatSeed[] = [];
  const launches: Array<{ workflow: string; args: Record<string, string> }> = [];
  return {
    chats,
    launches,
    onOpenChat: (seed: OpenChatSeed) => chats.push(seed),
    onLaunchWorkflow: (workflow: string, args: Record<string, string>) =>
      launches.push({ workflow, args }),
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
