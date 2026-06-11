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
