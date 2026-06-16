// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Owns SDK module load + query construction so sendQuery has one failure
// point. Structural types keep this file free of a typeof-import on the SDK,
// so tests can pass any compatible shape via sdkLoader.

import type { ToolContext } from "@keelson/shared";
import { ensureSpawnPath } from "@keelson/shared/exec";
import { checkToolCallGate } from "../tool-gate.ts";
import type { MessageChunk, ToolCallGate, ToolDefinition } from "../types.ts";
import { buildSDKHooksFromYAML, mergeSDKHooks, type YAMLHookMatcher } from "./hooks-projection.ts";

// A copy of the ambient env with ANTHROPIC_API_KEY removed. The Claude CLI/SDK
// prefers an explicit ANTHROPIC_API_KEY over its stored OAuth login, so stripping
// it from just the spawned process's env is what makes keelson reach the user's
// Pro/Max subscription without them having to unset the key globally.
function envWithoutAnthropicKey(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_API_KEY" || v === undefined) continue;
    env[k] = v;
  }
  return ensureSpawnPath(env);
}

// Single source of truth for the MCP server name we register our skill
// catalog under (see options.mcpServers below). The SDK exposes registered
// MCP tools to the model as `mcp__<serverName>__<toolName>`, so workflow
// authors who write `allowed_tools: [some_tool]` need that name expanded
// to match the SDK's actual tool identifier.
const MCP_SERVER_NAME = "keelson";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Expand a per-node allow/deny tool list so the SDK's allowlist matches
// both bare names (SDK built-ins like Read/Bash) and our MCP-wrapped names
// (registered skills exposed under `mcp__<server>__<name>`). Already-wrapped
// names pass through unchanged.
function expandToolNamesForClaudeSdk(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    out.push(name);
    if (!name.startsWith("mcp__")) out.push(`${MCP_TOOL_PREFIX}${name}`);
  }
  return out;
}

// Structural projection of the Anthropic BetaUsage block, snake_case as the
// SDK ships it. Carried on each assistant message (that API call's usage)
// and on the result message (turn totals summed across calls).
export interface ClaudeApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// `type` is the discriminator: system | stream_event | assistant |
// user/user_replay | result, plus forward-looking events we ignore.
export interface ClaudeSdkMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  is_error?: boolean;
  error?: string;
  // Detail strings from SDKResultError — passed to buildFriendlyClaudeError
  // so the user sees the cause, not just the subtype.
  errors?: string[];
  // Set on assistant messages emitted by Task subagents; null/absent for the
  // root agent's own messages.
  parent_tool_use_id?: string | null;
  message?: { content?: ClaudeContentBlock[]; usage?: ClaudeApiUsage };
  // Turn-total usage on `result` messages (SDKResultSuccess / SDKResultError).
  usage?: ClaudeApiUsage;
  // Per-model breakdown on `result` messages; read for contextWindow only.
  modelUsage?: Record<string, { contextWindow?: number } | undefined>;
  // BetaRawMessageStreamEvent; we read content_block_delta for text_delta
  // (text) and thinking_delta (thinking).
  event?: {
    type: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
}

// Content block on a full assistant or user message. Text blocks are no-ops
// (deltas already streamed); tool_use → tool_use chunk; tool_result (user
// message, SDK-injected after our handler returns) → tool_result chunk.
export interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  // References the originating assistant tool_use block id.
  tool_use_id?: string;
  // ToolResultBlockParam.content is `string | Array<TextBlockParam | ...>`;
  // we only handle the string and text-block-array cases.
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface ClaudeQueryHandle extends AsyncIterable<ClaudeSdkMessage> {
  interrupt?: () => Promise<void>;
}

// Subset of SDK ThinkingConfig — only adaptive + disabled are driven from here.
export type ClaudeThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "disabled" }
  | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" };

