// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { bundledWorkflowsDir } from "../src/seed.ts";
import { fakeBinDir, pathWith } from "./forge-support.ts";

const shimDescribe = process.platform === "win32" ? describe.skip : describe;
const tmps: string[] = [];

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

function finalizeBash(): string {
  const document = parse(readFileSync(join(bundledWorkflowsDir(), "fix-issue.yaml"), "utf8")) as {
    nodes: Array<{ id: string; bash?: string }>;
  };
  const script = document.nodes.find((node) => node.id === "finalize-pr")?.bash;
  if (!script) throw new Error("Missing finalize-pr bash node in fix-issue");
  return script;
}

function runFinalize(body: string) {
  const artifacts = mkdtempSync(join(tmpdir(), "keelson-body-stamp-"));
  tmps.push(artifacts);
  writeFileSync(join(artifacts, ".pr-number"), "42\n");
  const bodySrc = join(artifacts, ".body-src.md");
  writeFileSync(bodySrc, body);
  const editedBody = join(artifacts, ".body-edited.md");
  const forge = `#!/usr/bin/env bash
case "$*" in
  "pr checks 42 --json state -q length") echo 1 ;;
  "pr required-checks 42") exit 0 ;;
  "pr checks 42 --json name,bucket,state") echo '[{"name":"tests","bucket":"pass","state":"SUCCESS"}]' ;;
  "pr view 42 --json body -q .body") cat "$BODY_SRC" ;;
  "pr edit 42 --body-file "*) cp "\${@: -1}" "$EDITED_BODY" ;;
  "pr ready 42") touch "$READY_MARKER" ;;
  *) echo "unexpected forge args: $*" >&2; exit 1 ;;
esac
`;
  const bin = fakeBinDir({ forge });
  tmps.push(bin);
  const readyMarker = join(artifacts, ".ready-called");
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", finalizeBash()],
    env: {
      ...(process.env as Record<string, string>),
      KEELSON_ARTIFACTS_DIR: artifacts,
      PATH: pathWith(bin),
      READY_MARKER: readyMarker,
      BODY_SRC: bodySrc,
      EDITED_BODY: editedBody,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    readyCalled: existsSync(readyMarker),
    editedBody: existsSync(editedBody) ? readFileSync(editedBody, "utf8") : null,
  };
}

shimDescribe("finalize-pr body stamping", () => {
  test("replaces the pending CI placeholder with the real outcome on promote", () => {
    const result = runFinalize("## Test plan\n- local gates: PASS\n- CI: pending CI\n");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PR_STATE: READY");
    expect(result.readyCalled).toBe(true);
    expect(result.editedBody).toContain("CI green (no gating failures)");
    expect(result.editedBody).not.toContain("pending CI");
  });

  test("leaves a body without the placeholder untouched", () => {
    const result = runFinalize("## Test plan\n- everything ran locally\n");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PR_STATE: READY");
    expect(result.readyCalled).toBe(true);
    expect(result.editedBody).toBeNull();
  });
});
