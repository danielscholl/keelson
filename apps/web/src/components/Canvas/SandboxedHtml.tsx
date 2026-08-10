import {
  CANVAS_HTML_ACTION_CHANNEL,
  CANVAS_HTML_SIZE_CHANNEL,
  CANVAS_HTML_THEME_CHANNEL,
  type CanvasHtmlAction,
  canvasHtmlActionSchema,
  canvasHtmlSizeSchema,
} from "@keelson/shared";
import { useCallback, useEffect, useMemo, useRef } from "react";

// Content-Security-Policy for the sandboxed document — defense-in-depth behind
// the sandbox attribute, which is the real boundary. Deny everything, then
// re-allow only what rib markup needs: inline script/style, and data:/https:
// images + fonts. `connect-src 'none'` is the load-bearing line — it blocks
// fetch/XHR/sendBeacon/WebSocket, so frame script cannot exfiltrate. A meta-CSP
// only governs content parsed AFTER it, so it must be the first element in <head>.
const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: https:",
  "font-src data: https:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "child-src 'none'",
].join("; ");

// The bridge the host injects first inside the frame: gives rib markup an
// ergonomic `keelson.action(type, payload)` and a declarative `[data-canvas-action]`
// click path, both posting the one canonical wire shape. It is NOT a trust
// boundary — rib script runs in the same frame and could post directly, so the
// host re-validates every message on receipt; the bridge is convenience only.
// It also applies host→frame theme pushes (see CANVAS_HTML_THEME_CHANNEL): only
// the parent can hold this frame's window reference, so `e.source` is the gate.
const BRIDGE_SCRIPT = `
(function () {
  var CHANNEL = ${JSON.stringify(CANVAS_HTML_ACTION_CHANNEL)};
  var THEME_CHANNEL = ${JSON.stringify(CANVAS_HTML_THEME_CHANNEL)};
  function post(type, payload) {
    if (typeof type !== "string" || !type) return;
    parent.postMessage({ channel: CHANNEL, type: type, payload: payload }, "*");
  }
  window.keelson = { action: post };
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-canvas-action]") : null;
    if (el) post(el.getAttribute("data-canvas-action"), undefined);
  });
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.channel !== THEME_CHANNEL) return;
    if (d.theme !== "light" && d.theme !== "dark") return;
    document.documentElement.setAttribute("data-theme", d.theme);
    document.documentElement.style.colorScheme = d.theme;
  });
  // Report content height so the host can size the frame to fit. Measured from
  // body (margins added back) because documentElement.scrollHeight floors at the
  // viewport, which would keep a tall frame from ever shrinking; that term only
  // counts when it genuinely overflows the viewport (abs content anchored past
  // body). The 2px dead band breaks the feedback loop a fractional or vh-derived
  // height could set up between the parent resizing and the frame re-measuring.
  var SIZE_CHANNEL = ${JSON.stringify(CANVAS_HTML_SIZE_CHANNEL)};
  var lastHeight = 0;
  function postSize() {
    var doc = document.documentElement;
    var body = document.body;
    if (!doc || !body) return;
    var s = getComputedStyle(body);
    var h = body.scrollHeight + (parseFloat(s.marginTop) || 0) + (parseFloat(s.marginBottom) || 0);
    if (doc.scrollHeight > window.innerHeight) h = Math.max(h, doc.scrollHeight);
    h = Math.ceil(h);
    if (Math.abs(h - lastHeight) < 2) return;
    lastHeight = h;
    parent.postMessage({ channel: SIZE_CHANNEL, height: h }, "*");
  }
  var scheduled = false;
  function schedulePostSize() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; postSize(); });
  }
  window.addEventListener("load", postSize);
  if (typeof ResizeObserver === "function") {
    var sizer = new ResizeObserver(schedulePostSize);
    if (document.documentElement) sizer.observe(document.documentElement);
  }
  // The bridge runs from <head>, before <body> exists; attach on DOM ready.
  // ResizeObserver only sees box sizes — abs-positioned content changes scroll
  // extent without a box change — so a MutationObserver fills that gap; both
  // coalesce through one rAF-scheduled re-measure.
  document.addEventListener("DOMContentLoaded", function () {
    if (typeof sizer !== "undefined" && document.body) sizer.observe(document.body);
    if (typeof MutationObserver === "function") {
      new MutationObserver(schedulePostSize).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    }
    postSize();
  });
})();
`.trim();

export type CanvasFrameTheme = "light" | "dark";

