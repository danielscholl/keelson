// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { StatusFooter } from "../src/interactive/footer.ts";
import { buildWelcomeLines, type WelcomeData } from "../src/interactive/welcome.ts";

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping needs the escape byte.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const base: WelcomeData = {
  version: "0.5.0",
  providerId: "pi",
  model: "claude-sonnet",
  projectName: "keelson",
  branch: "main",
  ribs: [],
  recent: [],
};

describe("buildWelcomeLines", () => {
  test("renders the mark, state echo, tips strip, and ribs", () => {
    const text = buildWelcomeLines(base).map(stripAnsi).join("\n");
    expect(text).toContain("━┿━┿━  keelson");
    expect(text).toContain(" │ │");
    expect(text).toContain("v0.5.0");
    // The footer owns live state; the card echoes provider · model · project once
    // and never re-tables it.
    expect(text).toContain("pi · claude-sonnet · keelson");
    expect(text).not.toContain("provider");
    // Tips are a single strip, not a table.
    expect(text).toContain("commands");
    expect(text).toContain("interrupt");
    expect(text).toContain("exit");
    // The empty-ribs line carries the add hint.
    expect(text).toContain("none installed");
    expect(text).toContain("keelson rib add <url>");
    expect(text).not.toContain("Recent");
  });

  test("lists installed ribs and recent sessions when present", () => {
    const text = buildWelcomeLines({
      ...base,
      ribs: [
        { displayName: "Chamber", tools: 4 },
        { displayName: "OSDU", tools: 7 },
      ],
      recent: [
        { name: "keelson", ago: "just now" },
        { name: "sample", ago: "20h ago" },
      ],
    })
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("2 — Chamber, OSDU");
    expect(text).toContain("Recent");
    expect(text).toContain("sample");
    expect(text).toContain("just now");
    expect(text).toContain("20h ago");
    // The add hint only appears when no ribs are installed.
    expect(text).not.toContain("keelson rib add");
  });

  test("surfaces the project note and keeps branch out of the card", () => {
    const text = buildWelcomeLines({
      ...base,
      branch: null,
      projectNote: "project name 'x' is taken",
    })
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("project name 'x' is taken");
    expect(text).not.toContain("· main");
  });
});

describe("StatusFooter", () => {
  test("renders provider, project, branch, meter, and activity", () => {
    const footer = new StatusFooter({
      providerId: "pi",
      model: "claude-sonnet",
      projectName: "keelson",
      branch: "main",
      meter: "12%/200k",
      activity: "working",
    });
    const [line] = footer.render(120);
    const text = stripAnsi(line ?? "");
    expect(text).toContain("◆ pi · claude-sonnet");
    expect(text).toContain("keelson · main");
    expect(text).toContain("12%/200k");
    expect(text).toContain("⋯ working");
  });

  test("set() patches state and idle hides the activity segment", () => {
    const footer = new StatusFooter({
      providerId: "pi",
      projectName: "keelson",
      branch: null,
      meter: "0%",
      activity: "idle",
    });
    footer.set({ meter: "↑1.2k ↓340", activity: "workflow" });
    const text = stripAnsi(footer.render(120)[0] ?? "");
    expect(text).toContain("↑1.2k ↓340");
    expect(text).toContain("▶ workflow");
    footer.set({ activity: "idle" });
    expect(stripAnsi(footer.render(120)[0] ?? "")).not.toContain("workflow");
  });

  test("truncates to the terminal width", () => {
    const footer = new StatusFooter({
      providerId: "a-very-long-provider-name",
      model: "an-even-longer-model-identifier-string",
      projectName: "project-with-a-substantial-name",
      branch: "feature/extremely-long-branch-name",
      meter: "100%/1.0M",
      activity: "working",
    });
    const [line] = footer.render(40);
    expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(40);
  });
});
