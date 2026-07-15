import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  inferToolFamily,
  type MessageChunk,
  type ToolContext,
  type ToolDefinition,
  toolPresentation,
} from "../src/tools.ts";

describe("ToolDefinition contract", () => {
  it("constructs with a zod-validated input schema", () => {
    const inputSchema = z.object({ path: z.string() }).strict();
    const tool: ToolDefinition = {
      name: "read_file",
      description: "Read a file from disk.",
      inputSchema,
      async execute(input, ctx) {
        const { path } = inputSchema.parse(input);
        ctx.emit({ type: "text", content: `read ${path}` });
      },
    };
    expect(tool.name).toBe("read_file");
    expect(tool.inputSchema).toBe(inputSchema);
  });

  it("accepts any ZodTypeAny for inputSchema", () => {
    const schemas: z.ZodTypeAny[] = [
      z.object({}).strict(),
      z.string(),
      z.number(),
      z.union([z.literal("a"), z.literal("b")]),
      z.array(z.string()),
    ];
    for (const inputSchema of schemas) {
      const tool: ToolDefinition = {
        name: "noop",
        description: "noop",
        inputSchema,
        async execute() {},
      };
      expect(tool.inputSchema).toBe(inputSchema);
    }
  });

  it("rejects malformed input via the tool's own schema.parse", () => {
    const inputSchema = z.object({ persona: z.enum(["shipper", "operator"]) });
    expect(() => inputSchema.parse({ persona: "wrong" })).toThrow();
    expect(() => inputSchema.parse({})).toThrow();
    expect(inputSchema.parse({ persona: "shipper" }).persona).toBe("shipper");
  });

  it("execute streams MessageChunks via ctx.emit and resolves to void", async () => {
    const emitted: MessageChunk[] = [];
    const ctx: ToolContext = {
      cwd: "/tmp/workspace",
      emit: (chunk) => emitted.push(chunk),
      abortSignal: new AbortController().signal,
    };
    const tool: ToolDefinition = {
      name: "echo",
      description: "echo",
      inputSchema: z.object({ msg: z.string() }),
      async execute(input, ctx) {
        const parsed = (this as { inputSchema: z.ZodTypeAny }).inputSchema.parse(input) as {
          msg: string;
        };
        ctx.emit({
          type: "tool_use",
          id: "call_1",
          toolName: "echo",
          toolInput: { msg: parsed.msg },
        });
        ctx.emit({
          type: "tool_result",
          toolUseId: "call_1",
          content: parsed.msg,
        });
      },
    };

    const result = await tool.execute({ msg: "hi" }, ctx);
    expect(result).toBeUndefined();
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.type).toBe("tool_use");
    expect(emitted[1]?.type).toBe("tool_result");
  });

  it("ctx.abortSignal carries an AbortSignal", () => {
    const controller = new AbortController();
    const ctx: ToolContext = {
      cwd: "/tmp",
      emit: () => {},
      abortSignal: controller.signal,
    };
    expect(ctx.abortSignal.aborted).toBe(false);
    controller.abort();
    expect(ctx.abortSignal.aborted).toBe(true);
  });

  it("accepts opaque turn context and leaves it undefined when omitted", () => {
    const turnContext = { room: "alpha" } as const;
    const withContext: ToolContext = {
      cwd: "/tmp",
      emit: () => {},
      abortSignal: new AbortController().signal,
      turnContext,
    };
    const withoutContext: ToolContext = {
      cwd: "/tmp",
      emit: () => {},
      abortSignal: new AbortController().signal,
    };

    expect(withContext.turnContext).toBe(turnContext);
    expect(withoutContext.turnContext).toBeUndefined();
  });
});

describe("inferToolFamily", () => {
  it("returns the substring before the first underscore", () => {
    expect(inferToolFamily("kube_get")).toBe("kube");
    expect(inferToolFamily("kube_apply_manifest")).toBe("kube");
    expect(inferToolFamily("fs_read")).toBe("fs");
  });

  it("classifies unprefixed tools as other", () => {
    expect(inferToolFamily("rg")).toBe("other");
    expect(inferToolFamily("view")).toBe("other");
  });

  it("handles empty and edge-case names defensively", () => {
    expect(inferToolFamily("")).toBe("other");
    expect(inferToolFamily("noprefix")).toBe("other");
    // Leading underscore — first index is 0, falls through to `other`.
    expect(inferToolFamily("_hidden")).toBe("other");
  });
});

describe("toolPresentation", () => {
  it("maps cross-provider shell names to a $ marker and the command", () => {
    for (const name of ["bash", "shell", "powershell", "pwsh"]) {
      const p = toolPresentation(name, { command: "ls -la" });
      expect(p.kind).toBe("shell");
      expect(p.marker).toBe("$");
      expect(p.primary).toBe("ls -la");
    }
  });

  it("carries a shell description through for recognized kinds", () => {
    const p = toolPresentation("powershell", {
      command: "bun keelson.ts project list",
      description: "List registered projects",
    });
    expect(p.description).toBe("List registered projects");
  });

  it("classifies read/edit/search/web and extracts the salient field", () => {
    expect(toolPresentation("read_file", { path: "/a.txt" })).toMatchObject({
      kind: "read",
      marker: "read",
      primary: "/a.txt",
    });
    expect(toolPresentation("str_replace_editor", { path: "/b.ts" })).toMatchObject({
      kind: "edit",
      marker: "edit",
      primary: "/b.ts",
    });
    expect(toolPresentation("grep", { pattern: "foo" })).toMatchObject({
      kind: "search",
      marker: "search",
      primary: "foo",
    });
    expect(toolPresentation("web_fetch", { url: "https://example.com" })).toMatchObject({
      kind: "web",
      marker: "web",
      primary: "https://example.com",
    });
  });

  it("is case-insensitive on the tool name (Claude's Bash, Read)", () => {
    expect(toolPresentation("Bash", { command: "ls" }).kind).toBe("shell");
    expect(toolPresentation("Read", { path: "/a" }).kind).toBe("read");
  });

  it("falls back to a tool kind with the raw name as marker and no description", () => {
    const p = toolPresentation("osdu_search", { query: "wells", description: "ignored" });
    expect(p.kind).toBe("tool");
    expect(p.marker).toBe("osdu_search");
    expect(p.primary).toBeUndefined();
    expect(p.description).toBeUndefined();
  });

  it("omits primary when no known field is present", () => {
    const p = toolPresentation("bash", { foo: "bar" });
    expect(p.kind).toBe("shell");
    expect(p.primary).toBeUndefined();
  });
});
