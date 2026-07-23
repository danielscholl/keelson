import { describe, expect, mock, test } from "bun:test";
import {
  CANVAS_HTML_ACTION_CHANNEL,
  type CanvasBoardView,
  type CanvasDocument,
  type WorkflowNodeSummary,
} from "@keelson/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as realApi from "../src/api.ts";
import type { SnapshotState } from "../src/hooks/useSnapshot.ts";
import type { NodeView } from "../src/hooks/useWorkflowRun.ts";

// Render markdown as raw text so assertions don't depend on Streamdown under
// happy-dom; the drawer's dispatch + the trace affordances are what's tested.
mock.module("../src/components/Chat/MarkdownContent.tsx", () => ({
  MarkdownContent: ({ source }: { source: string }) => source,
}));

let artifactImpl: (
  runId: string,
  path: string,
) => Promise<{ path: string; content: string } | null> = async () => null;

let postRibActionImpl: (ribId: string, action: unknown) => Promise<unknown> = async () => ({
  ok: true,
});

mock.module("../src/api.ts", () => ({
  ...realApi,
  getRunArtifact: (runId: string, path: string) => artifactImpl(runId, path),
  postRibAction: (ribId: string, action: unknown) => postRibActionImpl(ribId, action),
}));

// HTML-canvas snapshot source resolves through useSnapshot; default to loading so
// only the test that sets snapshotImpl exercises a live frame.
let snapshotImpl: SnapshotState = {
  status: "loading",
  data: null,
  version: null,
  composedAt: null,
};
mock.module("../src/hooks/useSnapshot.ts", () => ({ useSnapshot: () => snapshotImpl }));

// Stub the graph renderer so the dispatch is testable without mounting
// ReactFlow under happy-dom; the layout itself is covered in viewGraphLayout.test.ts.
mock.module("../src/components/Canvas/GraphView.tsx", () => ({
  GraphView: ({ view }: { view: { nodes: unknown[] } }) => (
    <div data-testid="graph-view">{view.nodes.length} nodes</div>
  ),
}));

const { CanvasProvider, useCanvas } = await import("../src/components/Canvas/CanvasHost.tsx");
const { SandboxedHtml, composeCanvasHtmlDoc } = await import(
  "../src/components/Canvas/SandboxedHtml.tsx"
);
const { RunTrace } = await import("../src/components/Workflows/RunTrace.tsx");
const { ToolCallsBlock } = await import("../src/components/Chat/ToolCallsBlock.tsx");
const { BoardView } = await import("../src/components/Canvas/BoardView.tsx");
const { BoardActionProvider } = await import("../src/components/Canvas/BoardActionContext.tsx");

function Opener({ doc }: { doc: CanvasDocument }) {
  const { openCanvas, close } = useCanvas();
  return (
    <div>
      <button type="button" onClick={() => openCanvas(doc)}>
        open
      </button>
      <button type="button" onClick={close}>
        hook-close
      </button>
    </div>
  );
}

const INLINE: CanvasDocument = {
  kind: "markdown",
  source: { type: "inline", text: "plain inline canvas body" },
  title: "inline-doc",
};

// Dispatch a window `message` with a forced `source` — happy-dom's MessageEvent
// doesn't reliably preserve `source` from the init dict, and the source-identity
// gate is exactly what these tests exercise.
function postMessageTo(data: unknown, source: unknown) {
  const e = new MessageEvent("message", { data });
  Object.defineProperty(e, "source", { value: source, configurable: true });
  window.dispatchEvent(e);
}

