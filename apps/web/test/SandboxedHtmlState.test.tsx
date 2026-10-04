import { describe, expect, mock, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { CANVAS_HTML_STATE_CHANNEL } from "@keelson/shared";
import { fireEvent, render } from "@testing-library/react";
import { composeCanvasHtmlDoc, SandboxedHtml } from "../src/components/Canvas/SandboxedHtml.tsx";

let sequence = 0;
function key() {
  return `rib:state-test:${sequence++}`;
}

function connect(frame: HTMLIFrameElement) {
  const posts: any[] = [];
  const source = { postMessage: (message: unknown) => posts.push(message) };
  Object.defineProperty(frame, "contentWindow", { value: source, configurable: true });
  return {
    posts,
    source,
    send(data: unknown, sender: unknown = source) {
      const event = new MessageEvent("message", { data });
      Object.defineProperty(event, "source", { value: sender });
      window.dispatchEvent(event);
    },
    save(state: unknown) {
      this.send({ channel: CANVAS_HTML_STATE_CHANNEL, type: "save", state });
    },
    restores() {
      return posts.filter((message) => message.channel === CANVAS_HTML_STATE_CHANNEL);
    },
  };
}

function frame(container: HTMLElement) {
  return container.querySelector("iframe")!;
}

function bridge() {
  const posts: any[] = [];
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const parent = { postMessage: (message: unknown) => posts.push(structuredClone(message)) };
  const warnings: string[] = [];
  const context = createContext({
    parent,
    TextEncoder,
    console: { warn: (reason: string) => warnings.push(reason) },
    document: {
      addEventListener() {},
      documentElement: { setAttribute() {}, style: {} },
    },
    addEventListener(type: string, handler: (event: any) => void) {
      listeners[type] ??= [];
      listeners[type].push(handler);
    },
  });
  runInContext("window = globalThis", context);
  const script = composeCanvasHtmlDoc("").match(/<script>([\s\S]*?)<\/script>/)![1]!;
  runInContext(script, context);
  return {
    posts,
    warnings,
    context,
    evaluate(code: string) {
      return runInContext(code, context);
    },
    receive(message: unknown, source: unknown = parent) {
      const data = runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(message))})`, context);
      for (const listener of listeners.message ?? []) listener({ source, data });
    },
    restore(state: unknown) {
      this.receive({ channel: CANVAS_HTML_STATE_CHANNEL, type: "restore", state });
    },
  };
}

describe("injected HTML state bridge", () => {
  test("posts saveState and preserves the action API", () => {
    const fixture = bridge();
    fixture.evaluate('keelson.saveState({ task: "x" }); keelson.action("run", { id: 1 })');
    expect(fixture.posts[0]).toEqual({
      channel: CANVAS_HTML_STATE_CHANNEL,
      type: "save",
      state: { task: "x" },
    });
    expect(fixture.posts[1].type).toBe("run");
  });

  test("delivers immediately or buffers until registration, and never replays", () => {
    for (const early of [true, false]) {
      const fixture = bridge();
      fixture.evaluate("calls = []; handler = function(state) { calls.push(state); }");
      if (early) fixture.evaluate("keelson.onRestore(handler)");
      fixture.restore({});
      if (!early) fixture.evaluate("keelson.onRestore(handler)");
      fixture.restore({ task: "duplicate" });
      fixture.evaluate("keelson.onRestore(handler)");
      expect(fixture.evaluate("calls")).toEqual([{}]);
    }
  });

  test("latest undelivered handler wins and callback failures are visible", () => {
    const fixture = bridge();
    fixture.evaluate(
      'calls = []; keelson.onRestore(() => calls.push("old")); keelson.onRestore(() => calls.push("new"))',
    );
    fixture.restore({ task: "x" });
    expect(fixture.evaluate("calls")).toEqual(["new"]);
    const broken = bridge();
    broken.evaluate('keelson.onRestore(() => { throw new Error("callback failed"); })');
    expect(() => broken.restore({})).toThrow("callback failed");
    broken.evaluate("calls = []; keelson.onRestore(state => calls.push(state))");
    expect(broken.evaluate("calls")).toEqual([]);
  });

  test("a replacement document receives real host output in its callback", () => {
    const viewKey = key();
    const view = render(<SandboxedHtml html="old" viewKey={viewKey} />);
    const connection = connect(frame(view.container));
    const original = bridge();
    original.evaluate('keelson.saveState({ task: "x" })');
    connection.send(original.posts[0]);
    view.rerender(<SandboxedHtml html="new" viewKey={viewKey} />);
    fireEvent.load(frame(view.container));
    const replacement = bridge();
    replacement.receive(connection.restores()[0]);
    replacement.evaluate("calls = []; keelson.onRestore(state => calls.push(state))");
    expect(replacement.evaluate("calls")).toEqual([{ task: "x" }]);
  });
});

describe("HTML state host", () => {
  test("restores the latest whole object once after replacement, without actions", () => {
    const onAction = mock();
    const viewKey = key();
    const view = render(
      <SandboxedHtml html="<p>first</p>" viewKey={viewKey} onAction={onAction} />,
    );
    const connection = connect(frame(view.container));
    connection.save({ task: "first", removed: true });
    connection.save({ task: "latest" });
    view.rerender(<SandboxedHtml html="<p>second</p>" viewKey={viewKey} onAction={onAction} />);
    fireEvent.load(frame(view.container));
    fireEvent.load(frame(view.container));
    expect(connection.restores()).toEqual([
      { channel: CANVAS_HTML_STATE_CHANNEL, type: "restore", state: { task: "latest" } },
    ]);
    expect(onAction).not.toHaveBeenCalled();
  });

  test("rejects invalid envelopes, foreign sources and wrong directions without clearing state", () => {
    const viewKey = key();
    const view = render(<SandboxedHtml html="first" viewKey={viewKey} />);
    const connection = connect(frame(view.container));
    connection.save({ task: "kept" });
    connection.save({ invalid: undefined });
    connection.send({
      channel: CANVAS_HTML_STATE_CHANNEL,
      type: "save",
      state: {},
      viewKey: "other",
    });
    connection.send({ channel: CANVAS_HTML_STATE_CHANNEL, type: "restore", state: {} });
    connection.send({ channel: "other", type: "save", state: {} });
    connection.send({ channel: CANVAS_HTML_STATE_CHANNEL, type: "save", state: {} }, {});
    view.rerender(<SandboxedHtml html="second" viewKey={viewKey} />);
    fireEvent.load(frame(view.container));
    expect(connection.restores()[0].state).toEqual({ task: "kept" });
    view.unmount();
  });

  test("switching keys with identical HTML remounts and rejects the departing frame", () => {
    const firstKey = key();
    const secondKey = key();
    const view = render(<SandboxedHtml html="same" viewKey={firstKey} />);
    const firstFrame = frame(view.container);
    const first = connect(firstFrame);
    first.save({ task: "first" });
    view.rerender(<SandboxedHtml html="same" viewKey={secondKey} />);
    expect(frame(view.container)).not.toBe(firstFrame);
    const second = connect(frame(view.container));
    first.save({ task: "stale" });
    fireEvent.load(frame(view.container));
    expect(second.restores()).toEqual([]);
    view.rerender(<SandboxedHtml html="same" viewKey={firstKey} />);
    const restored = connect(frame(view.container));
    fireEvent.load(frame(view.container));
    expect(restored.restores()[0].state).toEqual({ task: "first" });
  });

  test("keyed state survives remount while unkeyed state remains isolated", () => {
    const viewKey = key();
    const first = render(<SandboxedHtml html="first" viewKey={viewKey} />);
    connect(frame(first.container)).save({});
    first.unmount();
    const second = render(<SandboxedHtml html="second" viewKey={viewKey} />);
    const restored = connect(frame(second.container));
    fireEvent.load(frame(second.container));
    expect(restored.restores()[0].state).toEqual({});
    const unkeyed = render(<SandboxedHtml html="first" />);
    connect(frame(unkeyed.container)).save({ task: "local" });
    unkeyed.unmount();
    const fresh = render(<SandboxedHtml html="first" />);
    const isolated = connect(frame(fresh.container));
    fireEvent.load(frame(fresh.container));
    expect(isolated.restores()).toEqual([]);
  });
});
