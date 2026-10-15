import { afterEach, describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import {
  CANVAS_HTML_STATE_CHANNEL,
  CANVAS_HTML_THEME_CHANNEL,
  DESIGN_PALETTES,
  designTokenFrameVars,
} from "@keelson/shared";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { composeCanvasHtmlDoc, SandboxedHtml } from "../src/components/Canvas/SandboxedHtml.tsx";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-palette");
});

describe("composeCanvasHtmlDoc theme stamp", () => {
  test("stamps data-theme and color-scheme on <html> when a theme is given", () => {
    const doc = composeCanvasHtmlDoc("<p>x</p>", "light");
    expect(doc).toContain('<html data-theme="light" style="color-scheme: light">');
  });

  test("without a theme the shell stays a bare <html>", () => {
    expect(composeCanvasHtmlDoc("<p>x</p>").split("\n")[1]).toBe("<html>");
  });

  test("the CSP meta stays first in <head> ahead of the bridge", () => {
    const doc = composeCanvasHtmlDoc("<p>x</p>", "dark");
    const head = doc.slice(doc.indexOf("<head>"));
    expect(head.indexOf("Content-Security-Policy")).toBeGreaterThan(-1);
    expect(head.indexOf("Content-Security-Policy")).toBeLessThan(head.indexOf("<script>"));
  });

  test("the bridge listens on the theme channel", () => {
    expect(composeCanvasHtmlDoc("<p>x</p>")).toContain(CANVAS_HTML_THEME_CHANNEL);
  });

  test("stamps the palette's tokens as a :root style ahead of the fragment", () => {
    const doc = composeCanvasHtmlDoc("<p>x</p>", "light", "shore");
    const styleAt = doc.indexOf('<style id="keelson-tokens">');
    expect(styleAt).toBeGreaterThan(doc.indexOf("Content-Security-Policy"));
    expect(styleAt).toBeLessThan(doc.indexOf("<body>"));
    expect(doc).toContain(`--accent:${DESIGN_PALETTES.shore.light.accent};`);
  });

  test("without a theme there is no token style", () => {
    expect(composeCanvasHtmlDoc("<p>x</p>")).not.toContain('<style id="keelson-tokens">');
  });
});

function bridge() {
  const listeners: ((event: any) => void)[] = [];
  const parent = { postMessage() {} };
  const head = {
    children: [] as any[],
    prepend(el: any) {
      this.children.unshift(el);
    },
  };
  const root = { attrs: {} as Record<string, string>, style: {} as Record<string, string> };
  const context = createContext({
    parent,
    TextEncoder,
    console,
    document: {
      head,
      addEventListener() {},
      documentElement: {
        setAttribute(name: string, value: string) {
          root.attrs[name] = value;
        },
        style: root.style,
      },
      getElementById: (id: string) => head.children.find((el) => el.id === id) ?? null,
      createElement: () => ({ id: "", textContent: "" }),
    },
    addEventListener(type: string, handler: (event: any) => void) {
      if (type === "message") listeners.push(handler);
    },
  });
  runInContext("window = globalThis", context);
  runInContext(composeCanvasHtmlDoc("").match(/<script>([\s\S]*?)<\/script>/)![1]!, context);
  return {
    head,
    root,
    receive(data: unknown) {
      for (const listener of listeners) listener({ source: parent, data });
    },
  };
}

describe("injected theme bridge", () => {
  test("applies pushed tokens as the frame's :root defaults", () => {
    const frame = bridge();
    frame.receive({
      channel: CANVAS_HTML_THEME_CHANNEL,
      theme: "light",
      tokens: designTokenFrameVars("light", "shore"),
    });
    expect(frame.root.attrs["data-theme"]).toBe("light");
    expect(frame.head.children[0].textContent).toContain(
      `--accent:${DESIGN_PALETTES.shore.light.accent};`,
    );
  });

  test("drops token entries that are not a custom property and a hex color", () => {
    const frame = bridge();
    frame.receive({
      channel: CANVAS_HTML_THEME_CHANNEL,
      theme: "dark",
      tokens: { "--bg": "#101010", color: "red", "--fg": "url(x)", "--x}body{": "#000000" },
    });
    expect(frame.head.children[0].textContent).toBe(":root{--bg:#101010;}");
  });
});