// Subset of SDK Options the provider actually drives.
export interface ClaudeQueryOptions {
  cwd?: string;
  model?: string;
  resume?: string;
  includePartialMessages?: boolean;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  systemPrompt?: string;
  // SDK `PermissionMode`: 'default' | 'acceptEdits' | 'bypassPermissions' |
  // 'plan' | 'dontAsk'. Loose-typed here to avoid an SDK type import.
  permissionMode?: string;
  // Without this flag, subagent text/thinking blocks (parent_tool_use_id set)
  // get dropped by the SDK and never surface to the user.
  forwardSubagentText?: boolean;
  // Per-turn override of SDK default thinking mode.
  thinking?: ClaudeThinkingConfig;
  // SDK accepts Record<name, McpServerConfig>; we ship a single entry
  // ("keelson") whose `instance` comes from createSdkMcpServer.
  mcpServers?: Record<string, unknown>;
  // SDK `tools` is the built-in catalog gate — string[] removes any built-in
  // tool not listed from the model's context; [] disables all built-ins;
  // undefined preserves the SDK's full built-in catalog. Distinct from
  // `allowedTools` below, which is the permission auto-allow list and does
  // NOT restrict the catalog under `bypassPermissions`.
  tools?: string[];
  // SDK permission auto-allow / -deny lists. Empty `allowedTools` array
  // means the model has no auto-approved tools; undefined leaves the SDK
  // default in place. Under `bypassPermissions`, allowedTools is a hint
  // and `tools` above is the load-bearing gate.
  allowedTools?: string[];
  disallowedTools?: string[];
  // SDK hook matchers — `Record<event, HookCallbackMatcher[]>`. We pass the
  // post-projection shape from `buildSDKHooksFromYAML` verbatim and the SDK
  // interprets each matcher's hook return value per its hook protocol.
  hooks?: Record<string, unknown>;
}

// Structural projection of SdkMcpToolDefinition; `inputSchema` stays unknown
// so a future swap to the SDK's `tool()` factory doesn't ripple here.
export interface ClaudeSdkToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (args: unknown, extra: unknown) => Promise<ClaudeCallToolResult>;
}

export interface ClaudeCallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ClaudeSdkModule {
  query(args: { prompt: string; options?: ClaudeQueryOptions }): ClaudeQueryHandle;
  // Optional so mock SDKs in tests don't have to implement it.
  createSdkMcpServer?: (options: {
    name: string;
    version?: string;
    tools?: ClaudeSdkToolDefinition[];
  }) => unknown;
}

export type ClaudeSdkLoader = () => Promise<ClaudeSdkModule>;

const defaultSdkLoader: ClaudeSdkLoader = () =>
  import("@anthropic-ai/claude-agent-sdk") as unknown as Promise<ClaudeSdkModule>;

export interface ClaudeQueryFactoryOptions {
  sdkLoader?: ClaudeSdkLoader;
}

// `contextFactory` is nullary because the Claude SDK owns the tool_use ↔
// tool_result id pairing (next user message carries tool_use_id verbatim).
// Copilot's equivalent threads the SDK's toolCallId because its event-driven
// path needs to rewrite outbound chunk ids.
export interface ClaudeToolProjectionContext {
  pushChunk: (chunk: MessageChunk) => void;
  contextFactory: () => ToolContext;
  // Per-call policy gate (server-wired). When present, each MCP/skill tool call
  // is evaluated WITH its validated args before execute and a deny returns an
  // error tool_result. Built-in SDK tools run in the CLI subprocess and never
  // reach this handler, so they are out of this gate's scope.
  evaluateToolCall?: ToolCallGate;
}

