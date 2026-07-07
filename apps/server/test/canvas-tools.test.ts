// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canvasArtifactKey,
  DESIGN_TOKENS,
  type MessageChunk,
  type ToolContext,
  type ToolDefinition,
} from "@keelson/shared";
import { createArtifactStore } from "../src/artifact-store.ts";
import { type CanvasToolsHandle, createCanvasTools, slugifyTitle } from "../src/canvas-tools.ts";
import { createSnapshotManager } from "../src/snapshot-manager.ts";

let dir: string;
let handle: CanvasToolsHandle;
let manager: ReturnType<typeof createSnapshotManager>;

function tool(name: string): ToolDefinition {
  const found = handle.tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function makeCtx(): { ctx: ToolContext; chunks: MessageChunk[] } {
  const chunks: MessageChunk[] = [];
  return {
    chunks,
    ctx: { cwd: dir, emit: (c) => chunks.push(c), abortSignal: new AbortController().signal },
  };
}

function lastResult(chunks: MessageChunk[]): { content: string; isError: boolean } {
  const results = chunks.filter((c) => c.type === "tool_result");
  const last = results[results.length - 1];
  if (last?.type !== "tool_result") throw new Error("no tool_result emitted");
  return { content: last.content, isError: last.isError === true };
}

const PAGE = (bodyAttrs = ""): string =>
  `<style>:root { --fg: #d8def0; }</style><body${bodyAttrs}><h1>Report</h1></body>`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keelson-canvas-tools-"));
  manager = createSnapshotManager();
  handle = createCanvasTools({ store: createArtifactStore(dir), snapshotManager: manager });
});

