// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";

const shimDescribe = process.platform === "win32" ? describe.skip : describe;
const tmps: string[] = [];

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

function replyResolveBash(): string {
  const document = parse(readFileSync(join(bundledWorkflowsDir(), "resolve-pr.yaml"), "utf8")) as {
    nodes: Array<{ id: string; bash?: string }>;
  };
  const script = document.nodes.find((node) => node.id === "reply-resolve")?.bash;
  if (!script) throw new Error("Missing reply-resolve bash node in resolve-pr");
  return script.replaceAll("$converge.round", "2");
}

interface Result {
  threadId: string;
  commentId: number;
  action: string;
  decision: string;
  resolve_authorized: boolean;
  reply: string;
}

function result(threadId: string, resolveAuthorized: boolean): Result {
  return {
    threadId,
    commentId: 7,
    action: resolveAuthorized ? "fixed" : "replied-only",
    decision: resolveAuthorized ? "actionable-code-change" : "question",
    resolve_authorized: resolveAuthorized,
    reply: `reply to ${threadId}`,
  };
}

// `forge` is a shell function that logs each call (with the reply body it read)
// and fails for the thread ids named in FAIL_REPLY / FAIL_RESOLVE; CRASH_RESOLVE
// exits the whole script mid-resolve, as a killed or timed-out node would.
const FORGE_STUB = `forge() {
  if [ "$2" = "reply" ]; then
    printf '%s body=%s\\n' "$2 $3 $5 $7" "$(cat "$9")" >> "$KEELSON_ARTIFACTS_DIR/forge.log"
  else
    printf '%s\\n' "$2 $3 $5" >> "$KEELSON_ARTIFACTS_DIR/forge.log"
  fi
  if [ "$2" = "reply" ] && [ "$5" = "\${FAIL_REPLY:-}" ]; then return 1; fi
  if [ "$2" = "resolve-thread" ] && [ "$5" = "\${FAIL_RESOLVE:-}" ]; then return 1; fi
  if [ "$2" = "resolve-thread" ] && [ "$5" = "\${CRASH_RESOLVE:-}" ]; then exit 9; fi
  return 0
}
`;

function run(
  results: Result[],
  env: Record<string, string> = {},
  handled: unknown[] = [{ threadId: "old", replied: true, resolved: true, round: 1 }],
) {
  const dir = mkdtempSync(join(tmpdir(), "reply-resolve-"));
  tmps.push(dir);
  writeFileSync(join(dir, "results.json"), JSON.stringify(results));
  writeFileSync(join(dir, ".pr-number"), "42\n");
  writeFileSync(join(dir, "handled.json"), JSON.stringify(handled));
  writeFileSync(join(dir, "forge.log"), "");
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", `${FORGE_STUB}${replyResolveBash()}`],
    cwd: dir,
    env: { ...(process.env as Record<string, string>), KEELSON_ARTIFACTS_DIR: dir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    forgeLog: readFileSync(join(dir, "forge.log"), "utf8").split("\n").filter(Boolean),
    handled: read("handled.json") as Array<Record<string, unknown>>,
    failures: read("reply-failures.json") as Array<Record<string, unknown>>,
    outcome: read("outcome.json") as Record<string, string[]>,
  };
}

shimDescribe("resolve-pr reply-resolve", () => {
  test("replies to every result and resolves only authorized threads, reply first", () => {
    const out = run([result("t-fix", true), result("t-q", false)]);

    expect(out.exitCode).toBe(0);
    expect(out.forgeLog).toEqual([
      "reply 42 t-fix 7 body=reply to t-fix",
      "resolve-thread 42 t-fix",
      "reply 42 t-q 7 body=reply to t-q",
    ]);
    expect(out.outcome).toEqual({
      replied: ["t-fix", "t-q"],
      resolved: ["t-fix"],
      left_open: ["t-q"],
    });
    expect(out.failures).toEqual([]);
    expect(out.handled.map((e) => [e.threadId, e.resolved, e.round])).toEqual([
      ["old", true, 1],
      ["t-fix", true, 2],
      ["t-q", false, 2],
    ]);
    expect(out.handled[1]).toMatchObject({ replied: true, resolve_authorized: true, commentId: 7 });
  });

  test("a failed reply is recorded and the thread stays out of the ledger", () => {
    const out = run([result("t-fix", true)], { FAIL_REPLY: "t-fix" });

    expect(out.exitCode).toBe(0);
    expect(out.forgeLog).toHaveLength(1);
    expect(out.failures).toEqual([
      { round: 2, stage: "reply-resolve", threads: ["t-fix"], reason: "forge pr reply failed" },
    ]);
    expect(out.handled.map((e) => e.threadId)).toEqual(["old"]);
    expect(out.outcome.left_open).toEqual(["t-fix"]);
  });

  test("a failed resolve records the posted reply unresolved for resolve-retry", () => {
    const out = run([result("t-fix", true)], { FAIL_RESOLVE: "t-fix" });

    expect(out.exitCode).toBe(0);
    expect(out.failures).toEqual([
      {
        round: 2,
        stage: "reply-resolve",
        threads: ["t-fix"],
        reason: "forge pr resolve-thread failed",
      },
    ]);
    expect(out.handled.at(-1)).toMatchObject({ threadId: "t-fix", replied: true, resolved: false });
  });

  test("an exit during resolve leaves the posted reply in the ledger, so a resume won't repeat it", () => {
    const crashed = run([result("t-fix", true)], { CRASH_RESOLVE: "t-fix" });

    expect(crashed.exitCode).toBe(9);
    expect(crashed.handled.at(-1)).toMatchObject({
      threadId: "t-fix",
      replied: true,
      resolved: false,
      round: 2,
    });
    expect(crashed.failures).toEqual([
      {
        round: 2,
        stage: "reply-resolve",
        threads: [],
        reason: "reply-resolve exited with status 9 before finishing",
      },
    ]);

    const resumed = run([result("t-fix", true)], {}, crashed.handled);
    expect(resumed.forgeLog).toEqual([]);
  });

  test("a resumed run skips threads this round already replied to", () => {
    const out = run([result("t-fix", true), result("t-q", false)], {}, [
      { threadId: "t-fix", replied: true, resolved: true, round: 2 },
    ]);

    expect(out.exitCode).toBe(0);
    expect(out.forgeLog).toEqual(["reply 42 t-q 7 body=reply to t-q"]);
    expect(out.handled.map((e) => e.threadId)).toEqual(["t-fix", "t-q"]);
  });

  test("an unexpected exit records the unanswered threads for reply-audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "reply-resolve-"));
    tmps.push(dir);
    writeFileSync(join(dir, "results.json"), JSON.stringify([result("t-fix", true)]));
    writeFileSync(join(dir, "handled.json"), "{}");
    writeFileSync(join(dir, ".pr-number"), "42");
    const proc = Bun.spawnSync({
      cmd: ["bash", "-c", `${FORGE_STUB}${replyResolveBash()}`],
      cwd: dir,
      env: { ...(process.env as Record<string, string>), KEELSON_ARTIFACTS_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).not.toBe(0);
    expect(() => readFileSync(join(dir, "forge.log"))).toThrow();
    expect(JSON.parse(readFileSync(join(dir, "reply-failures.json"), "utf8"))).toEqual([
      {
        round: 2,
        stage: "reply-resolve",
        threads: ["t-fix"],
        reason: "reply-resolve exited with status 1 before finishing",
      },
    ]);
  });
});
