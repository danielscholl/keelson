import { type ContentBlock, inferToolFamily } from "@keelson/shared";
import { displayToolName } from "./toolNames.ts";

// Per-row source chip. Family is inferred from the tool name prefix
// (everything before the first underscore); display label is the upper-
// cased family, with "BUILT-IN" reserved for unprefixed tool names.
function familyLabel(family: string): string {
  if (family === "other") return "BUILT-IN";
  return family.toUpperCase();
}

export interface LiveToolCall {
  id: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  // Populated when a matching tool_result chunk arrives.
  result?: string;
  isError?: boolean;
}

// Rebuild LiveToolCall[] from persisted `contentParts` so reloaded turns
// render identically to the live path. Orphan tool_result blocks are
// dropped, mirroring the live handler's defensive shape.
export function toolCallsFromContentParts(parts: readonly ContentBlock[]): LiveToolCall[] {
  const calls: LiveToolCall[] = [];
  const byId = new Map<string, LiveToolCall>();
  for (const block of parts) {
    if (block.type === "tool_use") {
      const call: LiveToolCall = {
        id: block.id,
        toolName: block.toolName,
        ...(block.toolInput !== undefined ? { toolInput: block.toolInput } : {}),
      };
      calls.push(call);
      byId.set(block.id, call);
    } else if (block.type === "tool_result") {
      const target = byId.get(block.toolUseId);
      if (!target) continue;
      target.result = block.content;
      if (block.isError !== undefined) target.isError = block.isError;
    }
  }
  return calls;
}

interface ToolCallsBlockProps {
  toolCalls: LiveToolCall[];
  // Open during streaming so the user sees rows accumulate; auto-collapses
  // after `done` so the answer stays the focal point of the bubble.
  streaming: boolean;
  // Chat (default) auto-expands while streaming. The workflow trace passes
  // false: a node can fire 50+ tool calls, so it stays collapsed (uncontrolled
  // — user can still expand it) to keep the trace scannable.
  autoExpand?: boolean;
}

// Brief, single-line preview of the result string for tooltips on collapsed
// rows. Folds whitespace and clips at ~140 chars so a multi-paragraph JSON
// blob doesn't blow out the browser's title display.
function previewResult(result: string | undefined): string | undefined {
  if (!result) return undefined;
  const collapsed = result.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return undefined;
  return collapsed.length <= 140 ? collapsed : `${collapsed.slice(0, 139)}…`;
}

export function ToolCallsBlock({ toolCalls, streaming, autoExpand = true }: ToolCallsBlockProps) {
  if (toolCalls.length === 0) return null;
  // `streaming` gate stops the pulse on a stalled turn that never resolves.
  const pendingCount = streaming
    ? toolCalls.reduce((n, tc) => (tc.result === undefined ? n + 1 : n), 0)
    : 0;
  return (
    // When autoExpand is off the `open` prop is omitted entirely, leaving the
    // element uncontrolled so a user expand survives re-renders mid-stream.
    <details className="tool-calls-block" {...(autoExpand ? { open: streaming } : {})}>
      <summary className="tool-calls-summary">
        {pendingCount > 0
          ? `TOOL CALLS · ${pendingCount} RUNNING`
          : `TOOL CALLS (${toolCalls.length})`}
      </summary>
      <div className="tool-calls-body">
        {toolCalls.map((tc) => {
          const isRunning = streaming && tc.result === undefined;
          const displayName = displayToolName(tc.toolName);
          const showRawName = displayName !== tc.toolName;
          const errorPreview = tc.isError ? previewResult(tc.result) : undefined;
          const family = inferToolFamily(tc.toolName);
          return (
            <details key={tc.id} className="tool-calls-row">
              <summary
                className="tool-calls-row-name"
                title={showRawName ? tc.toolName : undefined}
              >
                {displayName}
                <span
                  className={`tool-source-chip tool-source-${family}`}
                  role="img"
                  aria-label={`tool source: ${familyLabel(family)}`}
                >
                  {familyLabel(family)}
                </span>
                {isRunning ? (
                  <span className="tool-calls-running-dot" role="img" aria-label="running" />
                ) : null}
                {tc.isError ? (
                  <span className="tool-calls-error-badge" title={errorPreview}>
                    failed
                  </span>
                ) : null}
              </summary>
              <pre className="tool-calls-args">
                {tc.toolInput ? JSON.stringify(tc.toolInput, null, 2) : "(no args)"}
              </pre>
              {tc.result !== undefined ? (
                <pre
                  className={
                    tc.isError ? "tool-calls-result tool-calls-result-error" : "tool-calls-result"
                  }
                >
                  {tc.result}
                </pre>
              ) : null}
            </details>
          );
        })}
      </div>
    </details>
  );
}
