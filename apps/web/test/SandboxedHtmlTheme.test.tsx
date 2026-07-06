import { afterEach, describe, expect, test } from "bun:test";
import { CANVAS_HTML_THEME_CHANNEL } from "@keelson/shared";
import { render, waitFor } from "@testing-library/react";
import { composeCanvasHtmlDoc, SandboxedHtml } from "../src/components/Canvas/SandboxedHtml.tsx";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
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
});

describe("SandboxedHtml theme forwarding", () => {
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
});
