// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// Owns SDK load + client construction so the provider has one swappable seam
// for tests. Lazy SDK import keeps providers/ importable without spawning a
// native binary (docs/architecture.md §4 provider rules).

import type { ToolContext } from "@keelson/shared";
import { checkToolCallGate } from "../tool-gate.ts";
import { deriveToolParametersJsonSchema } from "../tool-params.ts";
import type { MessageChunk, ModelInfo, ToolCallGate, ToolDefinition } from "../types.ts";

// Structural — captures only what the provider drives. Keeps this file off a
// typeof-import on the SDK so tests can pass any compatible shape.
export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  createSession(config?: unknown): Promise<CopilotSessionLike>;
  resumeSession(sessionId: string, config?: unknown): Promise<CopilotSessionLike>;
  // `authType` is "user" / "gh-cli" for local OAuth, "token" / "env" for
  // explicit credentials. Used so SignIn never round-trips the token.
  getAuthStatus(): Promise<CopilotAuthStatus>;
  // Caller must start() the client first — SDK throws "Client not connected"
  // otherwise.
  listModels(): Promise<CopilotModelInfo[]>;
}

// Structural projection of the SDK's ModelInfo — only the fields the
// provider consumes.
export interface CopilotModelInfo {
  id: string;
  name?: string;
  capabilities?: {
    supports?: {
      vision?: boolean;
      // Optional here so minimal stubs/fixtures can omit it; SDK declares it
      // non-optional on the live shape.
      reasoningEffort?: boolean;
    };
  };
  billing?: {
    multiplier?: number;
  };
  // Only populated for models whose supports.reasoningEffort is true.
  supportedReasoningEfforts?: Array<"none" | "low" | "medium" | "high" | "xhigh">;
  defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
}

// Buckets per GitHub's Copilot premium-request scale.
function copilotCostTier(multiplier: number | undefined): ModelInfo["costTier"] {
  if (multiplier === undefined) return undefined;
  if (multiplier === 0) return "free";
  if (multiplier <= 1) return "low";
  if (multiplier <= 2) return "mid";
  return "high";
}

