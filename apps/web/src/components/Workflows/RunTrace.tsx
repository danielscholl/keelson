import type { WorkflowNodeSummary } from "@keelson/shared";
import { useEffect, useState } from "react";
import type { NodeView, RunView as RunViewState } from "../../hooks/useWorkflowRun.ts";
import type { NodeViewStatus } from "../../lib/dagLayout.ts";
import { useCanvas } from "../Canvas/CanvasHost.tsx";
import { MarkdownContent } from "../Chat/MarkdownContent.tsx";
import { ThinkingBlock } from "../Chat/ThinkingBlock.tsx";
import { ToolCallsBlock, toolCallsFromContentParts } from "../Chat/ToolCallsBlock.tsx";
import { ApprovalComposer } from "./ApprovalComposer.tsx";

// When the run has reached terminal status, downstream nodes the hook
// never observed (no node_started, no node_done) must not stay "pending".
// `cancelled` runs cancel everything downstream by definition; otherwise
// (the run terminated without reaching the node) `skipped` is the most
// accurate UI signal — the executor either skipped via `when:` or
// short-circuited via trigger_rule, and either way the node won't run.
export function fallbackStatusFromRun(status: RunViewState["status"]): NodeViewStatus {
  if (status === "cancelled") return "cancelled";
  if (status === "succeeded" || status === "failed") return "skipped";
  return "pending";
}

function formatDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Maps node-type → trace-head chip className. Mirrors DagNode's same map
// so the inline chip in the trace matches the chip in the graph view.
function chipForType(type?: string): { className: string; label: string } | null {
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower === "bash") return { className: "bash", label: "BASH" };
  if (lower === "prompt") return { className: "prompt", label: "PROMPT" };
  if (lower === "approval") return { className: "approval", label: "APPROVAL" };
  return { className: "generic", label: lower.toUpperCase() };
}

