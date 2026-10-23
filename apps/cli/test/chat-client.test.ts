// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { type ProviderInfoRow, pickDefaultHttpProvider } from "../src/http/chat-client.ts";

const row = (id: string): ProviderInfoRow => ({
  id,
  displayName: id,
  builtIn: true,
  capabilities: { models: [], defaultModel: "" } as unknown as ProviderInfoRow["capabilities"],
});

describe("pickDefaultHttpProvider", () => {
  test("honors the server's default provider when it is registered", () => {
    expect(pickDefaultHttpProvider([row("copilot"), row("pi"), row("stub")], "pi")).toBe("pi");
  });

  test("ignores an unregistered or synthetic server default", () => {
    expect(pickDefaultHttpProvider([row("copilot"), row("stub")], "pi")).toBe("copilot");
    expect(pickDefaultHttpProvider([row("workflow"), row("stub")], "workflow")).toBe("stub");
  });

  test("falls back copilot → stub → first non-workflow without a server default", () => {
    expect(pickDefaultHttpProvider([row("pi"), row("copilot")])).toBe("copilot");
    expect(pickDefaultHttpProvider([row("pi"), row("stub")])).toBe("stub");
    expect(pickDefaultHttpProvider([row("workflow"), row("pi")])).toBe("pi");
  });
});