describe("SandboxedHtml theme forwarding", () => {
  test("theme changes preserve the frame and srcDoc without replaying restored state", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const view = render(<SandboxedHtml html="<p>first</p>" />);
    const frame = view.container.querySelector("iframe")!;
    const posts: any[] = [];
    const source = { postMessage: (message: unknown) => posts.push(message) };
    Object.defineProperty(frame, "contentWindow", { value: source, configurable: true });
    const event = new MessageEvent("message", {
      data: { channel: CANVAS_HTML_STATE_CHANNEL, type: "save", state: { task: "x" } },
    });
    Object.defineProperty(event, "source", { value: source });
    window.dispatchEvent(event);
    view.rerender(<SandboxedHtml html="<p>second</p>" />);
    fireEvent.load(frame);
    expect(posts.filter((message) => message.type === "restore")).toHaveLength(1);
    const srcDoc = frame.getAttribute("srcdoc");
    document.documentElement.setAttribute("data-theme", "dark");
    await waitFor(() =>
      expect(posts).toContainEqual({
        channel: CANVAS_HTML_THEME_CHANNEL,
        theme: "dark",
        tokens: designTokenFrameVars("dark"),
      }),
    );
    view.rerender(<SandboxedHtml html="<p>second</p>" />);
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("srcdoc")).toBe(srcDoc);
    expect(posts.filter((message) => message.type === "restore")).toHaveLength(1);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    view.rerender(<SandboxedHtml html="<p>third</p>" />);
    expect(frame.getAttribute("srcdoc")).toContain('data-theme="dark"');
    fireEvent.load(frame);
    expect(posts.filter((message) => message.type === "restore")).toHaveLength(2);
    expect(posts.at(-2)).toEqual({
      channel: CANVAS_HTML_THEME_CHANNEL,
      theme: "dark",
      tokens: designTokenFrameVars("dark"),
    });
    view.unmount();
  });

  test("stamps the SPA's resolved theme into srcDoc", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const { container, unmount } = render(<SandboxedHtml html="<p>x</p>" />);
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("srcdoc")).toContain('data-theme="light"');
    unmount();
  });

  test("defaults to dark when no data-theme is set (the :root default)", () => {
    const { container, unmount } = render(<SandboxedHtml html="<p>x</p>" />);
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain(
      'data-theme="dark"',
    );
    unmount();
  });

  test("posts the theme into the frame when the SPA theme toggles", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const { container, unmount } = render(<SandboxedHtml html="<p>x</p>" />);
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const posts: unknown[] = [];
    // happy-dom's srcdoc frames don't execute; stub the window so the
    // component's postMessage lands somewhere observable.
    Object.defineProperty(frame, "contentWindow", {
      value: { postMessage: (msg: unknown) => posts.push(msg) },
      configurable: true,
    });
    document.documentElement.setAttribute("data-theme", "dark");
    await waitFor(() => {
      expect(
        posts.some(
          (m) =>
            (m as { channel?: string; theme?: string }).channel === CANVAS_HTML_THEME_CHANNEL &&
            (m as { theme?: string }).theme === "dark",
        ),
      ).toBe(true);
    });
    unmount();
  });

  test("posts the palette's tokens when the SPA palette switches", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const { container, unmount } = render(<SandboxedHtml html="<p>x</p>" />);
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const posts: unknown[] = [];
    Object.defineProperty(frame, "contentWindow", {
      value: { postMessage: (msg: unknown) => posts.push(msg) },
      configurable: true,
    });
    document.documentElement.setAttribute("data-palette", "shore");
    await waitFor(() =>
      expect(posts).toContainEqual({
        channel: CANVAS_HTML_THEME_CHANNEL,
        theme: "light",
        tokens: designTokenFrameVars("light", "shore"),
      }),
    );
    unmount();
  });
});