describe("CanvasProvider / useCanvas — log kind", () => {
  const LOG: CanvasDocument = {
    kind: "log",
    source: { type: "inline", text: "\x1b[32mAll secrets configured\x1b[0m" },
    title: "provision",
  };

  test("renders terminal output verbatim with ANSI resolved, not as markdown", () => {
    render(
      <CanvasProvider>
        <Opener doc={LOG} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    // The escape is consumed by the renderer, never shown as literal text.
    expect(dialog.textContent).toContain("All secrets configured");
    expect(dialog.textContent).not.toContain("[32m");
    // …and it renders as a styled span in a monospace block, not markdown.
    expect(dialog.querySelector(".code-block pre.code-block-body .ansi-text")).not.toBeNull();
    expect(dialog.querySelector("span.ansi-green-fg")?.textContent).toBe("All secrets configured");
  });

  test("a snapshot-sourced log renders as terminal too, not through the markdown fallback", () => {
    // `log` is a valid rib view kind, so a snapshot payload reaches this branch;
    // it must not fall back to the markdown renderer.
    const priorSnapshot = snapshotImpl;
    snapshotImpl = {
      status: "live",
      data: "\x1b[32mdone\x1b[0m `not code`",
      version: 1,
      composedAt: null,
    };
    try {
      render(
        <CanvasProvider>
          <Opener
            doc={{ kind: "log", source: { type: "snapshot", key: "rib:x:logs" }, title: "logs" }}
          />
        </CanvasProvider>,
      );
      fireEvent.click(screen.getByText("open"));
      const dialog = screen.getByRole("dialog");
      expect(dialog.querySelector(".code-block pre.code-block-body .ansi-text")).not.toBeNull();
      expect(dialog.querySelector("span.ansi-green-fg")?.textContent).toBe("done");
      expect(dialog.textContent).not.toContain("[32m");
    } finally {
      snapshotImpl = priorSnapshot;
    }
  });
});

describe("CanvasProvider / useCanvas", () => {
  test("opens inline markdown and closes via the close button", () => {
    render(
      <CanvasProvider>
        <Opener doc={INLINE} />
      </CanvasProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByRole("dialog").textContent).toContain("plain inline canvas body");
    fireEvent.click(screen.getByRole("button", { name: "Close canvas" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Escape closes the drawer", () => {
    render(
      <CanvasProvider>
        <Opener doc={INLINE} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("hook close() dismisses the drawer", () => {
    render(
      <CanvasProvider>
        <Opener doc={INLINE} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("hook-close"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("the drawer is a modal dialog: aria-modal, a backdrop, and initial focus on the close button", () => {
    render(
      <CanvasProvider>
        <Opener doc={INLINE} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector(".canvas-backdrop")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close canvas" }));
  });

  test("clicking the backdrop closes the drawer", () => {
    render(
      <CanvasProvider>
        <Opener doc={INLINE} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(document.querySelector(".canvas-backdrop") as Element);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("closing the drawer restores focus to the opener", () => {
    render(
      <CanvasProvider>
        <Opener doc={INLINE} />
      </CanvasProvider>,
    );
    const trigger = screen.getByText("open");
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Close canvas" }));
    expect(document.activeElement).toBe(trigger);
  });

  test("renders a docked footer when one is passed to openCanvas", () => {
    function FooterOpener() {
      const { openCanvas } = useCanvas();
      return (
        <button
          type="button"
          onClick={() => openCanvas(INLINE, { footer: <div>DOCKED FOOTER</div> })}
        >
          open-with-footer
        </button>
      );
    }
    render(
      <CanvasProvider>
        <FooterOpener />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open-with-footer"));
    expect(screen.getByRole("dialog").textContent).toContain("DOCKED FOOTER");
  });

  test("inline html renders a sandboxed iframe (allow-scripts only) carrying CSP, bridge, and the fragment", () => {
    render(
      <CanvasProvider>
        <Opener
          doc={{ kind: "html", source: { type: "inline", text: "<p>hi from rib</p>" }, title: "h" }}
        />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const frame = screen.getByRole("dialog").querySelector("iframe.canvas-html-frame");
    expect(frame).not.toBeNull();
    // The single sandbox token IS the trust boundary — assert it exactly so a
    // regression adding allow-same-origin (the sandbox-escape footgun) fails here.
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    const srcdoc = frame?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("<p>hi from rib</p>");
  });

  test("composeCanvasHtmlDoc puts the CSP meta first in <head>, before the bridge, fragment in body", () => {
    const doc = composeCanvasHtmlDoc("<button data-canvas-action='ping'>go</button>");
    const cspAt = doc.indexOf('http-equiv="Content-Security-Policy"');
    const bridgeAt = doc.indexOf("window.keelson");
    const bodyAt = doc.indexOf("<body>");
    // A meta-CSP only governs content parsed after it, so it must precede the bridge.
    expect(doc.indexOf("<head>")).toBeGreaterThanOrEqual(0);
    expect(cspAt).toBeGreaterThan(doc.indexOf("<head>"));
    expect(bridgeAt).toBeGreaterThan(cspAt);
    expect(doc).toContain("<button data-canvas-action='ping'>go</button>");
    expect(doc.indexOf("<button")).toBeGreaterThan(bodyAt);
  });

  test("SandboxedHtml relays a valid action from its own frame and ignores impostors", () => {
    const seen: unknown[] = [];
    render(<SandboxedHtml html="<p>x</p>" onAction={(a) => seen.push(a)} />);
    const frame = document.querySelector("iframe.canvas-html-frame") as HTMLIFrameElement;
    // Pin a known contentWindow so the source-identity gate is deterministic under
    // happy-dom (which doesn't model real frame windows).
    const win = {} as Window;
    Object.defineProperty(frame, "contentWindow", { value: win, configurable: true });
    const valid = { channel: CANVAS_HTML_ACTION_CHANNEL, type: "ping", payload: { a: 1 } };

    postMessageTo(valid, {} as Window); // wrong source → ignored
    postMessageTo({ channel: "x", type: "ping" }, win); // wrong channel → ignored
    postMessageTo({ channel: CANVAS_HTML_ACTION_CHANNEL, type: "" }, win); // bad schema → ignored
    expect(seen).toEqual([]);

    postMessageTo(valid, win); // right source + valid body → relayed
    expect(seen).toEqual([valid]);
  });

  test("a snapshot-sourced html action dispatches to the rib that owns the key", async () => {
    snapshotImpl = {
      status: "live",
      data: "<button data-canvas-action='suspend'>x</button>",
      version: 1,
      composedAt: "2026-01-01T00:00:00Z",
    };
    const calls: Array<{ ribId: string; action: unknown }> = [];
    postRibActionImpl = async (ribId, action) => {
      calls.push({ ribId, action });
      return { ok: true };
    };
    render(
      <CanvasProvider>
        <Opener
          doc={{ kind: "html", source: { type: "snapshot", key: "rib:demo:panel" }, title: "h" }}
        />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const frame = screen
      .getByRole("dialog")
      .querySelector("iframe.canvas-html-frame") as HTMLIFrameElement;
    const win = {} as Window;
    Object.defineProperty(frame, "contentWindow", { value: win, configurable: true });
    postMessageTo(
      { channel: CANVAS_HTML_ACTION_CHANNEL, type: "suspend", payload: { cluster: "demo" } },
      win,
    );
    await waitFor(() => expect(calls.length).toBe(1));
    // The frame-relayed action is stamped origin "canvas-html" so the owning rib
    // can gate it; only type/payload come from the frame itself.
    expect(calls[0]).toEqual({
      ribId: "demo",
      action: { type: "suspend", payload: { cluster: "demo" }, origin: "canvas-html" },
    });
  });

  test("a drawer board action's run-workflow directive fires the handler and closes the drawer", async () => {
    snapshotImpl = {
      status: "live",
      data: {
        view: "board",
        sections: [{ kind: "actions", items: [{ type: "launch", label: "Launch" }] }],
      },
      version: 1,
      composedAt: "2026-01-01T00:00:00Z",
    };
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "run-workflow", workflow: "chamber-genesis", args: { topic: "nav" } },
    });
    const launches: Array<{ workflow: string; args: Record<string, string> }> = [];
    function LaunchOpener() {
      const { openCanvas } = useCanvas();
      return (
        <button
          type="button"
          onClick={() =>
            openCanvas(
              { kind: "view", source: { type: "snapshot", key: "rib:demo:panel" }, title: "b" },
              { onLaunchWorkflow: (workflow, args) => launches.push({ workflow, args }) },
            )
          }
        >
          open-launch
        </button>
      );
    }
    render(
      <CanvasProvider>
        <LaunchOpener />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open-launch"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Launch" }));
    // The launch handler fires, and the drawer closes (navigate-away to Workflows).
    await waitFor(() =>
      expect(launches).toEqual([{ workflow: "chamber-genesis", args: { topic: "nav" } }]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("a drawer board action's open-canvas directive opens that snapshot's board in the drawer", async () => {
    snapshotImpl = {
      status: "live",
      data: {
        view: "board",
        sections: [{ kind: "actions", items: [{ type: "drill", label: "Open" }] }],
      },
      version: 1,
      composedAt: "2026-01-01T00:00:00Z",
    };
    // The board action returns an open-canvas directive for a different snapshot.
    // ViewCanvas sources openCanvas from context locally (no opener handler), so
    // the drawer replaces its doc — asserted via the drawer's title swap.
    postRibActionImpl = async () => ({
      ok: true,
      data: { effect: "open-canvas", key: "rib:demo:session-7", title: "Session 7" },
    });
    function DrillOpener() {
      const { openCanvas } = useCanvas();
      return (
        <button
          type="button"
          onClick={() =>
            openCanvas({
              kind: "view",
              source: { type: "snapshot", key: "rib:demo:index" },
              title: "Index",
            })
          }
        >
          open-index
        </button>
      );
    }
    render(
      <CanvasProvider>
        <DrillOpener />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open-index"));
    expect(screen.getByRole("dialog").querySelector(".canvas-drawer-title")?.textContent).toBe(
      "Index",
    );
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Open" }));
    // The drawer stays open but swaps to the drilled-into snapshot's board.
    await waitFor(() =>
      expect(screen.getByRole("dialog").querySelector(".canvas-drawer-title")?.textContent).toBe(
        "Session 7",
      ),
    );
  });

  test("a snapshot html canvas fails closed when its payload isn't a string", () => {
    snapshotImpl = {
      status: "live",
      data: { not: "a string" },
      version: 1,
      composedAt: "2026-01-01T00:00:00Z",
    };
    render(
      <CanvasProvider>
        <Opener
          doc={{ kind: "html", source: { type: "snapshot", key: "rib:demo:panel" }, title: "h" }}
        />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("expected text but received structured data");
    // Structured data must never be stringified into the iframe.
    expect(dialog.querySelector("iframe.canvas-html-frame")).toBeNull();
  });

  test("inline view table renders headers and rows", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "table",
          columns: [{ key: "name", label: "Name" }, { key: "status" }],
          rows: [{ name: "alpha", status: "ok" }],
        }),
      },
      title: "tbl",
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Name");
    expect(dialog.textContent).toContain("alpha");
    expect(dialog.textContent).toContain("ok");
  });

  test("inline view table renders a toned cell as a data-tone attribute", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "table",
          columns: [{ key: "svc" }, { key: "gate" }],
          rows: [{ svc: "alpha", gate: { value: "ERROR", tone: "error" } }],
        }),
      },
      title: "tbl",
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("ERROR");
    expect(dialog.querySelector('td[data-tone="error"]')).not.toBeNull();
  });

  test("inline view table renders badge cells (value + grade chips, and badge-only)", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "table",
          columns: [{ key: "service" }, { key: "quality" }, { key: "fail" }],
          rows: [
            {
              service: "storage",
              quality: {
                value: "85%",
                tone: "ok",
                badges: [
                  { text: "A", tone: "ok" },
                  { text: "C", tone: "warn" },
                ],
              },
              fail: { badges: [{ text: "34", tone: "error" }] },
            },
          ],
        }),
      },
      title: "tbl",
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    // Three chips total: the two grade badges + the standalone count badge.
    expect(dialog.querySelectorAll(".canvas-cell-badge").length).toBe(3);
    expect(dialog.querySelector('.canvas-cell-badge[data-tone="warn"]')?.textContent).toBe("C");
    expect(dialog.querySelector('.canvas-cell-badge[data-tone="error"]')?.textContent).toBe("34");
    // The Quality cell keeps its leading value alongside the chips.
    expect(dialog.querySelector(".canvas-cell-value")?.textContent).toBe("85%");
    // A badge-only cell shows the chip, never a "—" placeholder.
    expect(dialog.textContent).not.toContain("—");
  });

  test("inline view graph dispatches to the graph renderer", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "graph",
          nodes: [{ id: "a", label: "A" }, { id: "b" }],
          edges: [{ source: "a", target: "b" }],
        }),
      },
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("graph-view").textContent).toContain("2 nodes");
  });

  test("inline view board renders header, sections, a link and a copy button", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "board",
          title: "Quality",
          header: { chip: "venus", segments: [{ label: "Fail", n: 9, tone: "error" }] },
          sections: [
            { kind: "stats", items: [{ label: "Services", value: 23 }] },
            { kind: "table", columns: [{ key: "svc" }], rows: [{ svc: "alpha" }] },
            {
              kind: "cards",
              items: [
                {
                  title: "Keycloak",
                  href: "https://portal.test",
                  fields: [{ label: "user", value: "admin", copyable: true }],
                },
              ],
            },
            {
              kind: "rows",
              items: [
                {
                  icon: "⎈",
                  chip: { label: "CLUSTER", tone: "info" },
                  text: "job started",
                  trailing: "21m",
                },
              ],
            },
          ],
        }),
      },
      title: "board",
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Quality");
    expect(dialog.textContent).toContain("Services");
    expect(dialog.textContent).toContain("alpha");
    expect(dialog.textContent).toContain("Keycloak");
    expect(dialog.textContent).toContain("job started");
    // Feed row: leading icon char + a tone-colored category chip.
    const feedRow = dialog.querySelector(".cvb-row");
    expect(feedRow?.querySelector(".cvb-row-icon")?.textContent).toBe("⎈");
    expect(feedRow?.querySelector('.cvb-chip[data-tone="info"]')?.textContent).toBe("CLUSTER");
    expect(dialog.querySelector('a[href="https://portal.test"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy user" })).toBeTruthy();
  });

  test("board renders reserved identity tones through to data-tone attributes", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "board",
          sections: [
            {
              kind: "cards",
              items: [
                { title: "edie", dot: "id-olive", pill: { label: "reviewer", tone: "id-olive" } },
              ],
            },
            {
              kind: "rows",
              items: [{ chip: { label: "fenster", tone: "id-teal" }, text: "reviewed the diff" }],
            },
            {
              kind: "grid",
              cells: [{ label: "R4", badge: { text: "verbal", tone: "id-rose" } }],
            },
          ],
        }),
      },
      title: "minds",
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector('.cvb-card-dot[data-tone="id-olive"]')).not.toBeNull();
    expect(dialog.querySelector('.cvb-pill[data-tone="id-olive"]')?.textContent).toBe("reviewer");
    expect(dialog.querySelector('.cvb-chip[data-tone="id-teal"]')?.textContent).toBe("fenster");
    expect(dialog.querySelector('.cvb-grid-badge[data-tone="id-rose"]')?.textContent).toBe(
      "verbal",
    );
  });

  test("declared-capacity cards grid pins columns and marks actionless ghosts as pads", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "board",
          sections: [
            {
              kind: "cards",
              grid: true,
              columns: 4,
              items: [
                { title: "Moneypenny", pill: { label: "Chief of Staff" } },
                {
                  title: "Open seat",
                  ghost: true,
                  actions: [{ type: "describe-own", label: "Author a Mind" }],
                },
                { title: "Empty seat", ghost: true },
                { title: "Empty seat", ghost: true },
              ],
            },
          ],
        }),
      },
      title: "bench",
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    const grid = dialog.querySelector(".cvb-cards--grid");
    expect(grid?.getAttribute("data-columns")).toBe("4");
    expect((grid as HTMLElement).style.getPropertyValue("--cvb-cols")).toBe("4");
    // Pads: decorative ghosts without actions — hidden from the tree; the
    // launchpad ghost (it carries actions) is a real seat, never a pad.
    const pads = dialog.querySelectorAll(".cvb-card--pad");
    expect(pads.length).toBe(2);
    for (const pad of pads) {
      expect(pad.getAttribute("aria-hidden")).toBe("true");
    }
    const launchpad = dialog.querySelector(".cvb-card--ghost:not(.cvb-card--pad)");
    expect(launchpad?.textContent).toContain("Open seat");
    expect(launchpad?.getAttribute("aria-hidden")).toBeNull();
  });

  test("board renders a people field as toned names and stacks a stacked card's fields", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "board",
          sections: [
            {
              kind: "cards",
              items: [
                {
                  title: "architecture debate",
                  fields: [
                    {
                      label: "with",
                      people: [
                        { name: "Mycroft", tone: "id-amber" },
                        { name: "Jarvis", tone: "id-teal" },
                      ],
                    },
                    { label: "started", value: "2h ago" },
                  ],
                },
                {
                  title: "Athena",
                  stacked: true,
                  fields: [{ value: "> writing SOUL.md…" }, { value: "> identity: Athena" }],
                },
              ],
            },
          ],
        }),
      },
      title: "rooms",
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    const people = dialog.querySelector(".cvb-people");
    expect(people).not.toBeNull();
    const persons = people ? [...people.querySelectorAll(".cvb-person")] : [];
    expect(persons.map((p) => p.textContent)).toEqual(["Mycroft", "Jarvis"]);
    expect(persons[0]?.getAttribute("data-tone")).toBe("id-amber");
    expect(persons[1]?.getAttribute("data-tone")).toBe("id-teal");
    // The plain-value sibling still renders through the scalar path.
    expect(dialog.textContent).toContain("2h ago");
    // The stacked card carries the column modifier; the non-stacked one doesn't.
    const fieldBlocks = [...dialog.querySelectorAll(".cvb-card-fields")];
    expect(fieldBlocks.length).toBe(2);
    expect(fieldBlocks[0]?.classList.contains("cvb-card-fields--stacked")).toBe(false);
    expect(fieldBlocks[1]?.classList.contains("cvb-card-fields--stacked")).toBe(true);
  });

  test("board rows item with detail renders a disclosure; without detail renders a plain row", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "board",
          sections: [
            {
              kind: "rows",
              items: [
                { glyph: "ok", text: "plain row", trailing: "R8" },
                { glyph: "info", text: "review passed", detail: "Full synthesis:\nboth agreed." },
              ],
            },
          ],
        }),
      },
      title: "board",
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    const disclosure = dialog.querySelector("details.cvb-row-details");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.querySelector("summary .cvb-row-text")?.textContent).toBe("review passed");
    expect(disclosure?.querySelector(".cvb-row-detail")?.textContent).toContain("Full synthesis:");
    const plain = [...dialog.querySelectorAll("div.cvb-row")].find((el) =>
      el.textContent?.includes("plain row"),
    );
    expect(plain).toBeTruthy();
    expect(plain?.closest("details")).toBeNull();
  });

  test("board renders a grid, inline bars, and a toned-mono card title with a reason line", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "board",
          sections: [
            {
              kind: "grid",
              cells: [
                {
                  label: "partition",
                  href: "https://sonar.test",
                  badge: { text: "A", tone: "ok" },
                },
                { label: "legal", badge: { text: "E", tone: "error" } },
              ],
            },
            {
              kind: "bars",
              inline: true,
              items: [{ label: "wellbore", value: 3, total: 9, tone: "error", trailing: "2 crit" }],
            },
            {
              kind: "cards",
              items: [
                {
                  title: "CVE-2024-1234",
                  titleTone: "error",
                  mono: true,
                  pill: { label: "wellbore", tone: "info" },
                  reason: { label: "why flagged:", text: "stale-61d" },
                },
              ],
            },
          ],
        }),
      },
      title: "board",
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    // Grid: one cell per entry, the linked cell is an anchor, badges carry tone.
    expect(dialog.querySelectorAll(".cvb-grid-cell").length).toBe(2);
    expect(dialog.querySelector('a.cvb-grid-cell--link[href="https://sonar.test"]')).not.toBeNull();
    expect(dialog.querySelector('.cvb-grid-badge[data-tone="error"]')?.textContent).toBe("E");
    // Inline bars: the bars container carries the inline modifier.
    expect(dialog.querySelector(".cvb-bars--inline")).not.toBeNull();
    // Card title: toned + monospace, with the dashed reason line + dim label.
    const title = dialog.querySelector(".cvb-card-title--mono");
    expect(title?.getAttribute("data-tone")).toBe("error");
    expect(title?.textContent).toBe("CVE-2024-1234");
    const reason = dialog.querySelector(".cvb-card-reason");
    expect(reason?.textContent).toContain("why flagged:");
    expect(reason?.textContent).toContain("stale-61d");
    expect(reason?.querySelector(".cvb-card-reason-label")?.textContent?.trim()).toBe(
      "why flagged:",
    );
  });

  test("board renders badge-less grid cells as a bare labelled link strip", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "board",
          sections: [
            {
              kind: "grid",
              title: "PMC Report",
              cells: [
                { label: "Status Summary", href: "https://pmc.test/" },
                { label: "History", href: "https://pmc.test/history.html" },
                { label: "Graded", badge: { text: "A", tone: "ok" } },
              ],
            },
          ],
        }),
      },
      title: "board",
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelectorAll(".cvb-grid-cell").length).toBe(3);
    // A badge-less cell renders its label and emits no badge element at all.
    const strip = dialog.querySelector('a.cvb-grid-cell--link[href="https://pmc.test/"]');
    expect(strip?.querySelector(".cvb-grid-label")?.textContent).toBe("Status Summary");
    expect(strip?.querySelector(".cvb-grid-badge")).toBeNull();
    // A badged cell in the same grid is unaffected.
    expect(dialog.querySelector('.cvb-grid-badge[data-tone="ok"]')?.textContent).toBe("A");
    expect(dialog.querySelectorAll(".cvb-grid-badge").length).toBe(1);
  });

  test("board renders table-cell and bars-item hrefs as safe anchors", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "board",
          sections: [
            {
              kind: "bars",
              items: [{ label: "keycloak", value: 3, total: 9, href: "https://sonar.test/bar" }],
            },
            {
              kind: "table",
              columns: [{ key: "svc" }, { key: "rating" }],
              rows: [
                {
                  svc: "alpha",
                  rating: { value: "A", tone: "error", href: "https://sonar.test/cell" },
                },
              ],
            },
          ],
        }),
      },
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    const barLink = dialog.querySelector('a.cvb-bar[href="https://sonar.test/bar"]');
    expect(barLink?.textContent).toContain("keycloak");
    const cellLink = dialog.querySelector('a.cvb-link[href="https://sonar.test/cell"]');
    expect(cellLink?.textContent?.trim()).toBe("A");
    // A toned linked cell keeps its status color: the tone rides the anchor as data-tone.
    expect(cellLink?.getAttribute("data-tone")).toBe("error");
  });

  test("board collapses unsafe href schemes to plain text (no anchor)", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: {
        type: "inline",
        text: JSON.stringify({
          view: "board",
          sections: [
            { kind: "cards", items: [{ title: "evil card", href: "javascript:alert(1)" }] },
            { kind: "rows", items: [{ text: "evil row", href: "data:text/html,<b>x</b>" }] },
            {
              kind: "bars",
              items: [{ label: "evil bar", value: 1, total: 2, href: "javascript:alert(2)" }],
            },
            {
              kind: "table",
              columns: [{ key: "c" }],
              rows: [{ c: { value: "evil cell", href: "data:text/html,x" } }],
            },
          ],
        }),
      },
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    // The labels still render, but never as clickable anchors.
    expect(dialog.textContent).toContain("evil card");
    expect(dialog.textContent).toContain("evil row");
    expect(dialog.textContent).toContain("evil bar");
    expect(dialog.textContent).toContain("evil cell");
    expect(dialog.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(dialog.querySelector('a[href^="data:"]')).toBeNull();
  });

  test("malformed view data fails closed to an error note", () => {
    const doc: CanvasDocument = {
      kind: "view",
      source: { type: "inline", text: JSON.stringify({ view: "pie", slices: [] }) },
    };
    render(
      <CanvasProvider>
        <Opener doc={doc} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByRole("dialog").textContent).toContain("didn't match a known view type");
  });

  test("artifact source fetches and renders content", async () => {
    artifactImpl = async () => ({ path: "plan.md", content: "fetched artifact body" });
    render(
      <CanvasProvider>
        <Opener
          doc={{
            kind: "markdown",
            source: { type: "artifact", runId: "r1", path: "plan.md" },
            title: "plan.md",
          }}
        />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("fetched artifact body"),
    );
  });

  test("artifact 404 (null) renders the no-longer-available message", async () => {
    artifactImpl = async () => null;
    render(
      <CanvasProvider>
        <Opener
          doc={{
            kind: "markdown",
            source: { type: "artifact", runId: "r1", path: "plan.md" },
            title: "plan.md",
          }}
        />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("no longer available"),
    );
  });
});

