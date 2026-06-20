import { describe, expect, it } from "bun:test";
import { buildCopilotSessionHooks } from "../src/copilot/hooks-shim.ts";
import { buildPermissionGate } from "../src/copilot/permission-gate.ts";
import { capabilityToolName, GATED_KINDS, toolKind } from "../src/copilot/tool-names.ts";
import type { ToolCallGate } from "../src/types.ts";

// approveAll stand-in matching the SDK's `() => ({ kind: "approve-once" })`.
const approveAll = () => ({ kind: "approve-once" }) as const;
const decisionKind = (r: unknown): string | undefined =>
  r && typeof r === "object" ? ((r as Record<string, unknown>).kind as string) : undefined;

// Records the tool names a gate is asked about, returning a fixed decision.
function recordingGate(decision: { outcome: "allow" } | { outcome: "deny"; reason: string }): {
  gate: ToolCallGate;
  calls: Array<{ tool: string }>;
} {
  const calls: Array<{ tool: string }> = [];
  const gate: ToolCallGate = async (call) => {
    calls.push({ tool: call.tool });
    return decision;
  };
  return { gate, calls };
}

describe("toolKind", () => {
  it("maps Claude tool names to capability kinds", () => {
    expect(toolKind("Read")).toBe("read");
    expect(toolKind("Glob")).toBe("read");
    expect(toolKind("Grep")).toBe("read");
    expect(toolKind("Write")).toBe("write");
    expect(toolKind("Edit")).toBe("write");
    expect(toolKind("MultiEdit")).toBe("write");
    expect(toolKind("Bash")).toBe("shell");
    expect(toolKind("WebFetch")).toBe("url");
  });

  it("maps Copilot built-in tool names to the same kinds", () => {
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("file_search")).toBe("read");
    expect(toolKind("grep_search")).toBe("read");
    expect(toolKind("str_replace_editor")).toBe("write");
    expect(toolKind("apply_patch")).toBe("write");
    expect(toolKind("create")).toBe("write");
    expect(toolKind("bash")).toBe("shell");
  });

  it("maps memory tool names to the memory kind", () => {
    expect(toolKind("memory")).toBe("memory");
    expect(toolKind("store_memory")).toBe("memory");
    expect(toolKind("update_memory")).toBe("memory");
  });

  it("returns undefined for unknown / rib tool names", () => {
    expect(toolKind("osdu_list_partitions")).toBeUndefined();
    expect(toolKind("cluster")).toBeUndefined();
  });

  it("GATED_KINDS covers built-in capabilities but not custom-tool/mcp/hook", () => {
    expect(GATED_KINDS.has("read")).toBe(true);
    expect(GATED_KINDS.has("write")).toBe(true);
    expect(GATED_KINDS.has("shell")).toBe(true);
    expect(GATED_KINDS.has("custom-tool")).toBe(false);
    expect(GATED_KINDS.has("mcp")).toBe(false);
  });
});

describe("buildPermissionGate", () => {
  it("allowed_tools: [Read, Glob, Grep] permits read, denies write/shell", () => {
    const gate = buildPermissionGate({ approveAll, allowedTools: ["Read", "Glob", "Grep"] });
    expect(decisionKind(gate({ kind: "read" }, { sessionId: "s" }))).toBe("approve-once");
    expect(decisionKind(gate({ kind: "write" }, { sessionId: "s" }))).toBe("reject");
    expect(decisionKind(gate({ kind: "shell" }, { sessionId: "s" }))).toBe("reject");
    expect(decisionKind(gate({ kind: "url" }, { sessionId: "s" }))).toBe("reject");
  });

  it("denied_tools: [Write] denies write, permits read/shell", () => {
    const gate = buildPermissionGate({ approveAll, disallowedTools: ["Write"] });
    expect(decisionKind(gate({ kind: "write" }, { sessionId: "s" }))).toBe("reject");
    expect(decisionKind(gate({ kind: "read" }, { sessionId: "s" }))).toBe("approve-once");
    expect(decisionKind(gate({ kind: "shell" }, { sessionId: "s" }))).toBe("approve-once");
  });

  it("denied_tools: [store_memory] blocks the memory permission kind", () => {
    const gate = buildPermissionGate({ approveAll, disallowedTools: ["store_memory"] });
    expect(decisionKind(gate({ kind: "memory" }, { sessionId: "s" }))).toBe("reject");
    expect(decisionKind(gate({ kind: "read" }, { sessionId: "s" }))).toBe("approve-once");
  });

  it("custom-tool / mcp / hook requests always pass through (gated upstream)", () => {
    const gate = buildPermissionGate({ approveAll, allowedTools: ["Read"] });
    expect(decisionKind(gate({ kind: "custom-tool" }, { sessionId: "s" }))).toBe("approve-once");
    expect(decisionKind(gate({ kind: "mcp" }, { sessionId: "s" }))).toBe("approve-once");
    expect(decisionKind(gate({ kind: "hook" }, { sessionId: "s" }))).toBe("approve-once");
  });

  it("allowlist of only rib tools fail-closes every built-in capability", () => {
    const gate = buildPermissionGate({ approveAll, allowedTools: ["osdu_read"] });
    expect(decisionKind(gate({ kind: "read" }, { sessionId: "s" }))).toBe("reject");
    expect(decisionKind(gate({ kind: "write" }, { sessionId: "s" }))).toBe("reject");
    // the rib tool itself still flows through as custom-tool
    expect(decisionKind(gate({ kind: "custom-tool" }, { sessionId: "s" }))).toBe("approve-once");
  });
});

