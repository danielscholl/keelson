// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import type { SandboxMode, SandboxSupport } from "@keelson/shared";
import type { ServerSandboxConfig } from "../src/http/chat-client.ts";
import {
  footerSandbox,
  initialSandboxState,
  runSandboxCommand,
  type SandboxSessionState,
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
    config?: ServerSandboxConfig;
    session?: Partial<SandboxSessionState>;
    support?: SandboxSupport;
    busy?: boolean;
  } = {},
) {
  const config = opts.config ?? OFF;
  const session: SandboxSessionState = {
    providerId: "copilot",
    ...initialSandboxState(config, undefined, undefined),
    ...opts.session,
  };
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
        patches.push({ id, mode });
      },
      onChange: () => changes++,
      info: (l) => info.push(l),
      warn: (l) => warn.push(l),
    });
  return { session, config, patches, info, warn, run, changes: () => changes };
}

describe("/sandbox", () => {
  test("on sets the session, updates the footer, and PATCHes the open conversation", async () => {
    const h = harness({ session: { conversationId: "c1" } });
    await h.run("on");
    expect(h.session.sandbox).toBe(true);
    expect(h.patches).toEqual([{ id: "c1", mode: "on" }]);
    expect(h.changes()).toBe(1);
    expect(footerSandbox(h.session, h.config)).toBe("on");
    expect(h.warn).toEqual([]);
  });

  test("without a conversation the choice rides the next frame and nothing is PATCHed", async () => {
    const h = harness();
    await h.run("on");
    expect(h.session).toMatchObject({ sandbox: true, sandboxChosen: true });
    expect(h.patches).toEqual([]);
  });

  test("off is refused while KEELSON_SANDBOX=required holds the floor", async () => {
    const h = harness({ config: REQUIRED, session: { conversationId: "c1" } });
    await h.run("off");
    expect(h.session.sandbox).toBe(true);
    expect(h.patches).toEqual([]);
    expect(h.warn[0]).toContain("KEELSON_SANDBOX=required holds the sandbox on");
    expect(footerSandbox(h.session, h.config)).toBe("required");
  });

  test("on warns at once when the provider cannot sandbox", async () => {
    const h = harness({ support: "none" });
    await h.run("on");
    expect(h.session.sandbox).toBe(true);
    expect(h.warn[0]).toContain("copilot cannot sandbox its tools");
    expect(h.warn[0]).toContain("switch to a provider that can sandbox");
  });

  test("is blocked while a turn streams", async () => {
    const h = harness({ busy: true, session: { conversationId: "c1" } });
    await h.run("on");
    expect(h.session.sandbox).toBe(false);
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

  test("an unknown argument prints the usage", async () => {
    const h = harness();
    await h.run("sometimes");
    expect(h.warn).toEqual(["usage: /sandbox [on|off|status]"]);
  });
});

describe("initialSandboxState", () => {
  test("the hydrated conversation wins over the default, and a flag wins over both", () => {
    expect(initialSandboxState({ ...OFF, default: true }, "off", undefined)).toEqual({
      sandbox: false,
      sandboxChosen: false,
      sandboxConversation: "off",
    });
    expect(initialSandboxState(OFF, "off", true)).toMatchObject({
      sandbox: true,
      sandboxChosen: true,
    });
    expect(initialSandboxState(REQUIRED, "off", false).sandbox).toBe(true);
  });
});
