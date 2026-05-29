import { describe, expect, mock, test } from "bun:test";
import type { CanvasDocument, WorkflowNodeSummary } from "@keelson/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as realApi from "../src/api.ts";
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

mock.module("../src/api.ts", () => ({
  ...realApi,
  getRunArtifact: (runId: string, path: string) => artifactImpl(runId, path),
}));

const { CanvasProvider, useCanvas } = await import("../src/components/Canvas/CanvasHost.tsx");
const { RunTrace } = await import("../src/components/Workflows/RunTrace.tsx");
const { ToolCallsBlock } = await import("../src/components/Chat/ToolCallsBlock.tsx");

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

  test("reserved kinds render a not-yet-supported placeholder", () => {
    render(
      <CanvasProvider>
        <Opener doc={{ kind: "view", source: { type: "inline", text: "x" }, title: "v" }} />
      </CanvasProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByRole("dialog").textContent).toContain("not yet supported");
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
