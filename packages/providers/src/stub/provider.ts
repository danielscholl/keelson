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
    for (const token of tokens) {
      yield { type: "text", content: `${token} ` };
    }
    yield { type: "done" };
  }
}