export interface CreateQueryParams {
  token: string | undefined;
  // When true, spawn the SDK with ANTHROPIC_API_KEY stripped from its env so the
  // turn bills against the Claude subscription (OAuth) login, not an API key.
  preferSubscription?: boolean;
  cwd: string;
  prompt: string;
  sessionId?: string;
  abortController: AbortController;
  model?: string;
  systemPrompt?: string;
  // Boolean here, translated to SDK ThinkingConfig in createQuery.
  thinking?: boolean;
  tools?: ToolDefinition[];
  toolProjection?: ClaudeToolProjectionContext;
  // SDK-level allow / deny lists by tool name (built-ins + MCP). Forwarded
  // verbatim to ClaudeQueryOptions; the SDK enforces the gate.
  allowedTools?: string[];
  disallowedTools?: string[];
  // Unfiltered registered-MCP tool name set (see SendQueryOptions for why
  // this is separate from the post-filter `tools` field above).
  registeredMcpToolNames?: readonly string[];
  // Per-node YAML hook matchers. Projected into SDK matcher shape by
  // `buildSDKHooksFromYAML` inside createQuery() and merged with any
  // built-in capture hooks before reaching the SDK.
  hooks?: Readonly<
    Record<
      string,
      Array<{
        matcher?: string;
        response: Record<string, unknown>;
        timeout?: number;
      }>
    >
  >;
}

// We do NOT emit a tool_result chunk from this handler — at this point the
// SDK-assigned id isn't known, and a synthetic id would orphan the row on
// reload. The SDK emits the canonical tool_result block as a `user` message
// (see `mapSdkMessageToChunks` in provider.ts).
//
// `inputSchema` is the ZodObject `.shape` (raw field record) — that's the
// AnyZodRawShape the SDK's createSdkMcpServer expects. Non-object schemas
// fall back to an empty shape, which advertises a zero-arg tool to the
// model and would prevent any required-arg skill from receiving args.
export function projectToolsForClaude(
  tools: ToolDefinition[],
  projection: ClaudeToolProjectionContext,
): ClaudeSdkToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: extractZodObjectShape(tool.inputSchema),
    handler: async (rawArgs: unknown, _extra: unknown): Promise<ClaudeCallToolResult> => {
      const ctx = projection.contextFactory();
      const { content, isError } = await runClaudeToolHandler(
        tool,
        rawArgs,
        ctx,
        projection.evaluateToolCall,
      );
      return isError
        ? { content: [{ type: "text", text: content }], isError: true }
        : { content: [{ type: "text", text: content }] };
    },
  }));
}

// SDK expects AnyZodRawShape (`{ key: ZodType }`), NOT a full z.object().
// Duck-typed via `_def.type === "object"` + `.shape` to keep this file
// zod-runtime-free. Non-object schemas fall back to an empty shape.
function extractZodObjectShape(schema: ToolDefinition["inputSchema"]): Record<string, unknown> {
  const def = (schema as { _def?: { type?: string } })._def;
  if (def?.type !== "object") return {};
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof shape !== "object") return {};
  return shape;
}

async function runClaudeToolHandler(
  tool: ToolDefinition,
  rawArgs: unknown,
  ctxIn: ToolContext,
  gate?: ToolCallGate,
): Promise<{ content: string; isError: boolean }> {
  // tool_result chunks from the skill are captured here but NOT forwarded —
  // the SDK emits the canonical block via the next user message (which
  // provider.ts maps). Other chunks pass through as in-progress signals.
  let resultContent: string | null = null;
  let resultIsError = false;
  const ctx: ToolContext = {
    cwd: ctxIn.cwd,
    abortSignal: ctxIn.abortSignal,
    emit: (chunk) => {
      if (chunk.type === "tool_result") {
        resultContent = chunk.content;
        if (chunk.isError) resultIsError = true;
        return;
      }
      ctxIn.emit(chunk);
    },
  };

  const parsed = tool.inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const message = `Invalid input for tool '${tool.name}': ${parsed.error.message}`;
    return { content: message, isError: true };
  }

  // Per-call policy gate, after validation so a policy sees normalized args.
  const gateResult = await checkToolCallGate(gate, tool.name, parsed.data);
  if (gateResult.denied) {
    return { content: gateResult.message, isError: true };
  }

  try {
    await tool.execute(parsed.data, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: message, isError: true };
  }

  if (resultContent === null) {
    return { content: "", isError: false };
  }
  return { content: resultContent, isError: resultIsError };
}

