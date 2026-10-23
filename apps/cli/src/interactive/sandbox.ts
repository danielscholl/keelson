// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  describeSandboxStatus,
  resolveSandboxEnabled,
  SANDBOX_LOCKED_MESSAGE,
  type SandboxMode,
  type SandboxResolution,
  type SandboxSupport,
  sandboxUnsupportedWarning,
} from "@keelson/shared";
import type { ServerSandboxConfig } from "../http/chat-client.ts";
import { parseSandboxArg } from "./format.ts";

export interface SandboxSessionState {
  providerId: string;
  conversationId?: string;
  // What every turn's frame sends.
  sandbox: boolean;
  // True once `/sandbox` or `--sandbox` chose for this session.
  sandboxChosen: boolean;
  // The hydrated conversation's saved choice, for the status source.
  sandboxConversation?: SandboxMode;
}

export interface SandboxCommandDeps {
  session: SandboxSessionState;
  config: ServerSandboxConfig;
  busy: () => boolean;
  supportFor: (providerId: string) => SandboxSupport;
  patchConversation: (id: string, mode: SandboxMode) => Promise<unknown>;
  onChange: () => void;
  info: (line: string) => void;
  warn: (line: string) => void;
}

// What a session starts with: the floor, else the hydrated conversation, else
// the server default. `--sandbox/--no-sandbox` counts as a session choice.
export function initialSandboxState(
  config: ServerSandboxConfig,
  conversation: SandboxMode | undefined,
  flag: boolean | undefined,
): Pick<SandboxSessionState, "sandbox" | "sandboxChosen" | "sandboxConversation"> {
  const resolution = resolveSandboxEnabled({
    ...(flag !== undefined ? { frame: flag } : {}),
    ...(conversation !== undefined ? { conversation } : {}),
    configDefault: config.default,
    ...(config.floor ? { env: "required" } : {}),
  });
  return {
    sandbox: resolution.enabled,
    sandboxChosen: flag !== undefined,
    ...(conversation !== undefined ? { sandboxConversation: conversation } : {}),
  };
}

export function sessionSandboxResolution(
  session: SandboxSessionState,
  config: ServerSandboxConfig,
): SandboxResolution {
  return resolveSandboxEnabled({
    ...(session.sandboxChosen ? { frame: session.sandbox } : {}),
    ...(session.sandboxConversation !== undefined
      ? { conversation: session.sandboxConversation }
      : {}),
    configDefault: config.default,
    ...(config.floor ? { env: "required" } : {}),
  });
}

export function footerSandbox(
  session: SandboxSessionState,
  config: ServerSandboxConfig,
): "on" | "required" | undefined {
  if (config.floor) return "required";
  return session.sandbox ? "on" : undefined;
}

export async function runSandboxCommand(arg: string, deps: SandboxCommandDeps): Promise<void> {
  const { session, config } = deps;
  const parsed = parseSandboxArg(arg);
  if (parsed === null) {
    deps.warn("usage: /sandbox [on|off|status]");
    return;
  }
  const support = deps.supportFor(session.providerId);
  if (parsed === "status") {
    // The server's runtime and profile, not this process's: the server runs the turn.
    for (const line of describeSandboxStatus({
      resolution: sessionSandboxResolution(session, config),
      providerId: session.providerId,
      support,
      platform: config.platform ?? process.platform,
      profile: config.profile ?? config.summary,
      ...(config.runtime !== undefined ? { runtime: config.runtime } : {}),
    })) {
      deps.info(line);
    }
    return;
  }
  if (deps.busy()) {
    deps.warn("finish the current turn before changing the sandbox");
    return;
  }
  const wanted = parsed === "on";
  if (!wanted && config.floor) {
    deps.warn(SANDBOX_LOCKED_MESSAGE);
    return;
  }
  session.sandbox = wanted;
  session.sandboxChosen = true;
  deps.onChange();
  if (session.conversationId !== undefined) {
    try {
      await deps.patchConversation(session.conversationId, wanted ? "on" : "off");
      session.sandboxConversation = wanted ? "on" : "off";
    } catch (err) {
      deps.warn(`✗ saving the sandbox choice: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  deps.info(`sandbox → ${parsed}`);
  const unsupported = wanted ? sandboxUnsupportedWarning(session.providerId, support) : undefined;
  if (unsupported !== undefined) deps.warn(unsupported);
}
