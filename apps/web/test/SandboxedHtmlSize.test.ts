import { describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { CANVAS_HTML_SIZE_CHANNEL } from "@keelson/shared";
import { composeCanvasHtmlDoc } from "../src/components/Canvas/SandboxedHtml.tsx";

function sizeBridge() {
  const sizes = {
    bodyHeight: 80,
    rootHeight: 600,
    viewport: 600,
    marginTop: "0px",
    marginBottom: "0px",
  };
  const posts: { channel: string; height: number }[] = [];
  const windowListeners: Record<string, (() => void)[]> = {};
  const documentListeners: Record<string, (() => void)[]> = {};
  const frames: (() => void)[] = [];
  const resizeObservers: ResizeObserver[] = [];
  const mutationObservers: MutationObserver[] = [];
  let bodyReady = false;
  let measurements = 0;
  const body = {
    get scrollHeight() {
      return sizes.bodyHeight;
    },
  };
  const root = {
    get scrollHeight() {
      return sizes.rootHeight;
    },
    setAttribute() {},
    style: {},
  };
  class ResizeObserver {
    readonly targets: unknown[] = [];
    constructor(readonly notify: () => void) {
      resizeObservers.push(this);
    }
    observe(target: unknown) {
      this.targets.push(target);
    }
  }
  class MutationObserver {
    readonly observations: { target: unknown; options: unknown }[] = [];
    constructor(readonly notify: () => void) {
      mutationObservers.push(this);
    }
    observe(target: unknown, options: unknown) {
      this.observations.push({ target, options });
    }
  }
  const context = createContext({
    parent: {
      postMessage(message: { channel: string; height: number }) {
        posts.push(structuredClone(message));
      },
    },
    TextEncoder,
    document: {
      documentElement: root,
      get body() {
        return bodyReady ? body : null;
      },
      addEventListener(type: string, handler: () => void) {
        documentListeners[type] ??= [];
        documentListeners[type].push(handler);
      },
    },
    get innerHeight() {
      return sizes.viewport;
    },
    getComputedStyle() {
      measurements++;
      return { marginTop: sizes.marginTop, marginBottom: sizes.marginBottom };
    },
    addEventListener(type: string, handler: () => void) {
      windowListeners[type] ??= [];
      windowListeners[type].push(handler);
    },
    ResizeObserver,
    MutationObserver,
    requestAnimationFrame(callback: () => void) {
      frames.push(callback);
      return frames.length;
    },
  });
  runInContext("window = globalThis", context);
  const script = composeCanvasHtmlDoc("").match(/<script>([\s\S]*?)<\/script>/)![1]!;
  runInContext(script, context);
  return {
    sizes,
    posts,
    body,
    root,
    resizeObservers,
    mutationObservers,
    frames,
    measurements: () => measurements,
    domReady() {
      bodyReady = true;
      for (const listener of documentListeners.DOMContentLoaded ?? []) listener();
    },
    load() {
      for (const listener of windowListeners.load ?? []) listener();
    },
    notifyResize() {
      for (const observer of resizeObservers) observer.notify();
    },
    notifyMutation() {
      for (const observer of mutationObservers) observer.notify();
    },
    flush() {
      for (const callback of frames.splice(0)) callback();
    },
    measure() {
      this.notifyResize();
      this.flush();
    },
  };
}

describe("injected HTML sizing bridge", () => {
  test("waits for the body and installs DOM-ready observers before reporting", () => {
    const fixture = sizeBridge();
    expect(fixture.resizeObservers).toHaveLength(1);
    expect(fixture.resizeObservers[0]!.targets).toEqual([fixture.root]);
    expect(fixture.mutationObservers).toHaveLength(0);
    fixture.load();
    expect(fixture.posts).toEqual([]);
    expect(fixture.measurements()).toBe(0);

    fixture.domReady();
    expect(fixture.resizeObservers[0]!.targets).toEqual([fixture.root, fixture.body]);
    expect(fixture.mutationObservers).toHaveLength(1);
    expect(fixture.mutationObservers[0]!.observations).toEqual([
      {
        target: fixture.root,
        options: { childList: true, subtree: true, attributes: true, characterData: true },
      },
    ]);
    expect(fixture.posts).toEqual([{ channel: CANVAS_HTML_SIZE_CHANNEL, height: 80 }]);
    fixture.load();
    expect(fixture.posts).toHaveLength(1);
  });

  test("shrinks to body content when root scroll height only matches the viewport", () => {
    const fixture = sizeBridge();
    fixture.sizes.bodyHeight = 400;
    fixture.domReady();
    fixture.sizes.bodyHeight = 80;
    fixture.measure();
    expect(fixture.posts.map((message) => message.height)).toEqual([400, 80]);
  });

  test("rounds up body margins and includes only genuine root overflow", () => {
    const fixture = sizeBridge();
    fixture.sizes.marginTop = "8.2px";
    fixture.sizes.marginBottom = "3.3px";
    fixture.domReady();
    fixture.sizes.rootHeight = 720;
    fixture.measure();
    fixture.sizes.bodyHeight = 730;
    fixture.measure();
    fixture.sizes.rootHeight = 600;
    fixture.sizes.bodyHeight = 40;
    fixture.measure();
    expect(fixture.posts.map((message) => message.height)).toEqual([92, 720, 742, 52]);
  });

  test("suppresses duplicate and sub-2px reports but accepts a 2px change", () => {
    const fixture = sizeBridge();
    fixture.domReady();
    fixture.measure();
    fixture.sizes.bodyHeight = 81;
    fixture.measure();
    expect(fixture.posts.map((message) => message.height)).toEqual([80]);
    fixture.sizes.bodyHeight = 82;
    fixture.measure();
    fixture.sizes.bodyHeight = 81;
    fixture.measure();
    expect(fixture.posts.map((message) => message.height)).toEqual([80, 82]);
    fixture.sizes.bodyHeight = 80;
    fixture.measure();
    expect(fixture.posts.map((message) => message.height)).toEqual([80, 82, 80]);
  });

  test("keeps suppressing viewport-coupled growth, then accepts independent changes", () => {
    const fixture = sizeBridge();
    fixture.domReady();
    for (const height of [180, 280]) {
      fixture.sizes.bodyHeight = height;
      fixture.sizes.viewport += 100;
      fixture.sizes.rootHeight = fixture.sizes.viewport;
      fixture.measure();
      fixture.measure();
      expect(fixture.posts.map((message) => message.height)).toEqual([80]);
    }
    fixture.sizes.bodyHeight = 300;
    fixture.measure();
    fixture.sizes.bodyHeight = 40;
    fixture.sizes.viewport = 600;
    fixture.sizes.rootHeight = 600;
    fixture.measure();
    fixture.sizes.bodyHeight = 80;
    fixture.measure();
    expect(fixture.posts.map((message) => message.height)).toEqual([80, 300, 40, 80]);
  });

  test.each([
    [182, [80]],
    [183, [80, 183]],
  ] as const)("applies the 2px viewport-growth tolerance for height %s", (height, expected) => {
    const fixture = sizeBridge();
    fixture.domReady();
    fixture.sizes.viewport = 700;
    fixture.sizes.rootHeight = 700;
    fixture.sizes.bodyHeight = height;
    fixture.measure();
    expect(fixture.posts.map((message) => message.height)).toEqual(expected);
  });

  test("coalesces resize and mutation notifications into one rAF measurement", () => {
    const fixture = sizeBridge();
    fixture.domReady();
    const initialMeasurements = fixture.measurements();
    fixture.notifyResize();
    fixture.notifyMutation();
    fixture.notifyResize();
    fixture.notifyMutation();
    expect(fixture.frames).toHaveLength(1);
    expect(fixture.measurements()).toBe(initialMeasurements);
    fixture.sizes.bodyHeight = 120;
    fixture.flush();
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.measurements()).toBe(initialMeasurements + 1);
    expect(fixture.posts.map((message) => message.height)).toEqual([80, 120]);

    fixture.sizes.bodyHeight = 60;
    fixture.notifyMutation();
    expect(fixture.frames).toHaveLength(1);
    fixture.flush();
    expect(fixture.measurements()).toBe(initialMeasurements + 2);
    expect(fixture.posts.map((message) => message.height)).toEqual([80, 120, 60]);
  });
});
