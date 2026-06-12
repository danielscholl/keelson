// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { ModelInfo, ProviderInfo } from "@keelson/shared";
import { render, screen } from "@testing-library/react";
import { ModelPickerPopover } from "../src/components/Chat/ModelPickerPopover.tsx";

const piProvider: ProviderInfo = {
  id: "pi",
  displayName: "Pi (community)",
  capabilities: {
    sessionResume: false,
    streaming: true,
    tools: false,
    models: [],
    defaultModel: "",
  },
  builtIn: true,
};

const copilotProvider: ProviderInfo = {
  id: "copilot",
  displayName: "GitHub Copilot",
  capabilities: { sessionResume: true, streaming: true, tools: true, models: [], defaultModel: "" },
  builtIn: true,
};

function renderPicker(providers: ProviderInfo[], modelsByProvider: Record<string, ModelInfo[]>) {
  return render(
    <ModelPickerPopover
      popoverId="test-popover"
      providers={providers}
      modelsByProvider={modelsByProvider}
      activeRef={null}
      favorites={[]}
      lockedProviderId={null}
      onSelect={() => {}}
      onToggleFavorite={() => {}}
    />,
  );
}

describe("ModelPickerPopover", () => {
  test("sub-groups a multi-vendor (pi) section by vendor with pretty labels", () => {
    renderPicker([piProvider], {
      pi: [
        { id: "anthropic/claude-opus-4.5", displayName: "Claude Opus 4.5", billing: "metered" },
        { id: "github-copilot/gpt-5.5", displayName: "GPT-5.5", billing: "subscription" },
      ],
    });
    // Vendor sub-headers rendered from the "vendor/" id prefix...
    expect(screen.getByText("Anthropic")).toBeDefined();
    expect(screen.getByText("GitHub Copilot")).toBeDefined();
    // ...and the models themselves render under them (grouping, not just labels).
    expect(screen.getByText("Claude Opus 4.5")).toBeDefined();
    expect(screen.getByText("GPT-5.5")).toBeDefined();
  });

  test("preserves incoming order for interleaved vendors (consecutive grouping)", () => {
    renderPicker([piProvider], {
      pi: [
        { id: "a/1", displayName: "A 1", billing: "metered" },
        { id: "b/1", displayName: "B 1", billing: "metered" },
        { id: "a/2", displayName: "A 2", billing: "metered" },
      ],
    });
    // Vendor "a" interleaves, so its sub-header appears once per consecutive run
    // rather than the rows being re-bucketed together.
    expect(screen.getAllByText("A")).toHaveLength(2);
    expect(screen.getByText("B")).toBeDefined();
    // Rendered model order matches the incoming order, not a regrouped one.
    const order = screen.getAllByText(/^[AB] \d$/).map((el) => el.textContent);
    expect(order).toEqual(["A 1", "B 1", "A 2"]);
  });

  test("shows the API (metered) mark only on metered models, not subscription ones", () => {
    renderPicker([piProvider], {
      pi: [
        { id: "anthropic/claude-opus-4.5", displayName: "Claude Opus 4.5", billing: "metered" },
        { id: "anthropic/claude-haiku-4.5", displayName: "Claude Haiku 4.5", billing: "metered" },
        { id: "github-copilot/gpt-5.5", displayName: "GPT-5.5", billing: "subscription" },
      ],
    });
    // One mark per metered model; the subscription model carries none...
    expect(screen.getAllByText("API")).toHaveLength(2);
    // ...but still renders (a regression dropping subscription rows would fail here).
    expect(screen.getByText("GPT-5.5")).toBeDefined();
  });

  test("renders a single-vendor provider flat (no vendor sub-header)", () => {
    renderPicker([copilotProvider], {
      copilot: [
        { id: "gpt-5.5", displayName: "GPT-5.5", costTier: "mid" },
        { id: "gpt-4.1", displayName: "GPT-4.1", costTier: "low" },
      ],
    });
    // Flat ids (no "/") → no metered mark and no vendor sub-headers; both
    // models still render.
    expect(screen.getByText("GPT-5.5")).toBeDefined();
    expect(screen.getByText("GPT-4.1")).toBeDefined();
    expect(screen.queryAllByText("API")).toHaveLength(0);
  });
});
