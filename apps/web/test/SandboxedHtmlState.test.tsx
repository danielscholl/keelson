import { describe, expect, mock, test } from "bun:test";
import { CANVAS_HTML_STATE_CHANNEL } from "@keelson/shared";
import { fireEvent, render } from "@testing-library/react";
import { SandboxedHtml } from "../src/components/Canvas/SandboxedHtml.tsx";

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
