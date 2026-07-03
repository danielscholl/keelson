// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

export const WIRE_PROTOCOL_VERSION = "1.0" as const;

// Contract schema marker shared by /api/health, /api/config, and the CLI's
// `version` command. Bump on any breaking change to the chat / workflow /
// tools schemas in this package.
// 0.2: token usage — new `usage` MessageChunk variant, Message.usage,
// NodeOutputRow.usage, node_done frame usage. Pre-0.2 clients strict-reject
// frames carrying these.
// 0.3: resolved model — new `model` MessageChunk variant emitted by providers
// whose model is resolved session-side (pi). Pre-0.3 clients strict-reject
// frames carrying it.
// 0.4: node provenance — new provider/model on NodeOutputRow and the node_done
// frame. Pre-0.4 clients strict-reject frames carrying them.
export const SCHEMA_VERSION = "0.4" as const;

// A peer (the server on /api/health + /api/config, or a client's bundle)
// reports its SCHEMA_VERSION. Any difference from this build's value signals
// additive wire skew that strict frame parsing rejects mid-stream, so both
// clients gate on it before opening a chat/workflow stream. Equality, not
// ordering, is the test: skew breaks in either direction — an older client
// strict-rejects a newer server's frames, and a newer client's request frame
// is strict-rejected by an older server.
export function isSchemaVersionCompatible(peerSchemaVersion: string): boolean {
  return peerSchemaVersion === SCHEMA_VERSION;
}

// Copilot reasoning tier. Sibling of `thinking` (Anthropic's boolean
// adaptive-thinking) rather than a polymorphic merge — both providers stream
// through the same `thinking` MessageChunk channel.
export const reasoningEffortLevelSchema = z.enum(["none", "low", "medium", "high", "xhigh"]);
export type ReasoningEffortLevel = z.infer<typeof reasoningEffortLevelSchema>;

// Normalized per-turn token usage. Two distinct measures live here and must
// never be conflated: inputTokens/outputTokens are TURN TOTALS (summed across
// the turn's API calls — what the turn cost), while contextTokens/contextWindow
// describe CONTEXT FILL (input-side tokens of the turn's final API call vs the
// model's window — what the next turn starts from). Fields are optional where
// a provider may not report them; emitters omit the whole object rather than
// fabricating zeros — except context-only reporters (e.g. Copilot when only
// session.usage_info fires), which carry real context fields alongside zero
// totals; display surfaces gate ↑/↓ rendering on a non-zero total for that
// case.
export const tokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadInputTokens: z.number().int().nonnegative().optional(),
    cacheCreationInputTokens: z.number().int().nonnegative().optional(),
    contextTokens: z.number().int().nonnegative().optional(),
    contextWindow: z.number().int().positive().optional(),
  })
  .strict();
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

