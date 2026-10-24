// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, normalize } from "node:path";
import {
  type ProviderCapabilities,
  registerProvider,
  type SendQueryOptions,
} from "@keelson/providers";
import {
  type ChatFrame,
  type ClientFrame,
  type PolicyContext,
  type SandboxSupport,
  WIRE_PROTOCOL_VERSION,
} from "@keelson/shared";
import { resolveSandboxConfig } from "@keelson/shared/config";
import { hostGitConfigPaths } from "@keelson/workflows";
import { z } from "zod";
import { handleChatRequest } from "../src/chat-handler.ts";
import { type ConversationStore, createConversationStore } from "../src/conversation-store.ts";
import { openDatabase } from "../src/db/init.ts";
import { createPolicyEngine } from "../src/policy-engine.ts";
import { createProjectsStore } from "../src/projects-store.ts";

let providerSeq = 0;

// Registers a provider under a fresh id that records each sendQuery's options.
function recordingProvider(support: SandboxSupport | undefined): {
  id: string;
  calls: SendQueryOptions[];
} {
  const id = `sandbox-rec-${++providerSeq}`;
  const calls: SendQueryOptions[] = [];
  const capabilities: ProviderCapabilities = {
    sessionResume: false,
    streaming: true,
    tools: false,
    reasoningEffort: false,
    models: ["m"],
    defaultModel: "m",
    ...(support !== undefined ? { sandbox: support } : {}),
  };
  registerProvider({
    id,
    displayName: id,
    builtIn: false,
    capabilities,
    factory: () => ({
      getType: () => "recording",
      getCapabilities: () => capabilities,
      listModels: async () => [{ id: "m" }],
      async *sendQuery(_prompt, _cwd, _resume, options) {
        calls.push(options ?? {});
        yield { type: "text", content: "ok" };
      },
    }),
  });
  return { id, calls };
}

function frame(conversationId: string, providerId: string, sandbox?: boolean): ClientFrame {
  return {
    version: WIRE_PROTOCOL_VERSION,
    conversationId,
    message: {
      type: "request",
      providerId,
      prompt: "hello",
      ...(sandbox !== undefined ? { sandbox } : {}),
    },
  };
}

function makeStore(): ConversationStore {
  return createConversationStore(openDatabase({ path: ":memory:" }));
}

async function run(
  store: ConversationStore,
  f: ClientFrame,
  extra: Partial<Parameters<typeof handleChatRequest>[1]> = {},
): Promise<ChatFrame[]> {
  const sent: ChatFrame[] = [];
  await handleChatRequest(f, {
    store,
    send: (out) => sent.push(out),
    abortSignal: new AbortController().signal,
    // Off unless a test says otherwise, so each case states what it turns on.
    sandbox: resolveSandboxConfig({ sandbox: { default: false } }, {}),
    ...extra,
  });
  return sent;
}

