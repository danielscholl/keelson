// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export type {
  IAgentProvider,
  MCPServerConfig,
  MessageChunk,
  ModelInfo,
  ProviderCapabilities,
  ProviderInfo,
  ProviderRegistration,
  SendQueryOptions,
  ToolDefinition,
} from "./types.ts";
export { UnknownProviderError } from "./errors.ts";
export {
  clearRegistry,
  getAgentProvider,
  getProviderInfoList,
  getRegistration,
  isRegisteredProvider,
  registerProvider,
} from "./registry.ts";
export { StubProvider } from "./stub/provider.ts";
export { registerStubProvider } from "./stub/registration.ts";
export { WorkflowProvider, WORKFLOW_CAPABILITIES } from "./workflow/provider.ts";
export { registerWorkflowProvider } from "./workflow/registration.ts";
export {
  COPILOT_CAPABILITIES,
  COPILOT_CREDENTIAL_SERVICE_ID,
  COPILOT_DEFAULT_MODEL,
  CopilotProvider,
  type CopilotProviderOptions,
  type GetCredentialFn,
} from "./copilot/provider.ts";
export {
  CopilotClientFactory,
  type CopilotAuthStatus,
  type CopilotClientFactoryOptions,
  type CopilotClientLike,
  type CopilotModelInfo,
  type CopilotPermissionHandler,
  type CopilotSdkLoader,
  type CopilotSdkModule,
  type CopilotSessionLike,
  type CreateClientResult,
} from "./copilot/factory.ts";
export { buildFriendlyCopilotError } from "./copilot/errors.ts";
export {
  registerCopilotProvider,
  type CopilotAuthProbe,
  type RegisterCopilotProviderOptions,
  type RegisterCopilotProviderResult,
} from "./copilot/registration.ts";
export {
  CLAUDE_CAPABILITIES,
  CLAUDE_CREDENTIAL_SERVICE_ID,
  CLAUDE_DEFAULT_MODEL,
  ClaudeProvider,
  type ClaudeProviderOptions,
} from "./claude/provider.ts";
export {
  ClaudeQueryFactory,
} from "./claude/factory.ts";
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
export { buildFriendlyClaudeError } from "./claude/errors.ts";
export {
  registerClaudeProvider,
  type ClaudeAuthProbe,
  type RegisterClaudeProviderOptions,
  type RegisterClaudeProviderResult,
} from "./claude/registration.ts";
