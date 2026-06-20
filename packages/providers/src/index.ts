// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export { buildFriendlyClaudeError } from "./claude/errors.ts";
export type {
  ClaudeCliAuthResult,
  ClaudeCliRunner,
  ClaudeContentBlock,
  ClaudeQueryFactoryOptions,
  ClaudeQueryHandle,
  ClaudeQueryOptions,
  ClaudeSdkLoader,
  ClaudeSdkMessage,
  ClaudeSdkModule,
  CreateQueryParams,
} from "./claude/factory.ts";
export { ClaudeQueryFactory } from "./claude/factory.ts";
export {
  CLAUDE_CAPABILITIES,
  CLAUDE_CREDENTIAL_SERVICE_ID,
  CLAUDE_DEFAULT_MODEL,
  ClaudeProvider,
  type ClaudeProviderOptions,
} from "./claude/provider.ts";
export {
  type ClaudeAuthProbe,
  type RegisterClaudeProviderOptions,
  type RegisterClaudeProviderResult,
  registerClaudeProvider,
} from "./claude/registration.ts";
export type { CodexRawEvent } from "./codex/event-bridge.ts";
export { mapCodexEvent } from "./codex/event-bridge.ts";
export {
  type CheckCodexAuthOptions,
  type CodexAuthStatus,
  type CodexCreateThreadParams,
  type CodexReasoningEffort,
  type CodexSandboxMode,
  type CodexThread,
  type CodexThreadFactory,
  checkCodexAuth,
} from "./codex/factory.ts";
export {
  CODEX_CAPABILITIES,
  CODEX_DEFAULT_MODEL,
  CodexProvider,
  type CodexProviderOptions,
} from "./codex/provider.ts";
export {
  type CodexAuthProbe,
  type RegisterCodexProviderResult,
  registerCodexProvider,
} from "./codex/registration.ts";
export { buildFriendlyCopilotError } from "./copilot/errors.ts";
export {
  type CopilotAuthStatus,
  CopilotClientFactory,
  type CopilotClientFactoryOptions,
  type CopilotClientLike,
  type CopilotModelInfo,
  type CopilotPermissionHandler,
  type CopilotSdkLoader,
  type CopilotSdkModule,
  type CopilotSessionLike,
  type CreateClientResult,
} from "./copilot/factory.ts";
export {
  COPILOT_CAPABILITIES,
  COPILOT_CREDENTIAL_SERVICE_ID,
  COPILOT_DEFAULT_MODEL,
  CopilotProvider,
  type CopilotProviderOptions,
  type GetCredentialFn,
} from "./copilot/provider.ts";
export {
  type CopilotAuthProbe,
  type RegisterCopilotProviderOptions,
  type RegisterCopilotProviderResult,
  registerCopilotProvider,
} from "./copilot/registration.ts";
export { UnknownProviderError } from "./errors.ts";
export { GatewayProvider, type GatewayProviderOptions } from "./gateway/provider.ts";
export {
  type ConfiguredGateway,
  type RegisterGatewayProviderOptions,
  registerConfiguredGateways,
  registerGatewayProvider,
} from "./gateway/registration.ts";
export type { PiRawEvent } from "./pi/event-bridge.ts";
export { mapPiEvent } from "./pi/event-bridge.ts";
export type {
  PiAuthStatus,
  PiCreateSessionParams,
  PiSession,
  PiSessionFactory,
} from "./pi/factory.ts";
export { checkPiAuth, PiAgentSessionFactory } from "./pi/factory.ts";
export {
  PI_CAPABILITIES,
  PI_DEFAULT_MODEL,
  PiProvider,
  type PiProviderOptions,
} from "./pi/provider.ts";
export {
  type PiAuthProbe,
  type RegisterPiProviderResult,
  registerPiProvider,
} from "./pi/registration.ts";
export {
  clearRegistry,
  getAgentProvider,
  getProviderInfoList,
  getRegistration,
  isRegisteredProvider,
  registerProvider,
  unregisterProvider,
} from "./registry.ts";
export { StubProvider } from "./stub/provider.ts";
export { registerStubProvider } from "./stub/registration.ts";
export type {
  IAgentProvider,
  MCPServerConfig,
  MessageChunk,
  ModelInfo,
  ProviderCapabilities,
  ProviderInfo,
  ProviderRegistration,
  SendQueryOptions,
  ToolCallGate,
  ToolDefinition,
} from "./types.ts";
export { WORKFLOW_CAPABILITIES, WorkflowProvider } from "./workflow/provider.ts";
export { registerWorkflowProvider } from "./workflow/registration.ts";
