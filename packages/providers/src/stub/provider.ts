// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type {
  IAgentProvider,
  MessageChunk,
  ModelInfo,
  ProviderCapabilities,
  SendQueryOptions,
} from "../types.ts";

const STUB_CONTEXT_WINDOW = 8192;
// Lets the stub exercise max_tokens handling without depending on a real SDK.
export const STUB_OUTPUT_TOKEN_BUDGET = 256;

export const STUB_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  streaming: true,
  tools: false,
  // Single dev-only id so the picker has something to render.
  models: ["stub-echo"],
  // Empty → the picker shows "(default)" and no model is sent on the wire.
  defaultModel: "",
};

export class StubProvider implements IAgentProvider {
  getType(): string {
    return "stub";
  }

  getCapabilities(): ProviderCapabilities {
    return STUB_CAPABILITIES;
  }

  async listModels(): Promise<ModelInfo[]> {
    return STUB_CAPABILITIES.models.map((id) => ({ id }));
  }

  async *sendQuery(
    prompt: string,
    _cwd: string,
    _resumeSessionId?: string,
    _options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    yield { type: "system", content: "stub provider started" };
    const tokens = prompt.split(/\s+/).filter(Boolean);
    const emittedTokens = tokens.slice(0, STUB_OUTPUT_TOKEN_BUDGET);
    for (const token of emittedTokens) {
      yield { type: "text", content: `${token} ` };
    }
    _options?.onFinishReason?.(tokens.length > STUB_OUTPUT_TOKEN_BUDGET ? "max_tokens" : "end");
    // Deterministic synthetic usage (1 word ≈ 1 token) so the keyless path
    // exercises the same usage pipeline the real providers feed.
    const count = tokens.length;
    const outputCount = emittedTokens.length;
    yield {
      type: "usage",
      usage: {
        inputTokens: count,
        outputTokens: outputCount,
        contextTokens: count + outputCount,
        contextWindow: STUB_CONTEXT_WINDOW,
      },
    };
    yield { type: "done" };
  }
}
