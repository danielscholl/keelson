// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// CONTRACT LAYER — no Zod imports, no SDK imports.
// MessageChunk is the Zod-inferred type from @keelson/shared/chat.
// This file must never import runtime dependencies.

import type {
  MessageChunk,
  ModelInfo,
  ProviderCapabilities,
  ToolDefinition,
} from "@keelson/shared";

// `ToolDefinition` / `ToolContext` live in `@keelson/shared` because
// `inputSchema: z.ZodTypeAny` requires a zod runtime type; re-exported here
// so existing import paths keep working.
export type { MessageChunk, ModelInfo, ProviderCapabilities, ToolDefinition };

// Minimal stdio MCP shape accepted on SessionConfig.mcpServers by both SDKs.
export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "stdio";
}

// Per-call, args-aware tool-call gate. The server binds {surface, ribId,
// provider} and hands each provider a thunk it invokes inside its custom-tool
// handler (Claude / Copilot / pi) BEFORE the tool runs; a `deny` short-circuits
// with an error tool_result instead of executing. Providers that project no
// keelson tools (codex) never call it, and built-in SDK tools — which run
// outside our handler — are out of scope. The decision is @keelson/shared's
// PolicyDecision narrowed to the allow/deny the engine emits here (`ask`
// degrades to `deny` until the approval round-trip lands), so providers never
// have to handle an `ask`.
export type ToolCallGate = (call: {
  tool: string;
  args?: unknown;
}) => Promise<{ outcome: "allow" } | { outcome: "deny"; reason: string }>;

// Per-result tool-result gate. The server binds {surface, ribId, provider} and
// hands each provider a thunk it invokes inside its custom-tool handler AFTER
// `execute` returns but BEFORE the result reaches the model. A `deny` replaces
// the model-facing result with the reason; an `allow` carrying a string `data`
// substitutes that text (redaction). Built-in SDK tools run outside the handler
// and are out of scope, like ToolCallGate. The decision is @keelson/shared's
// PolicyDecision narrowed to what the result phase emits — `data` is the
// already-stringified substitution (the engine drops non-string substitutions),
// and an `ask` has degraded to `deny` (no round-trip for a result that already
// ran), so providers never have to handle one.
export type ToolResultGate = (result: {
  tool: string;
  result: unknown;
}) => Promise<{ outcome: "allow"; data?: string } | { outcome: "deny"; reason: string }>;

export interface SendQueryOptions {
  model?: string;
  abortSignal?: AbortSignal;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  mcpServers?: MCPServerConfig[];
  env?: Record<string, string>;
  // Provider-neutral: Claude consumes this; others ignore. Undefined leaves
  // the SDK default in place.
  thinking?: boolean;
  // Provider-neutral: Copilot consumes this on reasoning models; others
  // ignore. Inline literal — this contract layer is zod-runtime-free.
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  // SDK-level tool whitelist (built-ins + MCP). Distinct from `tools` above,
  // which carries our MCP ToolDefinition objects to project. Claude gates by
  // name; Copilot gates the built-in capability the names map to (read / write
  // / shell / …) via its permission handler. Empty array = no tools.
  allowedTools?: string[];
  // SDK-level tool blacklist (built-ins + MCP). Applied on top of `allowedTools`
  // when both are set, matching upstream Archon's semantics.
  disallowedTools?: string[];
  // Confinement roots — Claude maps this to `additionalDirectories` and drops
  // `bypassPermissions`; other providers ignore it. Absent means no provider-
  // level confinement, preserving the current passthrough behavior.
  allowedDirectories?: readonly string[];
  // Unfiltered registered-MCP tool name set. The Claude provider needs this
  // to detect MCP names when the user lists a globally-denied tool in
  // `allowed_tools` (which the prompt handler has already removed from the
  // MCP projection) — without this, the factory would mis-treat the name
  // as a built-in and pass it through Options.tools where the SDK rejects
  // it. The prompt handler passes the FULL registry, not the filtered set.
  registeredMcpToolNames?: readonly string[];
  // Invoked once per turn when the provider's backend session id becomes
  // known (Copilot: on session create/resume; Claude: first SDK message
  // carrying one). The chat handler persists it so the NEXT turn resumes the
  // same session — the only way multi-turn context survives for providers
  // that keep history server-side rather than replaying it in the prompt.
  // Providers that have no resumable session simply never call it.
  onSessionId?: (sessionId: string) => void;
  // Per-node hook matchers in the vendored workflowNodeHooksSchema shape:
  // `Record<eventName, Array<{matcher?, response, timeout?}>>`. Loose
  // structural typing so this contract layer stays free of a runtime
  // dependency on `@keelson/workflows`. Claude honors all events; Copilot
  // honors PreToolUse / PostToolUse (the rest stay claude-only).
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      response: Record<string, unknown>;
      timeout?: number;
    }>
  >;
  // See ToolCallGate. Absent → no per-call gating (back-compat passthrough).
  evaluateToolCall?: ToolCallGate;
  // See ToolResultGate. Absent → tool results pass through unchanged. Wired by
  // the server only when a policy actually consumes the `tool_result` phase, so
  // the default path runs no per-result evaluation.
  evaluateToolResult?: ToolResultGate;
}

export interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk>;

  getType(): string;

  getCapabilities(): ProviderCapabilities;

  // MUST NEVER throw — fall back to a bare-id projection of
  // `capabilities.models` so the picker never empties out.
  listModels(): Promise<ModelInfo[]>;

  // Release any process-lifetime resources (warm subprocesses, in-flight
  // teardowns). Drained by the registry's disposeAllProviders() during server
  // shutdown / CLI exit. Optional: stateless per-turn providers omit it.
  dispose?(): Promise<void>;
}

export interface ProviderRegistration {
  id: string;
  displayName: string;
  factory: () => IAgentProvider;
  capabilities: ProviderCapabilities;
  builtIn: boolean;
  // Optional keyring handle; not unique across providers.
  credentialServiceId?: string;
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  builtIn: boolean;
  credentialServiceId?: string;
}
