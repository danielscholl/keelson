// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  describeSandboxStatus,
  resolveClientSandbox,
  SANDBOX_LOCKED_MESSAGE,
  type SandboxMode,
  type SandboxResolution,
  type SandboxSupport,
  sandboxUnsupportedWarning,
} from "@keelson/shared";
import type { ServerSandboxConfig } from "../http/chat-client.ts";
import { parseSandboxArg } from "./format.ts";

// Nothing here picks a value on the user's behalf: with no choice and no saved
// row, the frame carries no `sandbox` and the server's own default applies.
export interface SandboxSessionState {
  providerId: string;
  conversationId?: string;
  // A choice no row holds yet: `--sandbox`, or `/sandbox` before the
  // conversation exists. The only sandbox value a frame or create carries.
  sandboxChoice?: boolean;
  // `--sandbox` / `--no-sandbox`, which applies again to every new conversation.
  sandboxFlag?: boolean;
  // The conversation's saved choice.
  sandboxConversation?: SandboxMode;
}

const pendingSaves = new WeakMap<SandboxSessionState, Promise<void>>();

export interface SandboxCommandDeps {
  session: SandboxSessionState;
  // Undefined when /api/config could not be read.
  config: ServerSandboxConfig | undefined;
  busy: () => boolean;
  supportFor: (providerId: string) => SandboxSupport;
  patchConversation: (id: string, mode: SandboxMode) => Promise<unknown>;
  onChange: () => void;
  info: (line: string) => void;
  warn: (line: string) => void;
}

export function initialSandboxState(
  conversation: SandboxMode | undefined,
  flag: boolean | undefined,
): Pick<SandboxSessionState, "sandboxChoice" | "sandboxFlag" | "sandboxConversation"> {
  return {
    ...(flag !== undefined ? { sandboxChoice: flag, sandboxFlag: flag } : {}),
    ...(conversation !== undefined ? { sandboxConversation: conversation } : {}),
  };
}

// Undefined when the outcome rests on a server default this session cannot see.
export function sessionSandboxResolution(
  session: SandboxSessionState,
  config: ServerSandboxConfig | undefined,
): SandboxResolution | undefined {
  return resolveClientSandbox({
    ...(session.sandboxChoice !== undefined ? { choice: session.sandboxChoice } : {}),
    ...(session.sandboxConversation !== undefined
      ? { conversation: session.sandboxConversation }
      : {}),
    ...(config !== undefined ? { policy: config } : {}),
  });
}

// Leaving a conversation drops its choice, as the SPA does: the next one starts
// from `--sandbox`, else the server default, not from the row just left.
export function leaveConversationSandbox(session: SandboxSessionState): void {
  delete session.sandboxConversation;
  if (session.sandboxFlag !== undefined) session.sandboxChoice = session.sandboxFlag;
  else delete session.sandboxChoice;
}

// The pump's create carried any pending choice, so the row now holds it.
export function adoptCreatedConversationSandbox(
  session: SandboxSessionState,
  saved: SandboxMode | undefined,
): void {
  const pending = session.sandboxChoice;
  const mode = saved ?? (pending !== undefined ? (pending ? "on" : "off") : undefined);
  if (mode !== undefined) session.sandboxConversation = mode;
  delete session.sandboxChoice;
}

export function footerSandbox(
  session: SandboxSessionState,
  config: ServerSandboxConfig | undefined,
): "on" | "required" | undefined {
  if (config?.floor) return "required";
  return sessionSandboxResolution(session, config)?.enabled ? "on" : undefined;
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
    const resolution = sessionSandboxResolution(session, config);
    // The server's runtime and profile, not this process's: the server runs the turn.
    for (const line of describeSandboxStatus({
      ...(resolution !== undefined ? { resolution } : {}),
      providerId: session.providerId,
      support,
      platform: config?.platform ?? process.platform,
      profile: config?.profile ?? config?.summary ?? "unavailable",
      ...(config?.runtime !== undefined ? { runtime: config.runtime } : {}),
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
  if (!wanted && config?.floor) {
    deps.warn(SANDBOX_LOCKED_MESSAGE);
    return;
  }
  // Pending until a row saves it; the next frame carries it either way.
  session.sandboxChoice = wanted;
  deps.onChange();
  const id = session.conversationId;
  if (id !== undefined) {
    const mode: SandboxMode = wanted ? "on" : "off";
    // The slash dispatcher does not await handlers, so saves are chained to
    // land in the order they were asked for.
    const save = (pendingSaves.get(session) ?? Promise.resolve()).then(async () => {
      try {
        await deps.patchConversation(id, mode);
        // A save that lands after the session left the row must not touch the
        // state of the conversation it is on now.
        if (session.conversationId !== id) return;
        session.sandboxConversation = mode;
        if (session.sandboxChoice === wanted) delete session.sandboxChoice;
      } catch (err) {
        deps.warn(
          `✗ saving the sandbox choice: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    pendingSaves.set(session, save);
    await save;
  }
  deps.info(`sandbox → ${parsed}`);
  const unsupported = wanted ? sandboxUnsupportedWarning(session.providerId, support) : undefined;
  if (unsupported !== undefined) deps.warn(unsupported);
}
