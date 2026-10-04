import { describe, expect, mock, spyOn, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { CANVAS_HTML_STATE_CHANNEL, CANVAS_HTML_STATE_MAX_BYTES } from "@keelson/shared";
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
  test("does not call a restore handler without a save", () => {
    const fixture = bridge();
    fixture.evaluate("calls = []; keelson.onRestore(state => calls.push(state))");
    expect(fixture.evaluate("calls")).toEqual([]);
  });

  test("rejects foreign, malformed, oversized and wrong-direction restores", () => {
    const fixture = bridge();
    fixture.evaluate("calls = []; keelson.onRestore(state => calls.push(state))");
    const message = { channel: CANVAS_HTML_STATE_CHANNEL, type: "restore", state: {} };
    fixture.receive(message, {});
    fixture.receive({ ...message, channel: "other" });
    fixture.receive({ ...message, type: "save" });
    fixture.receive({ ...message, ribId: "other" });
    fixture.receive({ ...message, state: [] });
    fixture.receive({ ...message, state: { task: "x".repeat(CANVAS_HTML_STATE_MAX_BYTES) } });
    expect(fixture.evaluate("calls")).toEqual([]);
    fixture.restore({ task: "valid" });
    expect(fixture.evaluate("calls")).toEqual([{ task: "valid" }]);
  });

  test("rejects invalid saves with payload-free diagnostics", () => {
    const fixture = bridge();
    fixture.evaluate(`
      var cycle = {}; cycle.self = cycle;
      [null, [], undefined, { task: undefined }, { task: NaN }, { task: Infinity },
       { task: 1n }, { task: Symbol() }, { task: function() {} },
       { task: new Date() }, { task: new Map() }, { task: new Set() }, cycle]
       .forEach(state => keelson.saveState(state));
    `);
    expect(fixture.posts).toEqual([]);
    expect(fixture.warnings.length).toBe(13);
    expect(new Set(fixture.warnings)).toEqual(
      new Set(["HTML state rejected: invalid JSON object or byte limit"]),
    );
  });

  test("catches only clone failures and leaves unexpected errors visible", () => {
    const fixture = bridge();
    fixture.evaluate(
      'parent.postMessage = () => { var error = new Error("secret"); error.name = "DataCloneError"; throw error; }',
    );
    fixture.evaluate("keelson.saveState({})");
    expect(fixture.warnings).toEqual(["HTML state rejected: structured clone failed"]);
    fixture.evaluate('parent.postMessage = () => { throw new Error("unexpected"); }');
    expect(() => fixture.evaluate("keelson.saveState({})")).toThrow("unexpected");
    expect(() => fixture.evaluate("keelson.onRestore(null)")).toThrow(
      "onRestore requires a function",
    );
  });

  test("enforces serialized UTF-8 boundaries for ASCII and multibyte saves", () => {
    const fixture = bridge();
    fixture.evaluate(
      `keelson.saveState({ task: "x".repeat(${CANVAS_HTML_STATE_MAX_BYTES - 11}) })`,
    );
    expect(new TextEncoder().encode(JSON.stringify(fixture.posts[0].state)).byteLength).toBe(
      CANVAS_HTML_STATE_MAX_BYTES,
    );
    fixture.evaluate(
      `keelson.saveState({ task: "x".repeat(${CANVAS_HTML_STATE_MAX_BYTES - 10}) })`,
    );
    fixture.evaluate(`keelson.saveState({ task: "\\u00e9".repeat(32762) + "x" })`);
    expect(new TextEncoder().encode(JSON.stringify(fixture.posts[1].state)).byteLength).toBe(
      CANVAS_HTML_STATE_MAX_BYTES,
    );
    fixture.evaluate(`keelson.saveState({ task: "\\u00e9".repeat(32763) })`);
    expect(fixture.posts).toHaveLength(2);
  });

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
  test("enforces the exact byte boundary and retains canonical copies", () => {
    const viewKey = key();
    const view = render(<SandboxedHtml html="first" viewKey={viewKey} />);
    const connection = connect(frame(view.container));
    const state = { task: "\u00e9".repeat(32762) + "x" };
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBe(
      CANVAS_HTML_STATE_MAX_BYTES,
    );
    connection.save(state);
    state.task = "mutated";
    connection.save({ task: "x".repeat(CANVAS_HTML_STATE_MAX_BYTES - 10) });
    connection.save({ task: "\u00e9".repeat(32763) });
    view.rerender(<SandboxedHtml html="second" viewKey={viewKey} />);
    fireEvent.load(frame(view.container));
    const restored = connection.restores()[0].state;
    expect(restored.task).toBe("\u00e9".repeat(32762) + "x");
    restored.task = "mutated restore";
    view.rerender(<SandboxedHtml html="third" viewKey={viewKey} />);
    fireEvent.load(frame(view.container));
    expect(connection.restores()[1].state.task).toBe("\u00e9".repeat(32762) + "x");
    connection.save({ task: "x".repeat(CANVAS_HTML_STATE_MAX_BYTES - 11) });
    view.rerender(<SandboxedHtml html="fourth" viewKey={viewKey} />);
    fireEvent.load(frame(view.container));
    expect(connection.restores()[2].state.task.length).toBe(CANVAS_HTML_STATE_MAX_BYTES - 11);
  });

  test("deep nesting and non-JSON saves preserve the prior value", () => {
    const viewKey = key();
    const view = render(<SandboxedHtml html="first" viewKey={viewKey} />);
    const connection = connect(frame(view.container));
    connection.save({ task: "kept" });
    const deep: Record<string, unknown> = {};
    let leaf = deep;
    for (let i = 0; i < 20_000; i++) {
      const next = {};
      leaf.next = next;
      leaf = next;
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const invalid of [
      deep,
      cycle,
      null,
      [],
      { task: NaN },
      { task: new Date() },
      { task: 1n },
      { task: Symbol() },
      { task: () => {} },
      { task: new Map() },
      { task: new Set() },
    ]) {
      connection.save(invalid);
    }
    view.rerender(<SandboxedHtml html="second" viewKey={viewKey} />);
    fireEvent.load(frame(view.container));
    expect(connection.restores()[0].state).toEqual({ task: "kept" });
  });

  test("same-key placements share latest saves without live synchronization", () => {
    const viewKey = key();
    const first = render(<SandboxedHtml html="first" viewKey={viewKey} />);
    const second = render(<SandboxedHtml html="second" viewKey={viewKey} />);
    const a = connect(frame(first.container));
    const b = connect(frame(second.container));
    fireEvent.load(frame(first.container));
    fireEvent.load(frame(second.container));
    a.save({ task: "a" });
    expect(b.restores()).toEqual([]);
    b.save({ task: "b" });
    expect(a.restores()).toEqual([]);
    first.rerender(<SandboxedHtml html="replacement" viewKey={viewKey} />);
    fireEvent.load(frame(first.container));
    expect(a.restores()[0].state).toEqual({ task: "b" });
  });

  test("simultaneous unkeyed instances restore only their own component state", () => {
    const a = render(<SandboxedHtml html="same" />);
    const b = render(<SandboxedHtml html="same" />);
    const first = connect(frame(a.container));
    const second = connect(frame(b.container));
    first.save({ task: "a" });
    second.save({ task: "b" });
    a.rerender(<SandboxedHtml html="new" />);
    b.rerender(<SandboxedHtml html="new" />);
    fireEvent.load(frame(a.container));
    fireEvent.load(frame(b.container));
    expect(first.restores()[0].state).toEqual({ task: "a" });
    expect(second.restores()[0].state).toEqual({ task: "b" });
  });

  test("evicts the least-recently-used key while saves and restores refresh recency", () => {
    const keys = Array.from({ length: 65 }, key);
    const view = render(<SandboxedHtml html="same" viewKey={keys[0]} />);
    for (let i = 0; i < 64; i++) {
      view.rerender(<SandboxedHtml html="same" viewKey={keys[i]} />);
      connect(frame(view.container)).save({ index: i });
    }
    view.rerender(<SandboxedHtml html="same" viewKey={keys[0]} />);
    const first = connect(frame(view.container));
    fireEvent.load(frame(view.container));
    expect(first.restores()[0].state).toEqual({ index: 0 });
    view.rerender(<SandboxedHtml html="same" viewKey={keys[1]} />);
    connect(frame(view.container)).save({ index: "updated" });
    view.rerender(<SandboxedHtml html="same" viewKey={keys[64]} />);
    connect(frame(view.container)).save({ index: 64 });
    view.rerender(<SandboxedHtml html="same" viewKey={keys[2]} />);
    const evicted = connect(frame(view.container));
    fireEvent.load(frame(view.container));
    expect(evicted.restores()).toEqual([]);
    view.rerender(<SandboxedHtml html="same" viewKey={keys[0]} />);
    const retained = connect(frame(view.container));
    fireEvent.load(frame(view.container));
    expect(retained.restores()[0].state).toEqual({ index: 0 });
    view.rerender(<SandboxedHtml html="same" viewKey={keys[1]} />);
    const updated = connect(frame(view.container));
    fireEvent.load(frame(view.container));
    expect(updated.restores()[0].state).toEqual({ index: "updated" });
  });

  test("unmount removes message listeners and stale saves cannot change retained state", () => {
    const remove = spyOn(window, "removeEventListener");
    try {
      const viewKey = key();
      const view = render(<SandboxedHtml html="first" viewKey={viewKey} />);
      const connection = connect(frame(view.container));
      connection.save({ task: "kept" });
      view.unmount();
      expect(remove.mock.calls.filter(([type]) => type === "message")).toHaveLength(3);
      connection.save({ task: "stale" });
      const next = render(<SandboxedHtml html="next" viewKey={viewKey} />);
      const restored = connect(frame(next.container));
      fireEvent.load(frame(next.container));
      expect(restored.restores()[0].state).toEqual({ task: "kept" });
    } finally {
      remove.mockRestore();
    }
  });

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