describe("chat sandbox resolution", () => {
  test("a frame turning the sandbox on builds a profile with the real cwd and mirrors it", async () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-chat-sandbox-"));
    // A directory symlink proves the cwd is canonicalized; Windows cannot
    // remove one reliably, so it uses the directory itself.
    const link = process.platform === "win32" ? root : `${root}-link`;
    if (link !== root) symlinkSync(root, link);
    try {
      const db = openDatabase({ path: ":memory:" });
      const store = createConversationStore(db);
      const projects = createProjectsStore(db);
      const project = projects.create({ name: "linked", rootPath: link });
      const provider = recordingProvider("native");
      const conv = store.create({ providerId: provider.id, projectId: project.id });
      const scratch = join(tmpdir(), "keelson-chat-sandbox-grant");

      await run(store, frame(conv.id, provider.id, true), {
        projectsStore: projects,
        sandbox: resolveSandboxConfig({ sandbox: { filesystem: { readwrite: [scratch] } } }, {}),
      });

      const profile = provider.calls[0]?.sandbox;
      expect(profile?.enabled).toBe(true);
      expect(profile?.filesystem.readwrite).toEqual([realpathSync(root), normalize(scratch)]);
      expect(store.get(conv.id)?.sandbox).toBe("on");
    } finally {
      if (link !== root) rmSync(link, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("on by default: with no frame and no conversation choice the config default applies", async () => {
    const store = makeStore();
    const provider = recordingProvider("native");
    const conv = store.create({ providerId: provider.id });
    await run(store, frame(conv.id, provider.id), { sandbox: resolveSandboxConfig({}, {}) });
    expect(provider.calls[0]?.sandbox?.enabled).toBe(true);
    expect(store.get(conv.id)?.sandbox).toBeUndefined();
  });

  test("sandbox.default: false passes no profile when nothing else speaks", async () => {
    const store = makeStore();
    const provider = recordingProvider("native");
    const conv = store.create({ providerId: provider.id });
    await run(store, frame(conv.id, provider.id));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.sandbox).toBeUndefined();
    expect(store.get(conv.id)?.sandbox).toBeUndefined();
  });

  test("a provider with nothing to confine runs a sandboxed turn without a profile", async () => {
    const store = makeStore();
    const provider = recordingProvider("unneeded");
    const conv = store.create({ providerId: provider.id });
    const sent = await run(store, frame(conv.id, provider.id, true));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.sandbox).toBeUndefined();
    expect(sent.some((f) => f.event.type === "error")).toBe(false);
  });

  test("the conversation's choice applies when the frame is silent", async () => {
    const store = makeStore();
    const provider = recordingProvider("native");
    const conv = store.create({ providerId: provider.id, sandbox: "on" });
    await run(store, frame(conv.id, provider.id));
    expect(provider.calls[0]?.sandbox?.enabled).toBe(true);
  });

  test("a provider that cannot sandbox fails the turn closed before sendQuery", async () => {
    const store = makeStore();
    const provider = recordingProvider(undefined);
    const conv = store.create({ providerId: provider.id });
    const sent = await run(store, frame(conv.id, provider.id, true));

    expect(provider.calls).toEqual([]);
    expect(sent.map((f) => f.event.type)).toEqual(["error", "done"]);
    const error = sent[0]?.event;
    expect(error?.type === "error" && error.code).toBe("SANDBOX_UNAVAILABLE");
    expect(error?.type === "error" && error.message).toContain(
      'turn it off for this conversation (sandbox: "off")',
    );
  });

  test("when the config default turned it on, the hint names the config key", async () => {
    const store = makeStore();
    const provider = recordingProvider(undefined);
    const conv = store.create({ providerId: provider.id });
    const sent = await run(store, frame(conv.id, provider.id), {
      sandbox: resolveSandboxConfig({ sandbox: { default: true } }, {}),
    });
    const error = sent[0]?.event;
    expect(error?.type === "error" && error.message).toContain(
      "set sandbox.default: false in config.json",
    );
  });

  test("an unsandboxable provider still runs when the sandbox is off", async () => {
    const store = makeStore();
    const provider = recordingProvider("none");
    const conv = store.create({ providerId: provider.id, sandbox: "on" });
    const sent = await run(store, frame(conv.id, provider.id, false));
    expect(provider.calls).toHaveLength(1);
    expect(sent.some((f) => f.event.type === "error")).toBe(false);
    expect(store.get(conv.id)?.sandbox).toBe("off");
  });

  test("KEELSON_SANDBOX=required keeps the turn sandboxed over a frame turning it off", async () => {
    const store = makeStore();
    const provider = recordingProvider("native");
    const conv = store.create({ providerId: provider.id });
    await run(store, frame(conv.id, provider.id, false), {
      sandbox: resolveSandboxConfig({}, { KEELSON_SANDBOX: "required" }),
    });
    expect(provider.calls[0]?.sandbox?.enabled).toBe(true);
  });

  test("under the floor an unsandboxable provider's error names the floor, not /sandbox off", async () => {
    const store = makeStore();
    const provider = recordingProvider("none");
    const conv = store.create({ providerId: provider.id });
    const sent = await run(store, frame(conv.id, provider.id), {
      sandbox: resolveSandboxConfig({}, { KEELSON_SANDBOX: "required" }),
    });
    const error = sent[0]?.event;
    expect(error?.type === "error" && error.code).toBe("SANDBOX_UNAVAILABLE");
    expect(error?.type === "error" && error.message).toContain("KEELSON_SANDBOX=required");
    expect(error?.type === "error" && error.message).not.toContain("/sandbox off");
  });

  test("a provider with tool support gets the host's sandboxed bash on a sandboxed turn only", async () => {
    const store = makeStore();
    const provider = recordingProvider("tool");
    const conv = store.create({ providerId: provider.id });
    const seenTurns: Array<{ cwd: string; conversationId: string }> = [];
    const sandboxBashTool = (turn: { cwd: string; conversationId: string }) => {
      seenTurns.push(turn);
      return {
        name: "bash",
        description: "sandboxed",
        inputSchema: z.object({ command: z.string() }),
        execute: async () => {},
      };
    };
    await run(store, frame(conv.id, provider.id, true), { sandboxBashTool });
    await run(store, frame(conv.id, provider.id, false), { sandboxBashTool });
    expect(provider.calls[0]?.tools?.filter((t) => t.name === "bash")).toHaveLength(1);
    expect(provider.calls[0]?.tools?.find((t) => t.name === "bash")?.description).toBe("sandboxed");
    expect(provider.calls[1]?.tools?.some((t) => t.name === "bash") ?? false).toBe(false);
    expect(seenTurns).toEqual([{ cwd: process.cwd(), conversationId: conv.id }]);
  });

  test("policy evaluation sees the sandbox decision and the writable roots", async () => {
    const seen: PolicyContext[] = [];
    const engine = createPolicyEngine({
      ribPolicies: [
        {
          ribId: "guard",
          policy: {
            id: "record",
            on: [{ phase: "request" }],
            evaluate(_event, ctx) {
              seen.push(ctx);
              return { outcome: "allow" };
            },
          },
        },
      ],
    });
    const store = makeStore();
    const provider = recordingProvider("native");
    const conv = store.create({ providerId: provider.id });

    await run(store, frame(conv.id, provider.id, true), { policyEngine: engine });
    await run(store, frame(conv.id, provider.id, false), { policyEngine: engine });

    // The user's git config is readable on any sandboxed turn that has one.
    const git = hostGitConfigPaths(homedir()).filter((p) => existsSync(p));
    expect(seen[0]?.sandbox).toEqual({ enabled: true, support: "native" });
    expect(seen[0]?.allowedDirectories).toEqual([realpathSync(process.cwd()), ...git]);
    expect(seen[1]?.sandbox).toEqual({ enabled: false, support: "native" });
    expect(seen[1]?.allowedDirectories).toBeUndefined();

    // Read-only grants pass the path gate too; the provider's sandbox keeps them unwritable.
    const tools = join(tmpdir(), "keelson-chat-readonly-tools");
    await run(store, frame(conv.id, provider.id, true), {
      policyEngine: engine,
      sandbox: resolveSandboxConfig({ sandbox: { filesystem: { readonly: [tools] } } }, {}),
    });
    expect(seen[2]?.allowedDirectories).toEqual([
      realpathSync(process.cwd()),
      normalize(tools),
      ...git,
    ]);
  });
});