describe("capabilityToolName", () => {
  it("maps each gated kind to its canonical engine tool name", () => {
    expect(capabilityToolName("shell")).toBe("Bash");
    expect(capabilityToolName("write")).toBe("Write");
    expect(capabilityToolName("read")).toBe("Read");
    expect(capabilityToolName("url")).toBe("WebFetch");
    expect(capabilityToolName("memory")).toBe("Memory");
  });
});

describe("buildPermissionGate — policy engine gate", () => {
  it("an engine ALLOW defers to the SDK consent prompt (approveAll)", async () => {
    const { gate, calls } = recordingGate({ outcome: "allow" });
    const handler = buildPermissionGate({ approveAll, evaluateToolCall: gate });
    expect(decisionKind(await handler({ kind: "shell" }, { sessionId: "s" }))).toBe("approve-once");
    // The engine was consulted with the capability's canonical name.
    expect(calls).toEqual([{ tool: "Bash" }]);
  });

  it("an engine DENY rejects the request with the policy reason", async () => {
    const { gate } = recordingGate({ outcome: "deny", reason: "approval rejected: confirm" });
    const handler = buildPermissionGate({ approveAll, evaluateToolCall: gate });
    const decision = await handler({ kind: "write" }, { sessionId: "s" });
    expect(decisionKind(decision)).toBe("reject");
    expect((decision as { feedback: string }).feedback).toContain("approval rejected");
  });

  it("evaluates each gated kind under its canonical tool name", async () => {
    const { gate, calls } = recordingGate({ outcome: "allow" });
    const handler = buildPermissionGate({ approveAll, evaluateToolCall: gate });
    for (const kind of ["read", "write", "shell", "url", "memory"] as const) {
      await handler({ kind }, { sessionId: "s" });
    }
    expect(calls.map((c) => c.tool)).toEqual(["Read", "Write", "Bash", "WebFetch", "Memory"]);
  });

  it("non-capability kinds (custom-tool/mcp/hook) never reach the engine", async () => {
    const { gate, calls } = recordingGate({ outcome: "deny", reason: "should not run" });
    const handler = buildPermissionGate({ approveAll, evaluateToolCall: gate });
    expect(decisionKind(await handler({ kind: "custom-tool" }, { sessionId: "s" }))).toBe(
      "approve-once",
    );
    expect(decisionKind(await handler({ kind: "mcp" }, { sessionId: "s" }))).toBe("approve-once");
    expect(calls).toEqual([]);
  });

  it("a rail deny short-circuits before the engine is consulted", async () => {
    const { gate, calls } = recordingGate({ outcome: "allow" });
    const handler = buildPermissionGate({
      approveAll,
      disallowedTools: ["Bash"],
      evaluateToolCall: gate,
    });
    expect(decisionKind(await handler({ kind: "shell" }, { sessionId: "s" }))).toBe("reject");
    expect(calls).toEqual([]); // rail rejected before reaching the engine
  });

  it("a capability that clears the rail can still be denied by the engine", async () => {
    const { gate } = recordingGate({ outcome: "deny", reason: "denylisted by operator floor" });
    const handler = buildPermissionGate({
      approveAll,
      allowedTools: ["Bash"], // rail permits shell
      evaluateToolCall: gate,
    });
    expect(decisionKind(await handler({ kind: "shell" }, { sessionId: "s" }))).toBe("reject");
  });

  it("a thrown gate fails open (allow) so an engine fault can't wedge the turn", async () => {
    const gate: ToolCallGate = async () => {
      throw new Error("engine down");
    };
    const handler = buildPermissionGate({ approveAll, evaluateToolCall: gate });
    expect(decisionKind(await handler({ kind: "shell" }, { sessionId: "s" }))).toBe("approve-once");
  });

  it("stays synchronous (no engine) on the rail-only path", () => {
    const handler = buildPermissionGate({ approveAll, allowedTools: ["Read"] });
    // No await: the rail-only handler returns a decision object, not a promise.
    const decision = handler({ kind: "read" }, { sessionId: "s" });
    expect(decision).not.toBeInstanceOf(Promise);
    expect(decisionKind(decision)).toBe("approve-once");
  });
});

