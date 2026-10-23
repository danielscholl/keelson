// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PiRawEvent } from "./event-bridge.ts";
import {
  createPiGateExtension,
  type PiGenerationHooks,
  type PiToolGates,
} from "./gate-extension.ts";
import { filterPiTools } from "./tool-filter.ts";
import type { PiProjectedTool } from "./tool-projection.ts";

// pi's built-in coding tools, enabled together by `builtinTools`.
export const PI_BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

// The slice of a pi AgentSession the provider drives. The real factory adapts
// pi's session; tests supply a fake that emits scripted events.
export interface PiSession {
  // Register an event listener; returns an unsubscribe function.
  subscribe(listener: (event: PiRawEvent) => void): () => void;
  // Run one turn. Resolves when the turn is done; events fire via subscribe.
  prompt(text: string): Promise<void>;
  // "vendor/model" the session resolved (pi picks from its own settings when
  // no model was requested). Undefined when pi found no usable model.
  modelRef?: string;
  // Stop the active generation; resolves once the session is idle.
  abort?(): Promise<void>;
  // Release the session's listeners and extension runtime once the turn is over.
  dispose?(): void;
}

export interface PiCreateSessionParams {
  cwd: string;
  // "vendor/model" (e.g. "anthropic/claude-opus-5-5"). Omitted → pi picks from
  // its own settings/auth.
  model?: string;
  // Tried when `model` does not resolve (config `pi.model`), before pi's own
  // settings default.
  fallbackModel?: string;
  // Keelson tools projected to pi's custom-tool shape; they gate themselves.
  customTools?: readonly PiProjectedTool[];
  // Policy gates applied, through a pi extension, to every other tool.
  gates?: PiToolGates;
  // Enable pi's built-in coding tools (behind `gates`).
  builtinTools?: boolean;
  // Built-ins left out even when builtinTools is on (a sandboxed turn's bash).
  excludeBuiltinTools?: readonly string[];
  // Absolute pi extension paths to load (config `pi.extensions`). The
  // operator's own ~/.pi extensions, skills, and prompt templates never load.
  extensionPaths?: readonly string[];
  // Tools those extensions register that the session may call
  // (config `pi.extensionTools`); every other extension tool stays off.
  extensionTools?: readonly string[];
  // Default timeout for bash calls that set none (config `pi.bashTimeoutSec`).
  bashTimeoutSec?: number;
  // See PiGateOptions.generation.
  generation?: PiGenerationHooks;
  // config `pi.repeatCallLimit`; see PiGateOptions.
  repeatCallLimit?: number;
  // A workflow node's allowed_tools / denied_tools, applied to the built-in and
  // extension tools (keelson tools arrive already filtered).
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
}

export interface PiSessionFactory {
  createSession(params: PiCreateSessionParams): Promise<PiSession>;
}

// Per-vendor API-key env vars pi reads. A subset — pi supports many more; this
// list only needs to recognise that *some* credential is present for the doctor
// hint. pi owns the actual resolution.
const PI_VENDOR_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export interface PiAuthStatus {
  authenticated: boolean;
  source?: "auth.json" | "env";
}

export interface CheckPiAuthOptions {
  env?: NodeJS.ProcessEnv;
  // Defaults to ~/.pi/agent/auth.json; overridable so tests stay hermetic.
  authFile?: string;
}

// Self-managed auth: pi reads ~/.pi/agent/auth.json and per-vendor env keys.
// We only report presence for `keelson doctor`; pi owns the credential flow
// (its own `pi` login). Pure over the filesystem + env so it is testable.
export function checkPiAuth(opts: CheckPiAuthOptions = {}): PiAuthStatus {
  const env = opts.env ?? process.env;
  const authFile = opts.authFile ?? join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(authFile)) return { authenticated: true, source: "auth.json" };
  for (const name of PI_VENDOR_ENV_VARS) {
    if (env[name]?.trim()) return { authenticated: true, source: "env" };
  }
  return { authenticated: false };
}

