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

  const args = ["-p", req.prompt, "--output-format", "json"];
  if (req.system) args.push("--append-system-prompt", req.system);
  if (req.model) args.push("--model", req.model);
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);

  const res = await exec<ClaudeReply>(bin, args, {
    ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
    ...(req.cwd ? { cwd: req.cwd } : {}),
  });

  if (!res.ok) {
    if (req.abortSignal?.aborted) return { status: "aborted", text: "", providerId };
    const status = /timed out/i.test(res.error) ? "timeout" : "error";
    return { status, text: "", error: res.error, providerId };
  }

  const text = typeof res.data?.result === "string" ? res.data.result : "";
  return {
    status: "ok",
    text,
    providerId,
    ...(res.data?.session_id ? { sessionId: res.data.session_id } : {}),
  };
}

// The MVP has no live token stream, so synthesize one from the settled result:
// the full text as one chunk (an error chunk on failure), then a terminal done.
async function* toStream(result: Promise<RibAgentTurnResult>): AsyncGenerator<MessageChunk> {
  const r = await result;
  if (r.text) yield { type: "text", content: r.text };
  if (r.status !== "ok" && r.error) yield { type: "error", message: r.error };
  yield { type: "done" };
}
