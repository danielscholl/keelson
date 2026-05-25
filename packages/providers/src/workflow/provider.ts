// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { IAgentProvider, MessageChunk, ModelInfo, ProviderCapabilities } from "../types.ts";

// Capabilities lock-down: this is a non-chat provider used only as the
// providerId stamp on workflow-linked conversations. It exists so the
// existing NOT NULL conversations.providerId column + sidebar provider-badge
// lookup keep working without a schema relaxation; the chat surface never
// instantiates it for a turn (the workflow conversation renders via the
// existing useWorkflowRun hook instead).
export const WORKFLOW_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  streaming: false,
  tools: false,
  models: [],
  defaultModel: "",
};

export class WorkflowProvider implements IAgentProvider {
  getType(): string {
    return "workflow";
  }

  getCapabilities(): ProviderCapabilities {
    return WORKFLOW_CAPABILITIES;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  // biome-ignore lint/correctness/useYield: non-chat provider throws unconditionally; no chunk to yield
  async *sendQuery(): AsyncGenerator<MessageChunk> {
    // Defense-in-depth: the chat-handler POST also rejects this providerId,
    // but if anything slips through, fail loudly rather than silently
    // echoing. `async *` is enough to satisfy AsyncGenerator — no yield
    // is required when the body throws unconditionally.
    throw new Error("workflow provider is non-chat; use POST /api/workflows/:name/runs");
  }
}