// Mirrors @keelson/shared's reasoningEffortLevelSchema. Repeated here so the
// projection can drop unknown values the live SDK ships (e.g. when GitHub
// rotates a new effort tier into the catalog) before they reach the wire
// schema — without this filter, one unknown effort poisons the whole
// /api/providers/:id/models response with a Zod parse error and the picker
// falls back to the curated 5-item baseline.
const KNOWN_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
type KnownReasoningEffort = (typeof KNOWN_REASONING_EFFORTS)[number];
function isKnownReasoningEffort(value: unknown): value is KnownReasoningEffort {
  return (
    typeof value === "string" && (KNOWN_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

// `tools: true` is hardcoded because every Copilot-served model accepts
// tool-use through the session protocol — the SDK's per-model
// `capabilities.supports` block carries vision + reasoningEffort only.
function projectCopilotModel(m: CopilotModelInfo): ModelInfo {
  const info: ModelInfo = { id: m.id };
  if (m.name) info.displayName = m.name;
  const tier = copilotCostTier(m.billing?.multiplier);
  if (tier !== undefined) info.costTier = tier;
  const supports: NonNullable<ModelInfo["supports"]> = { tools: true };
  if (m.capabilities?.supports?.vision === true) supports.vision = true;
  if (m.capabilities?.supports?.reasoningEffort === true) {
    // Filter supportedReasoningEfforts to known values. If the SDK
    // enumerated tiers AND every one of them is outside our schema, treat
    // the model as if reasoningEffort isn't supported at all — otherwise
    // the picker renders with no tier list and the client falls back to
    // its default "medium", which the model rejects (the whole point of
    // the new enum value the SDK added).
    let efforts: KnownReasoningEffort[] | undefined;
    if (m.supportedReasoningEfforts) {
      const raw = m.supportedReasoningEfforts as readonly unknown[];
      efforts = raw.filter(isKnownReasoningEffort);
      const dropped = raw.filter((e) => !isKnownReasoningEffort(e));
      if (dropped.length > 0) {
        console.warn(
          `[copilot] dropping unknown reasoning effort(s) from model ${m.id}: ${dropped.join(", ")}`,
        );
      }
    }
    const enumeratedButAllUnknown = efforts !== undefined && efforts.length === 0;
    if (!enumeratedButAllUnknown) {
      supports.reasoningEffort = true;
      if (efforts && efforts.length > 0) {
        info.supportedReasoningEfforts = efforts;
      }
      if (m.defaultReasoningEffort && isKnownReasoningEffort(m.defaultReasoningEffort)) {
        info.defaultReasoningEffort = m.defaultReasoningEffort;
      }
    }
  }
  info.supports = supports;
  return info;
}

export interface CopilotAuthStatus {
  isAuthenticated: boolean;
  authType?: "user" | "env" | "gh-cli" | "hmac" | "api-key" | "token";
  host?: string;
  login?: string;
  statusMessage?: string;
}

export interface CopilotSessionLike {
  readonly sessionId: string;
  send(options: { prompt: string }): Promise<unknown>;
  on(eventType: string, handler: (event: unknown) => void): () => void;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  // Used on resume to retarget the effort tier mid-conversation; new value
  // takes effect for the next message.
  setModel(
    model: string,
    options?: {
      reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
    },
  ): Promise<void>;
}

// Inputs widened to unknown so this layer doesn't import SDK types; callers
// cast when pulling `approveAll` off the loaded module.
export type CopilotPermissionHandler = (
  request: unknown,
  invocation: unknown,
) => Promise<unknown> | unknown;

export interface CopilotSdkModule {
  CopilotClient: new (options: {
    // Capital H matches the SDK; wrong casing silently drops auth.
    gitHubToken?: string;
    useLoggedInUser?: boolean;
    autoStart?: boolean;
    cwd?: string;
  }) => CopilotClientLike;
  // Required on SessionConfig/ResumeSessionConfig — createSession() and
  // resumeSession() reject synchronously if absent. `approveAll` is the
  // SDK's always-permit handler.
  approveAll: CopilotPermissionHandler;
}

export interface CreateClientResult {
  client: CopilotClientLike;
  permissionHandler: CopilotPermissionHandler;
}

export type CopilotSdkLoader = () => Promise<CopilotSdkModule>;

const defaultSdkLoader: CopilotSdkLoader = () =>
  import("@github/copilot-sdk") as unknown as Promise<CopilotSdkModule>;

export interface CopilotClientFactoryOptions {
  sdkLoader?: CopilotSdkLoader;
}

// `pushChunk` enqueues into the provider's outbound stream; `contextFactory`
// mints a per-invocation ToolContext keyed by the SDK's toolCallId so the
// wrapper can rewrite the skill's tool_result.toolUseId to match the UI row.
export interface CopilotToolProjectionContext {
  pushChunk: (chunk: MessageChunk) => void;
  contextFactory: (toolCallId: string) => ToolContext;
  // Per-call policy gate (server-wired). When present, each projected tool call
  // is evaluated WITH its validated args before execute and a deny emits an
  // error tool_result. Built-in capabilities (read / write / shell / …) gate
  // separately via the permission handler, so they are out of this gate's scope.
  evaluateToolCall?: ToolCallGate;
}

// Projects our streaming ToolDefinitions into the SDK's "handler returns
// value" Tool shape. The handler validates with the skill's inputSchema,
// runs `execute()`, captures the tool_result for the SDK return, and lets
// other chunks pass through to the UI stream.
//
// Parameters are omitted for `z.object({})` (SDK treats undefined as no-args).
export function projectToolsForCopilot(
  tools: ToolDefinition[],
  projection: CopilotToolProjectionContext,
): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: deriveToolParametersJsonSchema(tool),
    // First-party tools; no interactive approval gate.
    skipPermission: true,
    handler: async (args: unknown, invocation: { toolCallId: string }): Promise<string> => {
      const ctx = projection.contextFactory(invocation.toolCallId);
      return runToolHandler(tool, args, invocation.toolCallId, ctx, projection.evaluateToolCall);
    },
  }));
}