// Rebuilds a provider-supplied usage payload from known fields only, flooring
// floats and dropping extras. Providers are pluggable, and raw payloads ride
// strictly-validated wire frames — an unknown key or non-integer count from an
// out-of-tree provider would otherwise fail the frame parse, not just the
// field. Returns undefined (emit/persist nothing) when the required counts are
// missing. packages/workflows keeps a dep-free structural mirror of this in
// its prompt handler (sanitizeNodeUsage) — keep the two in lockstep.
export function coerceTokenUsage(u: unknown): TokenUsage | undefined {
  if (u === null || typeof u !== "object" || Array.isArray(u)) return undefined;
  const rec = u as Record<string, unknown>;
  const count = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const inputTokens = count(rec.inputTokens);
  const outputTokens = count(rec.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const out: TokenUsage = { inputTokens, outputTokens };
  const cacheRead = count(rec.cacheReadInputTokens);
  if (cacheRead !== undefined) out.cacheReadInputTokens = cacheRead;
  const cacheCreation = count(rec.cacheCreationInputTokens);
  if (cacheCreation !== undefined) out.cacheCreationInputTokens = cacheCreation;
  const contextTokens = count(rec.contextTokens);
  if (contextTokens !== undefined) out.contextTokens = contextTokens;
  const contextWindow = count(rec.contextWindow);
  if (contextWindow !== undefined && contextWindow > 0) out.contextWindow = contextWindow;
  return out;
}

// Hydrates a persisted usage_json column; degrades to undefined on malformed
// rows so a bad write can't break conversation/run loads.
export function parsePersistedTokenUsage(raw: string | null): TokenUsage | undefined {
  if (raw === null) return undefined;
  try {
    const result = tokenUsageSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export const messageChunkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system"), content: z.string() }).strict(),
  z.object({ type: z.literal("text"), content: z.string() }).strict(),
  z.object({ type: z.literal("thinking"), content: z.string() }).strict(),
  // Emitted at most once per turn, at stream end, from the provider's final
  // usage-bearing SDK event. Never accumulated across stream events.
  z.object({ type: z.literal("usage"), usage: tokenUsageSchema }).strict(),
  // The model the provider's session actually resolved for this turn, for
  // providers whose default is decided session-side (pi's defaultModel is "",
  // copilot's is "auto"). May re-emit when the session switches models
  // mid-turn (copilot's rate-limit auto-switch); consumers keep the last
  // report. Display-only: consumers must not pin it onto subsequent requests.
  z.object({ type: z.literal("model"), model: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("tool_use"),
      // Optional; emitters that omit it produce unpairable UI rows.
      id: z.string().optional(),
      toolName: z.string(),
      toolInput: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      // Required so <ToolCallsBlock> pairs with the originating tool_use.
      toolUseId: z.string(),
      content: z.string(),
      isError: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("error"), message: z.string() }).strict(),
  z.object({ type: z.literal("done") }).strict(),
]);
export type MessageChunk = z.infer<typeof messageChunkSchema>;

// Durable shape replayed on reload. Thinking blocks are excluded — reasoning
// traces stay live-only and never durably store.
export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("tool_use"),
      id: z.string(),
      toolName: z.string(),
      toolInput: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      toolUseId: z.string(),
      content: z.string(),
      isError: z.boolean().optional(),
    })
    .strict(),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const messageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    // Denormalized text summary — sidebar previews, list rows, future FTS.
    // For text-only turns this is the content; for structured turns it's the
    // assembled text projection alongside `contentParts`.
    content: z.string(),
    // Structured blocks for turns with tool calls. Readers fall back to
    // `content` when absent.
    contentParts: z.array(contentBlockSchema).optional(),
    // UI marker for turns that ended without a clean `done` (abort or
    // provider error). Providers resume via providerSessionId, not these rows.
    truncated: z.boolean().optional(),
    // Per-turn token usage on assistant rows; absent when the provider
    // reported none.
    usage: tokenUsageSchema.optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Message = z.infer<typeof messageSchema>;

// Denormalized workflow projection for run-as-conversation. Server populates
// this via LEFT JOIN workflow_runs in ConversationStore.list/get so the
// sidebar can partition workflow runs into their own section without an N+1.
// Absent for regular chat conversations.
export const conversationWorkflowProjectionSchema = z
  .object({
    runId: z.string(),
    workflowName: z.string(),
    // Duplicates workflowRunStatusSchema literally — can't import workflows.ts
    // here without a cycle (workflows.ts imports contentBlockSchema from chat).
    // Keep `paused` (HITL approval node) in lockstep with the source enum.
    status: z.enum(["running", "paused", "succeeded", "failed", "cancelled"]),
  })
  .strict();
export type ConversationWorkflowProjection = z.infer<typeof conversationWorkflowProjectionSchema>;

