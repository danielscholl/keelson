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
export const SCHEMA_VERSION = "0.1" as const;

// Copilot reasoning tier. Sibling of `thinking` (Anthropic's boolean
// adaptive-thinking) rather than a polymorphic merge — both providers stream
// through the same `thinking` MessageChunk channel.
export const reasoningEffortLevelSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type ReasoningEffortLevel = z.infer<typeof reasoningEffortLevelSchema>;

export const messageChunkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system"), content: z.string() }).strict(),
  z.object({ type: z.literal("text"), content: z.string() }).strict(),
  z.object({ type: z.literal("thinking"), content: z.string() }).strict(),
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
// traces stay live-only, matching the memory layer's "no reasoning traces"
// rule (docs/agent-memory.md §"Write-back guardrails").
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