// Default factory: drives the real pi SDK. The SDK is lazy-imported inside
// createSession so a missing or broken pi install never crashes unrelated
// commands, and so pi's own package.json self-read happens only when a turn
// actually runs. This adapter is the one seam with no unit coverage; it is
// written against pi 1.2.
export class PiAgentSessionFactory implements PiSessionFactory {
  async createSession(params: PiCreateSessionParams): Promise<PiSession> {
    const sdk = await import("@earendil-works/pi-coding-agent");
    // One runtime per turn so auth.json / models.json edits apply without a
    // server restart; the session resolves its default model from it too.
    const modelRuntime = await sdk.ModelRuntime.create();
    const model =
      (params.model ? await resolveModel(modelRuntime, params.model) : undefined) ??
      (params.fallbackModel ? await resolveModel(modelRuntime, params.fallbackModel) : undefined);
    const keelsonTools = params.customTools ?? [];
    const keelsonNames = new Set(keelsonTools.map((t) => t.name));
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: params.cwd,
      agentDir: sdk.getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: [...(params.extensionPaths ?? [])],
      extensionFactories: [
        {
          name: "keelson-gate",
          hidden: true,
          // `as never`: the gate is typed against a structural slice of pi's
          // ExtensionAPI.
          factory: createPiGateExtension(params.gates ?? {}, keelsonNames, {
            ...(params.bashTimeoutSec !== undefined
              ? { bashTimeoutSec: params.bashTimeoutSec }
              : {}),
            ...(params.repeatCallLimit !== undefined
              ? { repeatCallLimit: params.repeatCallLimit }
              : {}),
            ...(params.generation !== undefined ? { generation: params.generation } : {}),
          }) as never,
        },
      ],
    });
    await resourceLoader.reload();
    // The explicit allowlist is the whole tool surface: anything an extension
    // registers stays off unless config names it.
    const toolNames = [
      ...new Set([
        ...filterPiTools(
          [
            ...(params.builtinTools
              ? PI_BUILTIN_TOOL_NAMES.filter((t) => !params.excludeBuiltinTools?.includes(t))
              : []),
            ...(params.extensionTools ?? []),
          ],
          params.allowedTools,
          params.disallowedTools,
        ),
        ...keelsonNames,
      ]),
    ];
    const { session } = await sdk.createAgentSession({
      cwd: params.cwd,
      modelRuntime,
      resourceLoader,
      // keelson owns the transcript; every pi turn is fresh (sessionResume is
      // off), so pi's own session files would only pile up in ~/.pi.
      sessionManager: sdk.SessionManager.inMemory(),
      ...(toolNames.length > 0
        ? // `as never` is the same cast boundary as `model` below: the
          // projection is a structural slice of the SDK's ToolDefinition.
          { tools: toolNames, customTools: keelsonTools as never }
        : { noTools: "all" as const }),
      // `as never` is the cast boundary: resolveModel returns the SDK's Model
      // resolved from a string ref, which the strict generic signature can't see.
      ...(model !== undefined ? { model: model as never } : {}),
    });
    const resolved = session.model;
    return {
      subscribe: (listener) =>
        session.subscribe((event) => listener(event as unknown as PiRawEvent)),
      prompt: (text) => session.prompt(text),
      abort: () => session.abort(),
      dispose: () => session.dispose(),
      ...(resolved !== undefined ? { modelRef: `${resolved.provider}/${resolved.id}` } : {}),
    };
  }
}

// Resolve against pi's model runtime, which applies provider model hooks such
// as github-copilot's per-account baseUrl rewrite. An unresolvable ref
// returns undefined so the session falls back to pi's default model; the
// provider reports that swap to the user.
async function resolveModel(
  runtime: { getAvailable(): Promise<readonly { provider: string; id: string }[]> },
  ref: string,
): Promise<unknown | undefined> {
  const slash = ref.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  if (!modelId) return undefined;
  try {
    const available = await runtime.getAvailable();
    return available.find((m) => m.provider === provider && m.id === modelId);
  } catch {
    // runtime unavailable (unreadable config)
    return undefined;
  }
}