afterEach(async () => {
  await manager.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("artifact store", () => {
  test("remove deletes both artifact files and is idempotent", () => {
    const store = createArtifactStore(dir);
    store.save({ slug: "remove-me", title: "Remove Me", html: PAGE() });

    expect(existsSync(join(dir, "remove-me.html"))).toBe(true);
    expect(existsSync(join(dir, "remove-me.json"))).toBe(true);

    store.remove("remove-me");
    store.remove("remove-me");
    store.remove("../invalid");

    expect(existsSync(join(dir, "remove-me.html"))).toBe(false);
    expect(existsSync(join(dir, "remove-me.json"))).toBe(false);
    expect(store.get("remove-me")).toBeUndefined();
  });
});

describe("canvas_publish", () => {
  test("publishes a page: persists both files, drives the snapshot key, reports the key", async () => {
    const { ctx, chunks } = makeCtx();
    await tool("canvas_publish").execute({ title: "Run Report", html: PAGE() }, ctx);
    const { content, isError } = lastResult(chunks);
    expect(isError).toBe(false);
    const result = JSON.parse(content) as { key: string; slug: string; updated: boolean };
    expect(result.slug).toBe("run-report");
    expect(result.key).toBe(canvasArtifactKey("run-report"));
    expect(result.updated).toBe(false);
    expect(readFileSync(join(dir, "run-report.html"), "utf8")).toBe(PAGE());
    expect(JSON.parse(readFileSync(join(dir, "run-report.json"), "utf8")).title).toBe("Run Report");
    expect(manager.latest<string>(result.key)?.data).toBe(PAGE());
  });

  test("re-publishing an explicit name updates in place and bumps the frame version", async () => {
    const first = makeCtx();
    await tool("canvas_publish").execute({ title: "Report", html: PAGE() }, first.ctx);
    const key = (JSON.parse(lastResult(first.chunks).content) as { key: string }).key;
    const v1 = manager.latest(key)?.version ?? -1;

    const second = makeCtx();
    await tool("canvas_publish").execute(
      { title: "Report v2", html: "<body><h1>v2</h1></body>", name: "report" },
      second.ctx,
    );
    const result = JSON.parse(lastResult(second.chunks).content) as {
      key: string;
      updated: boolean;
    };
    expect(result.key).toBe(key);
    expect(result.updated).toBe(true);
    expect(manager.latest<string>(key)?.data).toContain("v2");
    expect(manager.latest(key)?.version ?? -1).toBeGreaterThan(v1);
  });

  test("a colliding title without a name mints a fresh slug instead of overwriting", async () => {
    const first = makeCtx();
    await tool("canvas_publish").execute({ title: "Audit", html: PAGE() }, first.ctx);
    const second = makeCtx();
    await tool("canvas_publish").execute({ title: "Audit", html: PAGE() }, second.ctx);
    const result = JSON.parse(lastResult(second.chunks).content) as { slug: string };
    expect(result.slug).toBe("audit-2");
  });

  test("rejects external scripts and stylesheets loudly", async () => {
    for (const html of [
      '<body><script src="https://cdn.example/x.js"></script></body>',
      '<link rel="stylesheet" href="https://cdn.example/x.css"><body>x</body>',
    ]) {
      const { ctx, chunks } = makeCtx();
      await tool("canvas_publish").execute({ title: "t", html }, ctx);
      const { isError, content } = lastResult(chunks);
      expect(isError).toBe(true);
      expect(content).toContain("frame CSP");
    }
  });

  test("a declared palette that hard-fails validation rejects the publish with the report", async () => {
    const { ctx, chunks } = makeCtx();
    await tool("canvas_publish").execute(
      { title: "t", html: PAGE(' data-palette-dark="#888888,#8a8a8a,#8c8c8c"') },
      ctx,
    );
    const { isError, content } = lastResult(chunks);
    expect(isError).toBe(true);
    expect(content).toContain("[FAIL]");
    expect(content).toContain("publish again");
  });

  test("the keelson series slots validate clean in both declared modes", async () => {
    const { ctx, chunks } = makeCtx();
    const attrs = ` data-palette-dark="${DESIGN_TOKENS.dark.series.join(",")}" data-palette-light="${DESIGN_TOKENS.light.series.join(",")}"`;
    await tool("canvas_publish").execute({ title: "t", html: PAGE(attrs) }, ctx);
    const { isError, content } = lastResult(chunks);
    expect(isError).toBe(false);
    const result = JSON.parse(content) as { palette: string };
    expect(result.palette).toContain("dark: validated");
    expect(result.palette).toContain("light: validated");
  });

  test("data-palette applies to both modes; malformed hex is a clear error", async () => {
    const both = makeCtx();
    await tool("canvas_publish").execute(
      { title: "t", html: PAGE(` data-palette="${DESIGN_TOKENS.dark.series.join(",")}"`) },
      both.ctx,
    );
    expect(JSON.parse(lastResult(both.chunks).content).palette).toContain("light:");

    const bad = makeCtx();
    await tool("canvas_publish").execute(
      { title: "t", html: PAGE(' data-palette-dark="#zzz,#123456"') },
      bad.ctx,
    );
    const { isError, content } = lastResult(bad.chunks);
    expect(isError).toBe(true);
    expect(content).toContain("invalid hex color");
  });

  test("no declared palette publishes with an advisory note", async () => {
    const { ctx, chunks } = makeCtx();
    await tool("canvas_publish").execute({ title: "prose", html: PAGE() }, ctx);
    const result = JSON.parse(lastResult(chunks).content) as { palette: string };
    expect(result.palette).toContain("none declared");
  });

  test("invalid input reports the schema error instead of throwing", async () => {
    const { ctx, chunks } = makeCtx();
    await tool("canvas_publish").execute({ title: "", html: "" }, ctx);
    const { isError, content } = lastResult(chunks);
    expect(isError).toBe(true);
    expect(content).toContain("invalid input");
  });
});

describe("registerExisting", () => {
  test("a restart re-registers and recomposes every persisted artifact", async () => {
    const { ctx } = makeCtx();
    await tool("canvas_publish").execute({ title: "Keep Me", html: PAGE() }, ctx);
    await manager.dispose();

    // Fresh manager + handle over the same directory = a server restart.
    manager = createSnapshotManager();
    handle = createCanvasTools({ store: createArtifactStore(dir), snapshotManager: manager });
    handle.registerExisting();
    await Bun.sleep(0);
    expect(manager.latest<string>(canvasArtifactKey("keep-me"))?.data).toBe(PAGE());
  });
});

describe("canvas_design_guide", () => {
  test("serves each section", async () => {
    for (const [section, marker] of [
      ["page", "calibrate treatment"],
      ["form", "not a chart"],
      ["color", DESIGN_TOKENS.dark.series[0]],
      ["marks", "tabular-nums"],
      ["anti-patterns", "Two y-axes"],
    ] as const) {
      const { ctx, chunks } = makeCtx();
      await tool("canvas_design_guide").execute({ section }, ctx);
      const { isError, content } = lastResult(chunks);
      expect(isError).toBe(false);
      expect(content).toContain(marker);
    }
  });

  test("an unknown section is a schema error", async () => {
    const { ctx, chunks } = makeCtx();
    await tool("canvas_design_guide").execute({ section: "vibes" }, ctx);
    expect(lastResult(chunks).isError).toBe(true);
  });
});

describe("slugifyTitle", () => {
  test("kebabs, trims, caps, and never returns empty", () => {
    expect(slugifyTitle("Run Report: Q3 (final)")).toBe("run-report-q3-final");
    expect(slugifyTitle("   ---   ")).toBe("artifact");
    expect(slugifyTitle("x".repeat(100)).length).toBeLessThanOrEqual(64);
  });
});
