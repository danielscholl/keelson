// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderHuman } from "../src/output.ts";
import { spawnEnv } from "./spawn-env.ts";

const NODE_COUNT = 41;
const OUTPUT_LENGTH = 7_500;

interface NodePayload {
  nodeId: string;
  status: "succeeded";
  outputText: string;
}

interface RunPayload {
  runId: string;
  status: "succeeded";
  nodes: NodePayload[];
}

function createPayload(): RunPayload {
  return {
    runId: "run-large-output",
    status: "succeeded",
    nodes: Array.from({ length: NODE_COUNT }, (_, index) => ({
      nodeId: `node-${index.toString().padStart(2, "0")}`,
      status: "succeeded",
      outputText: "x".repeat(OUTPUT_LENGTH),
    })),
  };
}

async function exitWithin(
  proc: { exited: Promise<number>; kill(): void },
  timeoutMs = 5_000,
): Promise<number> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (timedOut) throw new Error(`subprocess did not exit within ${timeoutMs}ms`);
  return exitCode;
}

describe("emit pipe flushing", () => {
  let fixtureDir = "";
  let producerPath = "";
  let slowReaderPath = "";

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "keelson-output-flush-"));
    producerPath = join(fixtureDir, "producer.ts");
    slowReaderPath = join(fixtureDir, "slow-reader.ts");

    const outputModule = pathToFileURL(resolve(import.meta.dir, "..", "src", "output.ts")).href;
    writeFileSync(
      producerPath,
      [
        `import { emit } from ${JSON.stringify(outputModule)};`,
        `const nodes = Array.from({ length: ${NODE_COUNT} }, (_, index) => ({`,
        '  nodeId: `node-${index.toString().padStart(2, "0")}`,',
        '  status: "succeeded",',
        `  outputText: "x".repeat(${OUTPUT_LENGTH}),`,
        "}));",
        'emit({ data: { runId: "run-large-output", status: "succeeded", nodes } }, {',
        '  json: process.argv[2] === "json",',
        "});",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      slowReaderPath,
      [
        'import { writeSync } from "node:fs";',
        "for await (const chunk of Bun.stdin.stream()) {",
        "  await Bun.sleep(2);",
        "  let offset = 0;",
        "  while (offset < chunk.length) {",
        "    offset += writeSync(1, chunk, offset, chunk.length - offset);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("writes complete JSON through a pipe before immediate exit", async () => {
    const expected = `${JSON.stringify({ ok: true, data: createPayload() })}\n`;
    const expectedBytes = Buffer.byteLength(expected);
    expect(expectedBytes).toBeGreaterThan(65_536);

    const proc = Bun.spawn(["bun", producerPath, "json"], {
      stdout: "pipe",
      stderr: "pipe",
      env: spawnEnv(),
    });
    const [outputBuffer, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      exitWithin(proc),
    ]);
    const output = Buffer.from(outputBuffer).toString("utf8");

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(Buffer.byteLength(output)).toBe(expectedBytes);

    const parsed = JSON.parse(output) as { ok: boolean; data: RunPayload };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.nodes).toHaveLength(NODE_COUNT);
    for (const [index, node] of parsed.data.nodes.entries()) {
      expect(node.nodeId).toBe(`node-${index.toString().padStart(2, "0")}`);
      expect(node.outputText).toHaveLength(OUTPUT_LENGTH);
    }
  });

  test("writes complete human output through a pipe before immediate exit", async () => {
    const expected = `${renderHuman(createPayload())}\n`;
    const expectedBytes = Buffer.byteLength(expected);
    expect(expectedBytes).toBeGreaterThan(65_536);

    const proc = Bun.spawn(["bun", producerPath, "human"], {
      stdout: "pipe",
      stderr: "pipe",
      env: spawnEnv(),
    });
    const [outputBuffer, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      exitWithin(proc),
    ]);
    const output = Buffer.from(outputBuffer).toString("utf8");

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(Buffer.byteLength(output)).toBe(expectedBytes);
    expect(output.match(/^\s+- nodeId: /gm)).toHaveLength(NODE_COUNT);
    for (let index = 0; index < NODE_COUNT; index += 1) {
      expect(output).toContain(`nodeId: node-${index.toString().padStart(2, "0")}`);
    }
  });

  test("finishes writing when a pipe reader is slow", async () => {
    const expectedBytes = Buffer.byteLength(`${renderHuman(createPayload())}\n`);
    const pipeline = Bun.spawn(
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        'bun "$1" human | bun "$2"',
        "bash",
        producerPath,
        slowReaderPath,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: spawnEnv(),
      },
    );
    const [outputBuffer, stderr, exitCode] = await Promise.all([
      new Response(pipeline.stdout).arrayBuffer(),
      new Response(pipeline.stderr).text(),
      exitWithin(pipeline),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(outputBuffer.byteLength).toBe(expectedBytes);
  });

  test("exits cleanly when a pipe reader closes early", async () => {
    const pipeline = Bun.spawn(
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        'bun "$1" json | head -c 1 >/dev/null',
        "bash",
        producerPath,
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
        env: spawnEnv(),
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(pipeline.stderr).text(),
      exitWithin(pipeline),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });
});
