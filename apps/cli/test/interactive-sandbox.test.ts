// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { SandboxMode, SandboxSupport } from "@keelson/shared";
import type { ServerSandboxConfig } from "../src/http/chat-client.ts";
import {
  adoptCreatedConversationSandbox,
  footerSandbox,
  initialSandboxState,
  leaveConversationSandbox,
  runSandboxCommand,
  type SandboxSessionState,
  sessionSandboxResolution,
} from "../src/interactive/sandbox.ts";

const OFF: ServerSandboxConfig = {
  default: false,
  floor: false,
  summary: "sandbox off",
  profile: "writes <project> · network outbound denied · no extra env",
  runtime: "seatbelt via /x/mxc-exec-mac",
  platform: "darwin",
};
const REQUIRED: ServerSandboxConfig = {
  ...OFF,
  floor: true,
  summary: "sandbox on · writes <project> · network outbound denied (required by KEELSON_SANDBOX)",
};

function harness(
  opts: {
    config?: ServerSandboxConfig | null;
    session?: Partial<SandboxSessionState>;
    support?: SandboxSupport;
    busy?: boolean;
    patchFails?: boolean;
  } = {},
) {
  const config = opts.config === null ? undefined : (opts.config ?? OFF);
  const session: SandboxSessionState = { providerId: "copilot", ...opts.session };
  const patches: { id: string; mode: SandboxMode }[] = [];
  const info: string[] = [];
  const warn: string[] = [];
  let changes = 0;
  const run = (arg: string) =>
    runSandboxCommand(arg, {
      session,
      config,
      busy: () => opts.busy === true,
      supportFor: () => opts.support ?? "native",
      patchConversation: async (id, mode) => {
        if (opts.patchFails) throw new Error("server said no");
        patches.push({ id, mode });
      },
      onChange: () => changes++,
      info: (l) => info.push(l),
      warn: (l) => warn.push(l),
    });
  const enabled = () => sessionSandboxResolution(session, config)?.enabled;
  return { session, config, patches, info, warn, run, enabled, changes: () => changes };
}

describe("/sandbox", () => {
  test("on saves the choice on the open conversation and updates the footer", async () => {
    const h = harness({ session: { conversationId: "c1" } });
    await h.run("on");
    expect(h.patches).toEqual([{ id: "c1", mode: "on" }]);
    expect(h.session).toMatchObject({ sandboxConversation: "on" });
    expect(h.session.sandboxChoice).toBeUndefined();
    expect(h.changes()).toBe(1);
    expect(footerSandbox(h.session, h.config)).toBe("on");
    expect(h.warn).toEqual([]);
  });

  test("without a conversation the choice is pending and rides the next frame", async () => {
    const h = harness();
    await h.run("on");
    expect(h.session.sandboxChoice).toBe(true);
    expect(h.patches).toEqual([]);
  });

  test("a failed save keeps the choice pending, so the next frame still carries it", async () => {
    const h = harness({ session: { conversationId: "c1" }, patchFails: true });
    await h.run("on");
    expect(h.session.sandboxChoice).toBe(true);
    expect(h.enabled()).toBe(true);
    expect(h.warn[0]).toContain("saving the sandbox choice: server said no");
  });

  test("off is refused while KEELSON_SANDBOX=required holds the floor", async () => {
    const h = harness({ config: REQUIRED, session: { conversationId: "c1" } });
    await h.run("off");
    expect(h.session.sandboxChoice).toBeUndefined();
    expect(h.patches).toEqual([]);
    expect(h.warn[0]).toContain("KEELSON_SANDBOX=required holds the sandbox on");
    expect(footerSandbox(h.session, h.config)).toBe("required");
  });

  test("on warns at once when the provider cannot sandbox", async () => {
    const h = harness({ support: "none" });
    await h.run("on");
    expect(h.warn[0]).toContain("copilot cannot sandbox its tools");
    expect(h.warn[0]).toContain("switch to a provider that can sandbox");
  });

  test("is blocked while a turn streams", async () => {
    const h = harness({ busy: true, session: { conversationId: "c1" } });
    await h.run("on");
    expect(h.session.sandboxChoice).toBeUndefined();
    expect(h.patches).toEqual([]);
    expect(h.warn).toEqual(["finish the current turn before changing the sandbox"]);
  });

  test("status prints the source, the provider backend, and the server's runtime and profile", async () => {
    const h = harness({ config: REQUIRED });
    await h.run("status");
    expect(h.info).toEqual([
      "sandbox: on (required by KEELSON_SANDBOX=required)",
      "provider: Copilot CLI sandbox (Seatbelt)",
      "runtime: seatbelt via /x/mxc-exec-mac",
      "profile: writes <project> · network outbound denied · no extra env",
    ]);
  });

  test("status names the open conversation once /sandbox saved the choice there", async () => {
    const h = harness({ session: { conversationId: "c1" } });
    await h.run("on");
    h.info.length = 0;
    await h.run("status");
    expect(h.info[0]).toBe("sandbox: on (saved on this conversation)");
  });

  test("an unknown argument prints the usage", async () => {
    const h = harness();
    await h.run("sometimes");
    expect(h.warn).toEqual(["usage: /sandbox [on|off|status]"]);
  });
});