async function runToolHandler(
  tool: ToolDefinition,
  rawArgs: unknown,
  toolCallId: string,
  ctxIn: ToolContext,
  gate?: ToolCallGate,
): Promise<string> {
  // Skills emit tool_result with a placeholder toolUseId; we rewrite to the
  // SDK's id (same one tool.execution_start carries) so the UI pairs rows.
  let resultContent: string | null = null;
  let resultIsError = false;
  const ctx: ToolContext = {
    cwd: ctxIn.cwd,
    abortSignal: ctxIn.abortSignal,
    emit: (chunk) => {
      if (chunk.type === "tool_result") {
        const rewritten: MessageChunk = {
          ...chunk,
          toolUseId: toolCallId,
        };
        ctxIn.emit(rewritten);
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
    ctxIn.emit({
      type: "tool_result",
      toolUseId: toolCallId,
      content: message,
      isError: true,
    });
    return message;
  }

  // Per-call policy gate, after validation so a policy sees normalized args.
  const gateResult = await checkToolCallGate(gate, tool.name, parsed.data);
  if (gateResult.denied) {
    ctxIn.emit({
      type: "tool_result",
      toolUseId: toolCallId,
      content: gateResult.message,
      isError: true,
    });
    return gateResult.message;
  }

  try {
    await tool.execute(parsed.data, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctxIn.emit({
      type: "tool_result",
      toolUseId: toolCallId,
      content: message,
      isError: true,
    });
    return message;
  }

  if (resultContent === null) {
    // Empty success so the SDK's reasoning loop has something to consume.
    ctxIn.emit({
      type: "tool_result",
      toolUseId: toolCallId,
      content: "",
    });
    return "";
  }

  return resultIsError ? `Error: ${resultContent}` : resultContent;
}

export class CopilotClientFactory {
  private readonly loadSdk: CopilotSdkLoader;

  constructor(options: CopilotClientFactoryOptions = {}) {
    this.loadSdk = options.sdkLoader ?? defaultSdkLoader;
  }

  async load(): Promise<CopilotSdkModule> {
    return this.loadSdk();
  }

  // Bundles construction + start so sendQuery has one failure point to wrap.
  // Surfaces approveAll so the provider can satisfy the session's required
  // onPermissionRequest without reloading the SDK module.
  async createClient(gitHubToken: string | undefined, cwd: string): Promise<CreateClientResult> {
    const sdk = await this.loadSdk();
    // Two auth modes: explicit gitHubToken (paste token) suppresses the SDK
    // CLI-OAuth fallback; absence opts into `copilot auth login` credentials.
    const client = new sdk.CopilotClient(
      gitHubToken
        ? {
            gitHubToken,
            useLoggedInUser: false,
            autoStart: false,
            cwd,
          }
        : {
            useLoggedInUser: true,
            autoStart: false,
            cwd,
          },
    );
    try {
      await client.start();
    } catch (err) {
      // SDK can spawn the CLI subprocess before start() rejects; clean it up
      // so the failure path doesn't leak processes.
      try {
        await client.stop();
      } catch {
        // stop() can fail when the process never reached ready; surface the
        // original start error regardless.
      }
      throw err;
    }
    return { client, permissionHandler: sdk.approveAll };
  }

  // One-shot probe using the same dual-auth path createClient uses, so the
  // answer matches what sendQuery would do.
  async checkAuthStatus(gitHubToken: string | undefined, cwd: string): Promise<CopilotAuthStatus> {
    let client: CopilotClientLike | null = null;
    try {
      const created = await this.createClient(gitHubToken, cwd);
      client = created.client;
      return await client.getAuthStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isAuthenticated: false, statusMessage: msg };
    } finally {
      if (client) {
        try {
          await client.stop();
        } catch {
          // stop() failures during a probe-only run are non-fatal.
        }
      }
    }
  }

  // Throwaway-client probe symmetric to checkAuthStatus. Returns null on
  // any failure so the provider can fall back to its curated baseline.
  async listModels(gitHubToken: string | undefined, cwd: string): Promise<ModelInfo[] | null> {
    let client: CopilotClientLike | null = null;
    try {
      const created = await this.createClient(gitHubToken, cwd);
      client = created.client;
      const models = await client.listModels();
      return models.filter((m) => typeof m.id === "string").map(projectCopilotModel);
    } catch {
      return null;
    } finally {
      if (client) {
        try {
          await client.stop();
        } catch {
          // stop() failures during a probe-only run are non-fatal.
        }
      }
    }
  }
}