// Shells out to `claude auth status --json` because the SDK doesn't expose a
// programmatic getAuthStatus equivalent (only an in-query SDKAuthStatusMessage).
// Errors fold into the result shape so callers never have to try/catch.
export interface ClaudeCliAuthResult {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  // "max" / "pro" / … when the active login is a Claude subscription; absent for
  // an API-key login. Drives the "auto" auth mode's subscription detection.
  subscriptionType?: string;
  error?: string;
}

// Pluggable so tests can inject a stub. `env`, when passed, replaces the child's
// environment (the subscription probe hands an ANTHROPIC_API_KEY-stripped env so
// `claude auth status` reports the OAuth login rather than the api-key view).
export type ClaudeCliRunner = (env?: Record<string, string>) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

const defaultClaudeCliRunner: ClaudeCliRunner = async (env) => {
  // Omit env to inherit implicitly: handing Bun.spawn an explicit env bypasses
  // its case-insensitive PATH lookup on Windows (search path exposed as `Path`)
  // and `claude` fails ENOENT. The subscription probe passes an explicit env
  // already normalized through ensureSpawnPath.
  const proc = Bun.spawn(["claude", "auth", "status", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

export class ClaudeQueryFactory {
  private readonly loadSdk: ClaudeSdkLoader;
  private readonly cliRunner: ClaudeCliRunner;
  // Memoizes the per-process subscription probe so the "auto" auth mode pays the
  // `claude auth status` spawn once, not once per turn.
  private subscriptionProbe: Promise<boolean> | null = null;

  constructor(options: ClaudeQueryFactoryOptions & { cliRunner?: ClaudeCliRunner } = {}) {
    this.loadSdk = options.sdkLoader ?? defaultSdkLoader;
    this.cliRunner = options.cliRunner ?? defaultClaudeCliRunner;
  }

  // Status against the ambient env (api-key view when ANTHROPIC_API_KEY is set).
  // Normalized result regardless of failure mode.
  checkAuthStatus(): Promise<ClaudeCliAuthResult> {
    return this.runAuthStatus();
  }

  // True when a Pro/Max subscription login is usable. Probed with the API key
  // stripped so the CLI reports the OAuth login rather than the api-key view;
  // any failure (CLI missing, not logged in, parse error) resolves false so the
  // caller falls back to the API key. Memoized per process.
  detectSubscription(): Promise<boolean> {
    this.subscriptionProbe ??= (async () => {
      const res = await this.runAuthStatus(envWithoutAnthropicKey());
      return res.loggedIn && res.subscriptionType !== undefined;
    })();
    return this.subscriptionProbe;
  }

  private async runAuthStatus(env?: Record<string, string>): Promise<ClaudeCliAuthResult> {
    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await this.cliRunner(env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { loggedIn: false, error: msg };
    }
    if (result.exitCode !== 0) {
      const msg = result.stderr.trim() || `claude auth status exited ${result.exitCode}`;
      return { loggedIn: false, error: msg };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { loggedIn: false, error: `parse failed: ${msg}` };
    }
    if (!parsed || typeof parsed !== "object") {
      return { loggedIn: false, error: "unexpected CLI output" };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      loggedIn: obj.loggedIn === true,
      ...(typeof obj.authMethod === "string" ? { authMethod: obj.authMethod } : {}),
      ...(typeof obj.email === "string" ? { email: obj.email } : {}),
      ...(typeof obj.orgName === "string" ? { orgName: obj.orgName } : {}),
      ...(typeof obj.subscriptionType === "string"
        ? { subscriptionType: obj.subscriptionType }
        : {}),
    };
  }

  // Provider drains the iterable; we do NOT await it here — query() doesn't
  // block, iteration starts the CLI subprocess and work happens during
  // for-await consumption.
  async createQuery(params: CreateQueryParams): Promise<ClaudeQueryHandle> {
    const sdk = await this.loadSdk();
    const options: ClaudeQueryOptions = {
      cwd: params.cwd,
      includePartialMessages: true,
      forwardSubagentText: true,
      // No interactive permission UI yet; tools gate at the capability level.
      permissionMode: "bypassPermissions",
      abortController: params.abortController,
    };
    if (params.model !== undefined) options.model = params.model;
    if (params.sessionId !== undefined) options.resume = params.sessionId;
    if (params.systemPrompt !== undefined) options.systemPrompt = params.systemPrompt;
    // Undefined leaves the SDK default in place.
    if (params.thinking === false) {
      options.thinking = { type: "disabled" };
    } else if (params.thinking === true) {
      options.thinking = { type: "adaptive", display: "summarized" };
    }
    // `allowedTools: []` is meaningful (forbids every tool), so check
    // explicitly for undefined rather than truthy.
    //
    // Two SDK fields cooperate here:
    //   - `options.tools` is the built-in catalog gate — it removes any
    //     built-in tool not listed from the model's context. This is what
    //     makes `allowed_tools: [Read]` actually restrict the model to Read
    //     under `bypassPermissions`. The SDK forwards `tools` as `--tools`
    //     to the CLI, which rejects unknown names; only pass bare names
    //     that look like SDK built-ins (no `mcp__` prefix and not in our
    //     registered MCP catalog). MCP tools are filtered separately at
    //     the prompt handler and registered via `mcpServers` below.
    //   - `options.allowedTools` is the permission auto-allow list and
    //     under `bypassPermissions` is a hint, not a gate. Expand each
    //     bare name to include the MCP-wrapped form so the hint also
    //     covers our registered skills (`mcp__keelson__<tool_name>`).
    if (params.allowedTools !== undefined) {
      // Detect MCP names by the unfiltered registry — NOT params.tools.
      // params.tools is post-filter (denylist already applied), so a
      // globally-denied MCP tool wouldn't be in it and we'd mis-treat its
      // name as a built-in. `registeredMcpToolNames` is the full catalog
      // before filtering and is the canonical source of truth for "is this
      // an MCP name we know about".
      const mcpNames = new Set(params.registeredMcpToolNames ?? []);
      for (const t of params.tools ?? []) mcpNames.add(t.name);
      const isMcpName = (n: string): boolean => n.startsWith("mcp__") || mcpNames.has(n);
      options.tools = params.allowedTools.filter((n) => !isMcpName(n));
      options.allowedTools = expandToolNamesForClaudeSdk(params.allowedTools);
    }
    if (params.disallowedTools !== undefined) {
      options.disallowedTools = expandToolNamesForClaudeSdk(params.disallowedTools);
    }
    // Project per-node YAML hooks → SDK matcher shape. mergeSDKHooks is the
    // forward-compat seam for built-in capture hooks (none today — passing
    // undefined keeps user hooks unmerged).
    if (params.hooks !== undefined) {
      const userHooks = buildSDKHooksFromYAML(
        params.hooks as Readonly<Record<string, YAMLHookMatcher[] | undefined>>,
      );
      const merged = mergeSDKHooks(userHooks, undefined);
      if (merged !== undefined && Object.keys(merged).length > 0) {
        options.hooks = merged;
      }
    }
    // Tool path stays a no-op when the SDK doesn't expose createSdkMcpServer
    // (e.g. structural mocks in tests without explicit wiring).
    if (
      params.tools &&
      params.tools.length > 0 &&
      params.toolProjection &&
      typeof sdk.createSdkMcpServer === "function"
    ) {
      const toolDefs = projectToolsForClaude(params.tools, params.toolProjection);
      const serverInstance = sdk.createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: "0.0.0",
        tools: toolDefs,
      });
      options.mcpServers = { [MCP_SERVER_NAME]: serverInstance };
    }
    // Subscription route: hand the SDK a full env with ANTHROPIC_API_KEY removed
    // so the spawned `claude` uses its OAuth (Pro/Max) login — no need for the
    // operator to unset the key globally. Otherwise a saved keelson token injects
    // the key, and absent that, omitting env inherits the ambient credentials.
    if (params.preferSubscription === true) {
      options.env = envWithoutAnthropicKey();
    } else if (params.token !== undefined) {
      options.env = { ANTHROPIC_API_KEY: params.token };
    }
    return sdk.query({ prompt: params.prompt, options });
  }
}