function node(over: Partial<NodeView> & Pick<NodeView, "nodeId" | "status">): NodeView {
  return { contentParts: [], thinkingText: "", logLines: [], ...over };
}

function renderTrace(
  schemaNodes: WorkflowNodeSummary[],
  nodes: Record<string, NodeView>,
  awaitingNodeId?: string,
) {
  return render(
    <CanvasProvider>
      <RunTrace
        schemaNodes={schemaNodes}
        nodes={nodes}
        runId="r1"
        streaming={awaitingNodeId !== undefined}
        awaitingNodeId={awaitingNodeId}
      />
    </CanvasProvider>,
  );
}

describe("RunTrace canvas affordances", () => {
  test("per-node affordance opens the prompt node's text inline", () => {
    renderTrace([{ id: "plan", type: "prompt" }], {
      plan: node({
        nodeId: "plan",
        status: "succeeded",
        type: "prompt",
        contentParts: [{ type: "text", text: "THE PLAN BODY" }],
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open plan output in canvas" }));
    expect(screen.getByRole("dialog").textContent).toContain("THE PLAN BODY");
  });

  test("bash node opens its logLines (the cat'd plan)", () => {
    renderTrace([{ id: "plan-ready", type: "bash" }], {
      "plan-ready": node({
        nodeId: "plan-ready",
        status: "succeeded",
        type: "bash",
        logLines: ["=== PLAN ===", "# Feature"],
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open plan-ready output in canvas" }));
    expect(screen.getByRole("dialog").textContent).toContain("=== PLAN ===");
  });

  test("bash node's logLines render through the log dispatch, ANSI resolved not markdown", () => {
    renderTrace([{ id: "bash-out", type: "bash" }], {
      "bash-out": node({
        nodeId: "bash-out",
        status: "succeeded",
        type: "bash",
        logLines: ["\x1b[32mdone\x1b[0m `not code`"],
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open bash-out output in canvas" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".ansi-text")).not.toBeNull();
    expect(dialog.querySelector("span.ansi-green-fg")?.textContent).toBe("done");
    expect(dialog.textContent).not.toContain("[32m");
  });

  test("approval callout offers an open-<file> artifact affordance from $ARTIFACTS_DIR refs", async () => {
    artifactImpl = async () => ({ path: "plan.md", content: "FETCHED PLAN CONTENT" });
    renderTrace(
      [{ id: "approve-plan", type: "approval" }],
      {
        "approve-plan": node({
          nodeId: "approve-plan",
          status: "awaiting",
          type: "approval",
          awaitingMessage: "Plan is ready at `$ARTIFACTS_DIR/plan.md`. Review and approve.",
        }),
      },
      "approve-plan",
    );
    fireEvent.click(screen.getByText("open plan.md"));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("FETCHED PLAN CONTENT"),
    );
  });

  test("artifact affordance strips bracket/paren delimiters around $ARTIFACTS_DIR refs", () => {
    renderTrace(
      [{ id: "approve", type: "approval" }],
      {
        approve: node({
          nodeId: "approve",
          status: "awaiting",
          type: "approval",
          awaitingMessage: "See [$ARTIFACTS_DIR/plan.md] and (notes) for details.",
        }),
      },
      "approve",
    );
    expect(screen.getByText("open plan.md")).toBeTruthy();
    expect(screen.queryByText("open plan.md]")).toBeNull();
  });

  test("artifact affordance keeps balanced parens/brackets inside a filename", () => {
    renderTrace(
      [{ id: "approve2", type: "approval" }],
      {
        approve2: node({
          nodeId: "approve2",
          status: "awaiting",
          type: "approval",
          awaitingMessage: "Report at `$ARTIFACTS_DIR/report(1).md`.",
        }),
      },
      "approve2",
    );
    expect(screen.getByText("open report(1).md")).toBeTruthy();
  });

  test("strips $ARTIFACTS_DIR path hints from the displayed approval message", () => {
    renderTrace(
      [{ id: "approve", type: "approval" }],
      {
        approve: node({
          nodeId: "approve",
          status: "awaiting",
          type: "approval",
          awaitingMessage: "Approve this plan to continue.\n\n$ARTIFACTS_DIR/plan.md",
        }),
      },
      "approve",
    );
    expect(screen.getByText(/Approve this plan to continue/)).toBeTruthy();
    // The path is a machine hint for the View-plan affordance, not reader prose.
    expect(screen.queryByText(/ARTIFACTS_DIR/)).toBeNull();
    expect(screen.getByText("open plan.md")).toBeTruthy();
  });

  test("strips path-only hints even with balanced delimiters in the filename", () => {
    renderTrace(
      [{ id: "approve", type: "approval" }],
      {
        approve: node({
          nodeId: "approve",
          status: "awaiting",
          type: "approval",
          awaitingMessage: "Approve this plan.\n\n$ARTIFACTS_DIR/report(1).md",
        }),
      },
      "approve",
    );
    expect(screen.getByText(/Approve this plan/)).toBeTruthy();
    expect(screen.queryByText(/ARTIFACTS_DIR/)).toBeNull();
    expect(screen.getByText("open report(1).md")).toBeTruthy();
  });

  test("keeps instructions when an artifact ref shares a line with prose", () => {
    renderTrace(
      [{ id: "approve", type: "approval" }],
      {
        approve: node({
          nodeId: "approve",
          status: "awaiting",
          type: "approval",
          awaitingMessage: "Plan is ready at `$ARTIFACTS_DIR/plan.md`. Review and approve.",
        }),
      },
      "approve",
    );
    // Inline ref → only path-only lines are dropped, so the prose survives.
    expect(screen.getByText(/Review and approve/)).toBeTruthy();
    expect(screen.getByText("open plan.md")).toBeTruthy();
  });

  test("no affordance when a node has no renderable text", () => {
    renderTrace([{ id: "empty", type: "prompt" }], {
      empty: node({ nodeId: "empty", status: "succeeded", type: "prompt" }),
    });
    expect(screen.queryByRole("button", { name: "Open empty output in canvas" })).toBeNull();
  });

  test("pausing on an approval with a plan artifact auto-opens it with a docked composer", async () => {
    artifactImpl = async () => ({ path: "plan.md", content: "FETCHED PLAN" });
    const onSubmit = mock(async () => {});
    const onAbandon = mock(async () => {});
    render(
      <CanvasProvider>
        <RunTrace
          schemaNodes={[{ id: "approve-plan", type: "approval" }]}
          nodes={{
            "approve-plan": node({
              nodeId: "approve-plan",
              status: "awaiting",
              type: "approval",
              awaitingMessage: "Plan is ready at `$ARTIFACTS_DIR/plan.md`.",
            }),
          }}
          runId="r1"
          streaming
          awaitingNodeId="approve-plan"
          onSubmitApproval={onSubmit}
          onAbandon={onAbandon}
        />
      </CanvasProvider>,
    );
    // Auto-opens the plan, with the approval composer docked inside the drawer.
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("FETCHED PLAN"));
    expect(screen.getByRole("button", { name: /View plan/ })).toBeTruthy();
    const approve = within(screen.getByRole("dialog")).getByRole("button", {
      name: /Approve & continue/,
    });
    fireEvent.click(approve);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("approve"));
    // The action closes the drawer.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("ToolCallsBlock autoExpand", () => {
  const calls = [{ id: "t1", toolName: "bash" }];

  test("workflow trace (autoExpand=false) stays collapsed while streaming", () => {
    const { container } = render(<ToolCallsBlock toolCalls={calls} streaming autoExpand={false} />);
    const details = container.querySelector("details.tool-calls-block") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  test("chat default auto-expands while streaming", () => {
    const { container } = render(<ToolCallsBlock toolCalls={calls} streaming />);
    const details = container.querySelector("details.tool-calls-block") as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });
});

describe("BoardView selectable cards", () => {
  const cardsView = (selected: boolean): CanvasBoardView => ({
    view: "board",
    sections: [
      {
        kind: "cards",
        items: [
          {
            title: "Ada",
            selected,
            action: { type: "draft-set", payload: { slug: "ada" } },
            actions: [{ type: "enter", label: "Enter Ada" }],
          },
        ],
      },
    ],
  });

  const renderWithDispatch = (view: CanvasBoardView, runs: unknown[]) =>
    render(
      <BoardActionProvider
        run={async (a) => {
          runs.push(a);
          return { ok: true };
        }}
        reveal={async () => ({ ok: true })}
      >
        <BoardView view={view} />
      </BoardActionProvider>,
    );

  test("a selected card rings; its stretched toggle is aria-pressed and dispatches", () => {
    const runs: unknown[] = [];
    renderWithDispatch(cardsView(true), runs);
    expect(document.querySelector(".cvb-card.is-selected")).not.toBeNull();
    const toggle = document.querySelector(".cvb-card-select");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe("Ada");
    fireEvent.click(toggle as Element);
    expect(runs).toEqual([{ type: "draft-set", payload: { slug: "ada" } }]);
  });

  test("clicking an action button inside the card fires the button, not the card toggle", () => {
    const runs: unknown[] = [];
    renderWithDispatch(cardsView(false), runs);
    fireEvent.click(screen.getByRole("button", { name: "Enter Ada" }));
    expect(runs).toEqual([{ type: "enter" }]);
  });

  test("without a dispatcher the toggle is inert but still conveys the selected state", () => {
    render(<BoardView view={cardsView(true)} />);
    const toggle = document.querySelector(".cvb-card-select") as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
});
