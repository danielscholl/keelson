import { describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useStreamingPulse } from "../src/hooks/useStreamingPulse.ts";

const QUIET = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Props = { version: number | null; enabled: boolean };

function render(initial: Props) {
  return renderHook((p: Props) => useStreamingPulse(p.version, p.enabled, QUIET), {
    initialProps: initial,
  });
}

describe("useStreamingPulse", () => {
  test("stays idle for a disabled region even as frames arrive", async () => {
    const { result, rerender } = render({ version: 1, enabled: false });
    expect(result.current).toBe(false);
    rerender({ version: 2, enabled: false });
    expect(result.current).toBe(false);
  });

  test("does not pulse before any frame arrives", () => {
    const { result } = render({ version: null, enabled: true });
    expect(result.current).toBe(false);
  });

  test("treats the first frame as the baseline, not a stream event", () => {
    const { result } = render({ version: 1, enabled: true });
    expect(result.current).toBe(false);
  });

  test("lights on a subsequent frame, then decays back to idle after the quiet window", async () => {
    const { result, rerender } = render({ version: 1, enabled: true });
    expect(result.current).toBe(false);

    rerender({ version: 2, enabled: true });
    expect(result.current).toBe(true);

    await act(async () => {
      await sleep(QUIET + 20);
    });
    expect(result.current).toBe(false);
  });

  test("a run of frames keeps it lit — each frame re-arms the decay", async () => {
    const { result, rerender } = render({ version: 1, enabled: true });
    rerender({ version: 2, enabled: true });
    expect(result.current).toBe(true);

    // Another frame lands before the first would have decayed.
    await act(async () => {
      await sleep(QUIET / 2);
    });
    rerender({ version: 3, enabled: true });
    await act(async () => {
      await sleep(QUIET / 2);
    });
    // Still lit: the v3 frame re-armed the window past when v2's would have fired.
    expect(result.current).toBe(true);

    await act(async () => {
      await sleep(QUIET + 20);
    });
    expect(result.current).toBe(false);
  });

  test("a quietMs change mid-pulse does not strand the lit state", async () => {
    // A caller passing a changing quietMs must not re-run the effect and clear
    // the armed decay without re-arming it; the pulse decays on its armed window.
    const { result, rerender } = renderHook(
      (p: { version: number | null; enabled: boolean; quietMs: number }) =>
        useStreamingPulse(p.version, p.enabled, p.quietMs),
      { initialProps: { version: 1, enabled: true, quietMs: QUIET } },
    );
    rerender({ version: 2, enabled: true, quietMs: QUIET });
    expect(result.current).toBe(true);
    // quietMs changes while lit, version unchanged.
    rerender({ version: 2, enabled: true, quietMs: QUIET * 20 });
    await act(async () => {
      await sleep(QUIET + 20);
    });
    expect(result.current).toBe(false);
  });

  test("a re-render with no version change fires no pulse", async () => {
    const { result, rerender } = render({ version: 1, enabled: true });
    rerender({ version: 2, enabled: true });
    await act(async () => {
      await sleep(QUIET + 20);
    });
    expect(result.current).toBe(false);
    // Same version again (a re-render for an unrelated reason) must not re-light.
    rerender({ version: 2, enabled: true });
    expect(result.current).toBe(false);
  });
});
