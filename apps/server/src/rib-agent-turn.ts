// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type {
  MessageChunk,
  RibAgentTurn,
  RibAgentTurnRequest,
  RibAgentTurnResult,
} from "@keelson/shared";
import { runJSON } from "@keelson/shared/exec";

// CLI-backed MVP of the C1 `runAgentTurn` seam (packages/shared/src/rib.ts):
// shell `claude -p <prompt> --output-format json [...]` via runJSON and adapt
// the `{ result, session_id }` wrapper into the settled { stream, result }
// dual-handle. A rib's room loop is written once against this; the Phase-2
// hardening swaps only the body (registry routing, stream tee, real
// mid-flight cancellation) — the contract and every call site stay put.
//
// MVP limitations, deferred to the hardening pass: the turn ignores
// `KEELSON_WORKFLOW_PROVIDER` (the CLI uses ambient auth — stamped as
// `cli:<bin>` so the divergence is observable), and `abortSignal` only
// short-circuits a not-yet-started turn — a turn already in flight runs to its
// timeout (the room core ignores a stopped room's late result).

export interface MakeRibAgentTurnDeps {
  // Test seam: defaults to runJSON over the real CLI.
  runJSON?: typeof runJSON;
  // The coding-agent CLI to shell. Defaults to "claude".
  bin?: string;
}

interface ClaudeReply {
  result?: string;
  session_id?: string;
  // claude can exit 0 yet flag a failed turn in the JSON.
  is_error?: boolean;
  subtype?: string;
}

export function makeRibAgentTurn(
  deps: MakeRibAgentTurnDeps = {},
): (ribId: string, req: RibAgentTurnRequest) => RibAgentTurn {
  const exec = deps.runJSON ?? runJSON;
  const bin = deps.bin ?? "claude";
  // ribId is accepted for future per-rib policy/logging; provider routing is
  // global, so it does not scope the turn today.
  return (_ribId, req) => {
    const result = runCli(exec, bin, req);
    return { result, stream: toStream(result) };
  };
}

async function runCli(
  exec: typeof runJSON,
  bin: string,
  req: RibAgentTurnRequest,
): Promise<RibAgentTurnResult> {
  const providerId = `cli:${bin}`;
  if (req.abortSignal?.aborted) {
    return { status: "aborted", text: "", providerId };
  }

  const args = ["-p", "--output-format", "json", ...toolArgs(req)];
  if (req.system) args.push("--append-system-prompt", req.system);
  if (req.model) args.push("--model", req.model);
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
  // `--` terminates option parsing so a prompt that starts with "-" (a Markdown
  // bullet, "--help", …) is read as input, not a CLI flag — `-p` is boolean and
  // the prompt is the positional after it. Verified against the real CLI.
  args.push("--", req.prompt);

  const res = await exec<ClaudeReply>(bin, args, {
    ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
    ...(req.cwd ? { cwd: req.cwd } : {}),
  });

  if (!res.ok) {
    if (req.abortSignal?.aborted) return { status: "aborted", text: "", providerId };
    const status = /timed out/i.test(res.error) ? "timeout" : "error";
    return { status, text: "", error: res.error, providerId };
  }

  const data = res.data;
  const text = typeof data?.result === "string" ? data.result : "";
  const sessionId = data?.session_id;
  // A zero exit isn't enough: claude reports a failed turn (max-turns,
  // max-budget, execution error) as is_error / a non-"success" subtype while
  // still returning JSON. Don't pass that off to the rib as a successful turn.
  if (data?.is_error === true || (data?.subtype && data.subtype !== "success")) {
    return {
      status: "error",
      text,
      error:
        data?.subtype && data.subtype !== "success"
          ? `claude turn: ${data.subtype}`
          : "claude reported an error",
      providerId,
      ...(sessionId ? { sessionId } : {}),
    };
  }
  return {
    status: "ok",
    text,
    providerId,
    ...(sessionId ? { sessionId } : {}),
  };
}

// Translate the request's tool rails into claude CLI flags so a turn that asks
// for no tools actually gets none. Without this a "text-only" room turn (the
// room default — tools omitted) would run under the CLI's ambient tool policy
// and could invoke Bash/Edit, violating the C1 contract. `--tools ""` disables
// all tools; `--allowedTools` / `--disallowedTools` are the permission rails.
function toolArgs(req: RibAgentTurnRequest): string[] {
  const fromTools = req.tools?.map((t) => t.name) ?? [];
  const allowed = req.allowedTools ?? [];
  const disallowed = req.disallowedTools ?? [];

  // `--tools` is the catalog gate (which built-ins may load at all); only it
  // actually bounds the turn. `--allowedTools` is just the permission rail — on
  // its own it leaves every default tool loadable. So an explicit allow-list
  // must also narrow the catalog. Catalog names come from `tools` plus the base
  // name of each allow entry ("Bash(git:*)" -> "Bash").
  const catalog = unique([...fromTools, ...allowed.map(baseToolName)]);
  // `tools`/`allowedTools` present (even empty) means "these and no others";
  // `disallowedTools` alone is a deny rail that leaves the rest available.
  const explicitAllowList = req.tools !== undefined || req.allowedTools !== undefined;

  const args: string[] = [];
  if (catalog.length > 0) {
    args.push("--tools", catalog.join(","));
  } else if (explicitAllowList || req.disallowedTools === undefined) {
    // Text-only: the room default (no tool fields), or an explicit empty
    // allow-list. A deny rail — even an empty one — leaves the rest available.
    args.push("--tools", "");
  }
  if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));
  if (disallowed.length > 0) args.push("--disallowedTools", disallowed.join(","));
  return args;
}

// The bare built-in tool name, dropping any permission scope ("Bash(git:*)").
function baseToolName(spec: string): string {
  const paren = spec.indexOf("(");
  return (paren === -1 ? spec : spec.slice(0, paren)).trim();
}

function unique(names: string[]): string[] {
  return [...new Set(names.filter((n) => n.length > 0))];
}

// The MVP has no live token stream, so synthesize one from the settled result:
// the full text as one chunk (an error chunk on failure), then a terminal done.
async function* toStream(result: Promise<RibAgentTurnResult>): AsyncGenerator<MessageChunk> {
  const r = await result;
  if (r.text) yield { type: "text", content: r.text };
  if (r.status !== "ok" && r.error) yield { type: "error", message: r.error };
  yield { type: "done" };
}