// The SPA always resolves data-theme to "light" | "dark" on the root element
// (App.tsx); dark is the :root default, so anything else reads as dark.
function readDocumentTheme(): CanvasFrameTheme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

// Compose the sandboxed document from a rib-supplied body fragment. The host owns
// the shell — doctype, the first-in-<head> meta-CSP, and the bridge — so a rib can
// never omit or precede them. The fragment is dropped into <body> as opaque text
// (never interpolated into an attribute), so it cannot break out of the document.
// `theme` stamps the initial data-theme + color-scheme on <html> so token-level
// markup renders in the SPA's resolved theme from first paint; later toggles
// arrive over the theme channel without a reload. The value is a closed union,
// never free text, so the interpolation cannot break out of the attribute.
export function composeCanvasHtmlDoc(fragment: string, theme?: CanvasFrameTheme): string {
  const htmlTag = theme ? `<html data-theme="${theme}" style="color-scheme: ${theme}">` : "<html>";
  return [
    "<!doctype html>",
    htmlTag,
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    '<meta charset="utf-8">',
    `<script>${BRIDGE_SCRIPT}</script>`,
    "</head>",
    "<body>",
    fragment,
    "</body>",
    "</html>",
  ].join("\n");
}

// Renders untrusted, rib-supplied HTML in an isolated iframe, relays its
// structured actions to `onAction`, and pushes the SPA's resolved theme into it.
export function SandboxedHtml({
  html,
  onAction,
}: {
  html: string;
  onAction?: (action: CanvasHtmlAction) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const themeRef = useRef<CanvasFrameTheme>(readDocumentTheme());

  // srcDoc is keyed on the fragment only — a theme toggle must NOT recompose it
  // (that reloads the frame and loses scroll/state); toggles ride postMessage.
  // The stamp uses whatever theme is current when the fragment changes; the
  // frame's load handler re-posts the live value, so a stale stamp self-corrects.
  const srcDoc = useMemo(() => composeCanvasHtmlDoc(html, themeRef.current), [html]);

  const postTheme = useCallback(() => {
    const win = ref.current?.contentWindow;
    if (typeof win?.postMessage !== "function") return;
    // Opaque-origin frames have no targetable origin, so "*" is required; the
    // payload is just a theme name, nothing sensitive rides this channel.
    win.postMessage({ channel: CANVAS_HTML_THEME_CHANNEL, theme: themeRef.current }, "*");
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const theme = readDocumentTheme();
      if (theme === themeRef.current) return;
      themeRef.current = theme;
      postTheme();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [postTheme]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Cheap discriminant before any parse — `window` sees unrelated postMessage
      // traffic (dev HMR, devtools, other frames) we must ignore.
      if ((e.data as { channel?: unknown } | null)?.channel !== CANVAS_HTML_ACTION_CHANNEL) return;
      // Source identity is the gate, NOT origin: an opaque-origin frame posts with
      // origin "null", which every sandboxed frame on the page shares, so only the
      // contentWindow comparison reliably identifies OUR frame.
      const frame = ref.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const parsed = canvasHtmlActionSchema.safeParse(e.data);
      if (parsed.success) onAction?.(parsed.data);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onAction]);

  useEffect(() => {
    function onSize(e: MessageEvent) {
      if ((e.data as { channel?: unknown } | null)?.channel !== CANVAS_HTML_SIZE_CHANNEL) return;
      const frame = ref.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const parsed = canvasHtmlSizeSchema.safeParse(e.data);
      if (!parsed.success) return;
      // The frame is untrusted: clamp before applying. The floor keeps a broken
      // measurement from collapsing the panel; the ceiling keeps a hostile one
      // from minting a hundred-thousand-pixel page.
      const height = Math.min(Math.max(Math.round(parsed.data.height), 160), 20_000);
      frame.style.height = `${height}px`;
      // Content-sized now — the pre-measurement viewport floor no longer applies.
      frame.style.minHeight = "0px";
    }
    window.addEventListener("message", onSize);
    return () => window.removeEventListener("message", onSize);
  }, []);

  // sandbox="allow-scripts" WITHOUT allow-same-origin keeps the frame a unique
  // opaque origin: it cannot reach the parent DOM, cookies, storage, or the
  // keelson origin, whether the SPA is served from :7878 or the :5173 dev proxy.
  // NEVER add allow-same-origin — paired with allow-scripts it lets the frame strip
  // its own sandbox and read the parent. This single token is the trust boundary.
  return (
    <iframe
      ref={ref}
      className="canvas-html-frame"
      title="HTML canvas"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={postTheme}
    />
  );
}