// Approval messages carry literal `$ARTIFACTS_DIR/<path>` tokens (approval
// bodies aren't path-substituted), so the gate can offer to open the file in a
// canvas. Prompt/command output is substituted to real paths and isn't scanned.
const ARTIFACT_REF_RE = /\$ARTIFACTS_DIR\/([^\s`'"]+)/g;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// Trim trailing prose punctuation and *unbalanced* closing brackets from a
// captured ref, so `[$ARTIFACTS_DIR/plan.md]` → `plan.md` while a balanced
// filename like `report(1).md` is kept intact.
function trimArtifactRef(raw: string): string {
  let s = raw;
  while (s.length > 0) {
    const last = s.slice(-1);
    if (".,;:".includes(last)) {
      s = s.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener && countChar(s, last) > countChar(s, opener)) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

function extractArtifactPaths(message: string): string[] {
  const out = new Set<string>();
  for (const match of message.matchAll(ARTIFACT_REF_RE)) {
    const captured = match[1];
    if (!captured) continue;
    const rel = trimArtifactRef(captured);
    if (rel) out.add(rel);
  }
  return [...out];
}

interface TraceRowProps {
  schema: WorkflowNodeSummary;
  view: NodeView;
  // Run id for building artifact canvas sources; null pre-start.
  runId: string | null;
  // Live = workflow run not yet terminal. Drives the typing dots + the
  // "tools block stays open while streaming" behavior shared with chat.
  streaming: boolean;
  // Submit/abandon callbacks; only set on the awaiting node so the composer
  // renders inline. Both undefined → no composer (terminal node).
  onSubmitApproval?: (text: string) => Promise<void>;
  onAbandon?: () => Promise<void>;
}

function TraceRow({ schema, view, runId, streaming, onSubmitApproval, onAbandon }: TraceRowProps) {
  const { openCanvas } = useCanvas();
  // Collapse by default for terminal nodes (much easier to scan a finished
  // run); auto-open live states so the user sees streaming output and
  // approval prompts without clicking.
  const status = view.status;
  const autoOpen = status === "running" || status === "awaiting";
  const [open, setOpen] = useState(autoOpen);
  // Catch rows that mounted while `pending` and only later flipped live —
  // open them on the transition so the user sees streaming output / the
  // approval prompt without clicking. Does not auto-close; collapse is
  // sticky once the user toggles or the node terminates.
  useEffect(() => {
    if (status === "running" || status === "awaiting") setOpen(true);
  }, [status]);
  const chip = chipForType(schema.type);
  const dur = formatDuration(view.durationMs);
  const isPromptish = schema.type === "prompt" || schema.type === "approval";

  // contentParts → tool calls; remaining text blocks render via markdown.
  const toolCalls = toolCallsFromContentParts(view.contentParts);
  const textBlocks = view.contentParts.filter((p) => p.type === "text");
  const textFromBlocks = textBlocks.map((b) => (b.type === "text" ? b.text : "")).join("");

  const isAwaiting = status === "awaiting";
  // Text to open in the canvas: prompt/approval render markdown (text blocks);
  // bash/generic stream into logLines (e.g. plan-ready's cat'd plan).
  const canvasText = isPromptish
    ? textFromBlocks
    : view.logLines.length > 0
      ? view.logLines.join("\n")
      : textFromBlocks;
  const artifactPaths =
    isAwaiting && view.awaitingMessage ? extractArtifactPaths(view.awaitingMessage) : [];
  const hasBody =
    isAwaiting ||
    view.thinkingText.length > 0 ||
    textBlocks.length > 0 ||
    toolCalls.length > 0 ||
    view.logLines.length > 0 ||
    Boolean(view.error);

  return (
    <div className={`trace-row ${status}`}>
      <div className="trace-head">
        <button
          type="button"
          className="caret"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse node trace" : "Expand node trace"}
        >
          {open ? "▾" : "▸"}
        </button>
        <span>{schema.id}</span>
        {chip && <span className={`node-type ${chip.className}`}>{chip.label}</span>}
        {status === "running" && (
          <span className="typing-dots" role="img" aria-label="streaming">
            <span />
            <span />
            <span />
          </span>
        )}
        {isAwaiting && <span className="dur awaiting">awaiting</span>}
        {dur && <span className="dur">{dur}</span>}
        {canvasText.trim().length > 0 && (
          <button
            type="button"
            className="trace-canvas-btn"
            onClick={() =>
              openCanvas({
                kind: "markdown",
                source: { type: "inline", text: canvasText },
                title: schema.id,
              })
            }
            aria-label={`Open ${schema.id} output in canvas`}
            title="Open in canvas"
          >
            ⤢
          </button>
        )}
      </div>
      {open && hasBody && (
        <div className="trace-body">
          {isAwaiting && view.awaitingMessage && (
            <div className="approval-callout" role="status">
              <div className="callout-head">◆ Approval required</div>
              <div className="callout-body">
                <MarkdownContent source={view.awaitingMessage} />
                {runId !== null && artifactPaths.length > 0 && (
                  <div className="canvas-open-links">
                    {artifactPaths.map((rel) => (
                      <button
                        key={rel}
                        type="button"
                        className="canvas-open-link"
                        onClick={() =>
                          openCanvas({
                            kind: "markdown",
                            source: { type: "artifact", runId, path: rel },
                            title: rel,
                          })
                        }
                      >
                        open {rel}
                      </button>
                    ))}
                  </div>
                )}
                {onSubmitApproval && onAbandon && (
                  <ApprovalComposer
                    nodeId={schema.id}
                    onSubmit={onSubmitApproval}
                    onAbandon={onAbandon}
                  />
                )}
              </div>
            </div>
          )}
          {view.error && <div className="trace-error">{view.error}</div>}
          {view.thinkingText.length > 0 && (
            <ThinkingBlock content={view.thinkingText} streaming={status === "running"} />
          )}
          {textBlocks.length > 0 && isPromptish && <MarkdownContent source={textFromBlocks} />}
          {textBlocks.length > 0 && !isPromptish && (
            <pre className="code-block">{textFromBlocks}</pre>
          )}
          {toolCalls.length > 0 && (
            <ToolCallsBlock toolCalls={toolCalls} streaming={streaming && status === "running"} />
          )}
          {view.logLines.length > 0 && <pre className="code-block">{view.logLines.join("\n")}</pre>}
        </div>
      )}
    </div>
  );
}

export interface RunTraceProps {
  schemaNodes: ReadonlyArray<WorkflowNodeSummary>;
  nodes: Record<string, NodeView>;
  // Run id for building artifact canvas sources; null pre-start.
  runId: string | null;
  // True while the run is still streaming; flips false on run_done.
  streaming: boolean;
  // Paused approval node id + interaction callbacks. When the awaiting
  // node renders, its row gets the inline ApprovalComposer.
  awaitingNodeId?: string;
  onSubmitApproval?: (text: string) => Promise<void>;
  onAbandon?: () => Promise<void>;
}

// Right-pane streaming log. One collapsible row per node the executor has
// actually touched, in DAG declaration order — the DAG paints "what will
// happen", the trace paints "what has happened", so nodes only appear
// here once a frame about them arrives. Skipped / cancelled fallbacks
// (nodes the run terminated past without reaching) stay hidden; the DAG
// already shows them grayed out.
export function RunTrace({
  schemaNodes,
  nodes,
  runId,
  streaming,
  awaitingNodeId,
  onSubmitApproval,
  onAbandon,
}: RunTraceProps) {
  const observed = schemaNodes.filter((s) => nodes[s.id] !== undefined);
  if (observed.length === 0) {
    return (
      <div className="trace trace-empty" role="status">
        No nodes have run yet.
      </div>
    );
  }
  return (
    <div className="trace">
      {observed.map((schema) => {
        const view = nodes[schema.id]!;
        const awaitingThisRow = awaitingNodeId === schema.id;
        return (
          <TraceRow
            key={schema.id}
            schema={schema}
            view={view}
            runId={runId}
            streaming={streaming}
            onSubmitApproval={awaitingThisRow ? onSubmitApproval : undefined}
            onAbandon={awaitingThisRow ? onAbandon : undefined}
          />
        );
      })}
    </div>
  );
}