export const conversationSchema = z
  .object({
    id: z.string(),
    providerId: z.string(),
    model: z.string().optional(),
    providerSessionId: z.string().optional(),
    name: z.string().optional(),
    // Conversation-scoped system prompt seeded at creation (e.g. by a
    // workflow that handed off into chat). Write-once; concatenated with
    // the per-turn identity prompt on every send.
    seedSystemPrompt: z.string().optional(),
    messages: z.array(messageSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime().optional(),
    workflow: conversationWorkflowProjectionSchema.optional(),
    projectId: z.string().optional(),
  })
  .strict();
export type Conversation = z.infer<typeof conversationSchema>;

export const providerCapabilitiesSchema = z
  .object({
    sessionResume: z.boolean(),
    streaming: z.boolean(),
    tools: z.boolean(),
    // Curated baseline; live list comes from GET /api/providers/:id/models.
    models: z.array(z.string()).default([]),
    // Empty string means "let the SDK decide" (no model sent on the wire).
    defaultModel: z.string().default(""),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const providerInfoSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    capabilities: providerCapabilitiesSchema,
    builtIn: z.boolean(),
    credentialServiceId: z.string().optional(),
  })
  .strict();
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

// Per-model metadata served from GET /api/providers/:id/models. Additive —
// providers populate what they know; Copilot mines from SDK, Claude carries
// a curated map, stub returns `{ id }` only.
export const modelInfoSchema = z
  .object({
    id: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    costTier: z.enum(["free", "low", "mid", "high"]).optional(),
    // How the underlying turn is billed. "metered" = a per-token API key;
    // "subscription" = a flat-rate OAuth login. Undefined = unknown — the
    // picker shows a mark only for "metered". Driven by pi's per-vendor auth
    // route today; other providers may populate it later.
    billing: z.enum(["metered", "subscription"]).optional(),
    supports: z
      .object({
        vision: z.boolean().optional(),
        tools: z.boolean().optional(),
        thinking: z.boolean().optional(),
        reasoningEffort: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Picker falls back to the full enum when the SDK doesn't narrow.
    supportedReasoningEfforts: z.array(reasoningEffortLevelSchema).optional(),
    defaultReasoningEffort: reasoningEffortLevelSchema.optional(),
  })
  .strict();
export type ModelInfo = z.infer<typeof modelInfoSchema>;

// Client → server: one envelope, one discriminated union of message types.
// Mirrors the server → client `chatFrameSchema` below so version-skew checks
// fire on both sides of the wire.

export const clientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("request"),
      providerId: z.string(),
      prompt: z.string(),
      model: z.string().optional(),
      // Per-turn opt-in for Claude extended thinking; undefined = SDK default.
      thinking: z.boolean().optional(),
      // Per-turn Copilot reasoning tier; undefined = per-model SDK default.
      reasoningEffort: reasoningEffortLevelSchema.optional(),
    })
    .strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const clientFrameSchema = z
  .object({
    version: z.literal(WIRE_PROTOCOL_VERSION),
    conversationId: z.string(),
    message: clientMessageSchema,
  })
  .strict();
export type ClientFrame = z.infer<typeof clientFrameSchema>;

// Server → client: chat events wrapped in a versioned frame.

export const chatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chunk"), payload: messageChunkSchema }).strict(),
  z
    .object({
      type: z.literal("error"),
      message: z.string(),
      code: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal("done") }).strict(),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;

export const chatFrameSchema = z
  .object({
    version: z.literal(WIRE_PROTOCOL_VERSION),
    conversationId: z.string(),
    event: chatEventSchema,
  })
  .strict();
export type ChatFrame = z.infer<typeof chatFrameSchema>;

// Kebab-case ASCII guards the keyring `account` field from path-traversal
// shapes reaching the native module.
export const credentialServiceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
export type CredentialServiceId = z.infer<typeof credentialServiceIdSchema>;

export const setCredentialBodySchema = z.object({ value: z.string().min(1) }).strict();
export type SetCredentialBody = z.infer<typeof setCredentialBodySchema>;

export const credentialStatusSchema = z.object({ signedIn: z.boolean() }).strict();
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

// Proxies SDK.getAuthStatus() so SignIn never round-trips the token.
// `authenticated` renamed from the SDK's `isAuthenticated` for consistency
// with credentialStatusSchema.signedIn.
export const copilotAuthTypeSchema = z.enum(["user", "env", "gh-cli", "hmac", "api-key", "token"]);
export type CopilotAuthType = z.infer<typeof copilotAuthTypeSchema>;

export const copilotCliStatusSchema = z
  .object({
    authenticated: z.boolean(),
    authType: copilotAuthTypeSchema.optional(),
    login: z.string().optional(),
    host: z.string().optional(),
    statusMessage: z.string().optional(),
  })
  .strict();
export type CopilotCliStatus = z.infer<typeof copilotCliStatusSchema>;

// Proxies `claude auth status --json` because the SDK has no programmatic
// auth-status method. `authMethod` stays free-form because the CLI expands
// its enum over time.
export const claudeCliStatusSchema = z
  .object({
    authenticated: z.boolean(),
    authMethod: z.string().optional(),
    login: z.string().optional(),
    statusMessage: z.string().optional(),
  })
  .strict();
export type ClaudeCliStatus = z.infer<typeof claudeCliStatusSchema>;

// Max matches the auto-name truncation budget plus headroom.
export const renameConversationBodySchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict();
export type RenameConversationBody = z.infer<typeof renameConversationBodySchema>;