describe("when /api/config could not be read", () => {
  test("nothing is chosen for the user: status says the server default applies", async () => {
    const h = harness({ config: null });
    expect(h.enabled()).toBeUndefined();
    expect(footerSandbox(h.session, h.config)).toBeUndefined();
    await h.run("status");
    expect(h.info[0]).toBe("sandbox: server default (its policy could not be read)");
  });

  test("a hydrated row or an explicit choice still resolves", async () => {
    expect(harness({ config: null, session: { sandboxConversation: "on" } }).enabled()).toBe(true);
    const h = harness({ config: null });
    await h.run("off");
    expect(h.enabled()).toBe(false);
  });
});

describe("initialSandboxState", () => {
  test("no flag and no row leaves nothing to send", () => {
    expect(initialSandboxState(undefined, undefined)).toEqual({});
  });

  test("the hydrated row is kept, and a flag is a pending choice over it", () => {
    expect(initialSandboxState("off", undefined)).toEqual({ sandboxConversation: "off" });
    expect(initialSandboxState("off", true)).toEqual({
      sandboxChoice: true,
      sandboxFlag: true,
      sandboxConversation: "off",
    });
  });

  test("the floor holds it on over --no-sandbox", () => {
    const session = { providerId: "copilot", ...initialSandboxState("off", false) };
    expect(sessionSandboxResolution(session, REQUIRED)?.enabled).toBe(true);
  });
});

describe("moving between conversations", () => {
  test("leaving a hydrated 'on' conversation drops back to the default, as the SPA does", async () => {
    const h = harness({
      session: { conversationId: "c1", ...initialSandboxState("on", undefined) },
    });
    expect(h.enabled()).toBe(true);
    leaveConversationSandbox(h.session);
    delete h.session.conversationId;
    expect(h.enabled()).toBe(false);
    expect(footerSandbox(h.session, h.config)).toBeUndefined();
    await h.run("status");
    expect(h.info[0]).toBe("sandbox: off (config default)");
  });

  test("--sandbox applies again to each new conversation; a /sandbox choice does not", async () => {
    const h = harness({
      session: { conversationId: "c1", ...initialSandboxState(undefined, true) },
    });
    await h.run("off");
    expect(h.enabled()).toBe(false);
    leaveConversationSandbox(h.session);
    expect(h.session.sandboxChoice).toBe(true);
  });

  test("the row the pump creates holds the pending choice, so status names the conversation", async () => {
    const h = harness();
    await h.run("on");
    h.session.conversationId = "c2";
    adoptCreatedConversationSandbox(h.session, "on");
    expect(h.session.sandboxChoice).toBeUndefined();
    h.info.length = 0;
    await h.run("status");
    expect(h.info[0]).toBe("sandbox: on (saved on this conversation)");
  });

  test("a row created with no choice stays unset, so it keeps following the default", () => {
    const h = harness();
    h.session.conversationId = "c3";
    adoptCreatedConversationSandbox(h.session, undefined);
    expect(h.session.sandboxConversation).toBeUndefined();
  });
});