describe("buildCopilotSessionHooks", () => {
  it("returns undefined when no Pre/PostToolUse matchers are present", () => {
    expect(buildCopilotSessionHooks({})).toBeUndefined();
    expect(buildCopilotSessionHooks({ SessionStart: [{ response: {} }] })).toBeUndefined();
  });

  it("PreToolUse deny matcher denies the matched tool by capability kind", () => {
    const hooks = buildCopilotSessionHooks({
      PreToolUse: [{ matcher: "Bash", response: { decision: "block" } }],
    });
    // matcher "Bash" (shell) matches copilot's "bash" (shell)
    expect(hooks?.onPreToolUse?.({ toolName: "bash" })?.permissionDecision).toBe("deny");
    // non-shell tool is unaffected
    expect(hooks?.onPreToolUse?.({ toolName: "read_file" })).toBeUndefined();
  });

  it("PostToolUse injects additionalContext from the Claude hookSpecificOutput shape", () => {
    const hooks = buildCopilotSessionHooks({
      PostToolUse: [
        {
          matcher: "Read",
          response: { hookSpecificOutput: { additionalContext: "assess the file" } },
        },
      ],
    });
    // matcher "Read" matches copilot "read_file" / "view" via the read kind
    expect(hooks?.onPostToolUse?.({ toolName: "read_file" })?.additionalContext).toBe(
      "assess the file",
    );
    expect(hooks?.onPostToolUse?.({ toolName: "bash" })).toBeUndefined();
  });

  it("matches Claude-style alternation matchers (Write|Edit) by capability kind", () => {
    // Workflow nodes use `matcher: "Write|Edit"` (Claude-style) — must gate
    // Copilot's write built-ins (str_replace_editor / create / apply_patch),
    // not silently skip.
    const hooks = buildCopilotSessionHooks({
      PreToolUse: [{ matcher: "Write|Edit", response: { decision: "block" } }],
    });
    expect(hooks?.onPreToolUse?.({ toolName: "str_replace_editor" })?.permissionDecision).toBe(
      "deny",
    );
    expect(hooks?.onPreToolUse?.({ toolName: "create" })?.permissionDecision).toBe("deny");
    expect(hooks?.onPreToolUse?.({ toolName: "apply_patch" })?.permissionDecision).toBe("deny");
    // a read tool is NOT caught by a write|edit matcher
    expect(hooks?.onPreToolUse?.({ toolName: "read_file" })).toBeUndefined();
  });

  it("treats a str_replace_editor view as a read, not a write, for hook matching", () => {
    const writeHook = buildCopilotSessionHooks({
      PreToolUse: [{ matcher: "Write|Edit", response: { decision: "block" } }],
    });
    const readHook = buildCopilotSessionHooks({
      PostToolUse: [{ matcher: "Read", response: { additionalContext: "assess" } }],
    });
    const viewInput = { toolName: "str_replace_editor", toolArgs: { command: "view" } };
    const editInput = { toolName: "str_replace_editor", toolArgs: { command: "str_replace" } };
    // A view must NOT trip the write/edit deny hook...
    expect(writeHook?.onPreToolUse?.(viewInput)).toBeUndefined();
    // ...but a real edit must.
    expect(writeHook?.onPreToolUse?.(editInput)?.permissionDecision).toBe("deny");
    // A Read hook fires on the view.
    expect(readHook?.onPostToolUse?.(viewInput)?.additionalContext).toBe("assess");
  });

  it("maps a Claude systemMessage response onto Copilot additionalContext", () => {
    // Workflow write/fix hooks carry `response: { systemMessage: ... }`.
    const hooks = buildCopilotSessionHooks({
      PreToolUse: [{ matcher: "Write|Edit", response: { systemMessage: "stay in scope" } }],
    });
    expect(hooks?.onPreToolUse?.({ toolName: "str_replace_editor" })?.additionalContext).toBe(
      "stay in scope",
    );
  });

  it("matches a regex matcher against the raw tool name when it isn't a known tool", () => {
    const hooks = buildCopilotSessionHooks({
      PostToolUse: [{ matcher: "^custom_.*", response: { additionalContext: "hi" } }],
    });
    expect(hooks?.onPostToolUse?.({ toolName: "custom_thing" })?.additionalContext).toBe("hi");
    expect(hooks?.onPostToolUse?.({ toolName: "read_file" })).toBeUndefined();
  });
});
