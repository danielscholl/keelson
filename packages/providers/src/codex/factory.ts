// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexRawEvent } from "./event-bridge.ts";

// Codex sandbox + reasoning literals, mirrored from @openai/codex-sdk so the
// provider's public options don't leak an SDK type. Kept identical to the SDK's
// SandboxMode / ModelReasoningEffort unions; the real factory passes them
// straight through, where tsc checks the assignment.
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CodexCreateThreadParams {
  cwd: string;
  // Resolved by the provider (defaults to workspace-write); always set.
  sandboxMode: CodexSandboxMode;
  networkAccessEnabled: boolean;
  // "gpt-5.6-sol" etc. Omitted → codex uses its own ~/.codex default.
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  // Codex thread id from a prior turn (persisted in ~/.codex/sessions).
  resumeSessionId?: string;
}

// The slice of a codex-sdk Thread the provider drives. The real factory adapts
// the SDK; tests supply a fake that yields scripted events.
export interface CodexThread {
  // Runs one turn and resolves with the raw event stream for that turn. The
  // AbortSignal cancels the underlying codex subprocess.
  runStreamed(input: string, signal: AbortSignal): Promise<AsyncIterable<CodexRawEvent>>;
}

export interface CodexThreadFactory {
  createThread(params: CodexCreateThreadParams): Promise<CodexThread>;
}

// Default factory: drives the real codex-sdk. The SDK is lazy-imported inside
// createThread so a missing or broken codex install never crashes unrelated
// commands, and so the SDK's per-platform native-binary resolution (which keys
// off its own module path) only runs when a turn actually executes. This
// adapter is the one seam with no unit coverage: it is written against
// codex-sdk 0.139.0 but the SDK-call path is not exercised live (that needs
// real codex credentials).
export class CodexAgentThreadFactory implements CodexThreadFactory {
  async createThread(params: CodexCreateThreadParams): Promise<CodexThread> {
    const sdk = await import("@openai/codex-sdk");
    // No apiKey/env passed: the spawned `codex` CLI inherits process.env and
    // reads its own ~/.codex/auth.json or OPENAI_API_KEY, like a terminal run.
    const codex = new sdk.Codex();
    const threadOptions = {
      workingDirectory: params.cwd,
      skipGitRepoCheck: true,
      sandboxMode: params.sandboxMode,
      // keelson has no interactive approval surface for codex's own tool calls;
      // the sandbox is the boundary, so run non-interactively.
      approvalPolicy: "never" as const,
      networkAccessEnabled: params.networkAccessEnabled,
      ...(params.model ? { model: params.model } : {}),
      ...(params.reasoningEffort ? { modelReasoningEffort: params.reasoningEffort } : {}),
    };
    const thread = params.resumeSessionId
      ? codex.resumeThread(params.resumeSessionId, threadOptions)
      : codex.startThread(threadOptions);
    return {
      async runStreamed(input, signal): Promise<AsyncIterable<CodexRawEvent>> {
        const { events } = await thread.runStreamed(input, { signal });
        return events as AsyncIterable<CodexRawEvent>;
      },
    };
  }
}

// Env keys the codex CLI reads for a metered key (in addition to a stored
// ~/.codex/auth.json from `codex login`). A subset — enough to report that
// *some* credential is present for the doctor hint; codex owns resolution.
const CODEX_ENV_VARS = ["CODEX_API_KEY", "OPENAI_API_KEY"] as const;

export interface CodexAuthStatus {
  authenticated: boolean;
  source?: "auth.json" | "env";
}

export interface CheckCodexAuthOptions {
  env?: NodeJS.ProcessEnv;
  // Defaults to ~/.codex/auth.json; overridable so tests stay hermetic.
  authFile?: string;
}

// Self-managed auth: codex reads ~/.codex/auth.json (`codex login`) and an
// OPENAI_API_KEY / CODEX_API_KEY env key. We only report presence for `keelson
// doctor`; codex owns the credential flow. Pure over the filesystem + env so it
// is testable.
export function checkCodexAuth(opts: CheckCodexAuthOptions = {}): CodexAuthStatus {
  const env = opts.env ?? process.env;
  const authFile = opts.authFile ?? join(homedir(), ".codex", "auth.json");
  if (existsSync(authFile)) return { authenticated: true, source: "auth.json" };
  for (const name of CODEX_ENV_VARS) {
    if (env[name]?.trim()) return { authenticated: true, source: "env" };
  }
  return { authenticated: false };
}
