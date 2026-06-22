import {
  CANVAS_HTML_ACTION_CHANNEL,
  type CanvasHtmlAction,
  canvasHtmlActionSchema,
} from "@keelson/shared";
import { useEffect, useRef } from "react";

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
const BRIDGE_SCRIPT = `
(function () {
  var CHANNEL = ${JSON.stringify(CANVAS_HTML_ACTION_CHANNEL)};
  function post(type, payload) {
    if (typeof type !== "string" || !type) return;
    parent.postMessage({ channel: CHANNEL, type: type, payload: payload }, "*");
  }
  window.keelson = { action: post };
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-canvas-action]") : null;
    if (el) post(el.getAttribute("data-canvas-action"), undefined);
  });
})();
`.trim();

// Compose the sandboxed document from a rib-supplied body fragment. The host owns
// the shell — doctype, the first-in-<head> meta-CSP, and the bridge — so a rib can
// never omit or precede them. The fragment is dropped into <body> as opaque text
// (never interpolated into an attribute), so it cannot break out of the document.
export function composeCanvasHtmlDoc(fragment: string): string {
  return [
    "<!doctype html>",
    "<html>",
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

// Renders untrusted, rib-supplied HTML in an isolated iframe and relays its
// structured actions to `onAction`.
export function SandboxedHtml({
  html,
  onAction,
}: {
  html: string;
  onAction?: (action: CanvasHtmlAction) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);

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
      srcDoc={composeCanvasHtmlDoc(html)}
    />
  );
}
