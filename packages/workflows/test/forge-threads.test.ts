// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeBinDir, pathWith, runForge } from "./forge-support.ts";

// The shim is a POSIX bash script (needs bash + jq); gate its spawning suites to
// POSIX — on Windows it runs under Git Bash, validated manually (see the PR).
const shimDescribe = process.platform === "win32" ? describe.skip : describe;

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});
function logFile(): string {
  const d = mkdtempSync(join(tmpdir(), "keelson-forge-tlog-"));
  tmps.push(d);
  return join(d, "argv.log");
}
const readLog = (p: string): string => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
// Run the ACTUAL finish-pr ledger mapping over a threads payload, to prove the
// shim's gh-shaped output is forge-agnostic downstream.
function ledgerMap(threadsJson: string): unknown {
  const program = `map(select(.isResolved == false)) | map({
    threadId: .id, path: .path, line: (.line // null),
    commentId: (.comments.nodes[0].databaseId // null),
    body: ([.comments.nodes[].body] | join("\\n\\n---\\n\\n")),
    author: (.comments.nodes[0].author.login // "unknown")
  })`;
  const p = Bun.spawnSync({
    cmd: ["jq", "-c", program],
    stdin: Buffer.from(threadsJson),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`ledger jq failed: ${p.stderr.toString()}`);
  return JSON.parse(p.stdout.toString());
}

// A GitLab discussions payload spanning every case the fetch must handle:
// resolvable+unresolved (added line), fully-resolved, a REMOVED-line comment
// (new_line null -> must fall back to old_path/old_line), a system note, and a
// standalone individual_note.
const GL_DISCUSSIONS = JSON.stringify([
  {
    id: "abc111",
    individual_note: false,
    notes: [
      {
        id: 501,
        system: false,
        resolvable: true,
        resolved: false,
        body: "nit: rename",
        author: { username: "coderabbit" },
        position: { new_path: "src/a.ts", new_line: 42, old_path: "src/a.ts", old_line: 40 },
      },
    ],
  },
  {
    id: "abc222",
    individual_note: false,
    notes: [
      {
        id: 502,
        system: false,
        resolvable: true,
        resolved: true,
        body: "handled",
        author: { username: "bob" },
        position: { new_path: "src/b.ts", new_line: 10 },
      },
    ],
  },
  {
    id: "abc333",
    individual_note: false,
    notes: [
      {
        id: 503,
        system: false,
        resolvable: true,
        resolved: false,
        body: "removed line wrong",
        author: { username: "alice" },
        position: { new_path: null, new_line: null, old_path: "src/c.ts", old_line: 88 },
      },
    ],
  },
  {
    id: "sys999",
    individual_note: false,
    notes: [
      {
        id: 900,
        system: true,
        resolvable: false,
        body: "desc changed",
        author: { username: "ci" },
      },
    ],
  },
  {
    id: "ind888",
    individual_note: true,
    notes: [
      { id: 800, system: false, resolvable: false, body: "plain", author: { username: "dan" } },
    ],
  },
]);

shimDescribe("forge pr threads (GitLab discussions -> gh reviewThreads)", () => {
  function glabThreads() {
    const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_LOG:-/dev/null}"
if [ "$1" = repo ]; then echo '{"path_with_namespace":"grp/proj"}'; exit 0; fi
if [ "$1" = api ]; then cat <<'JSON'
${GL_DISCUSSIONS}
JSON
exit 0; fi
exit 1
`;
    const dir = fakeBinDir({ glab: FAKE });
    tmps.push(dir);
    return { PATH: pathWith(dir), KEELSON_FORGE: "gitlab" };
  }

  test("emits only unresolved threads, gh-shaped, with deleted-line fallback", () => {
    const out = JSON.parse(
      runForge(["pr", "threads", "42", "--unresolved"], { env: glabThreads() }).stdout,
    );
    expect(out).toHaveLength(2);
    const byId = Object.fromEntries(out.map((t: { id: string }) => [t.id, t]));
    // Added-line comment keeps new_path/new_line.
    expect(byId.abc111).toMatchObject({ isResolved: false, path: "src/a.ts", line: 42 });
    expect(byId.abc111.comments.nodes[0]).toMatchObject({
      databaseId: 501,
      author: { login: "coderabbit" },
    });
    // Removed-line comment falls back to old_path/old_line (the adversarial fix).
    expect(byId.abc333).toMatchObject({ path: "src/c.ts", line: 88 });
    // Resolved, system, and individual_note discussions are excluded.
    expect(byId.abc222).toBeUndefined();
    expect(byId.sys999).toBeUndefined();
    expect(byId.ind888).toBeUndefined();
  });

  test("finish-pr's ledger mapping runs unchanged over the shim output", () => {
    const out = runForge(["pr", "threads", "42", "--unresolved"], { env: glabThreads() }).stdout;
    const mapped = ledgerMap(out) as Array<{
      threadId: string;
      path: string;
      line: number;
      commentId: number;
      author: string;
    }>;
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      threadId: "abc111",
      path: "src/a.ts",
      line: 42,
      commentId: 501,
      author: "coderabbit",
    });
    expect(mapped[1]).toMatchObject({
      threadId: "abc333",
      path: "src/c.ts",
      line: 88,
      commentId: 503,
    });
  });
});

shimDescribe("forge pr threads (GitHub GraphQL) is identity-shaped", () => {
  test("passes reviewThreads nodes through, filtering resolved", () => {
    const PAGE = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: "" },
              nodes: [
                {
                  id: "T1",
                  isResolved: false,
                  path: "x.ts",
                  line: 3,
                  comments: {
                    nodes: [{ databaseId: 11, body: "hi", author: { login: "u[bot]" } }],
                  },
                },
                {
                  id: "T2",
                  isResolved: true,
                  path: "y.ts",
                  line: 9,
                  comments: { nodes: [{ databaseId: 12, body: "done", author: { login: "v" } }] },
                },
              ],
            },
          },
        },
      },
    });
    const FAKE_GH = `#!/usr/bin/env bash
if [ "$1" = repo ]; then echo 'o/r'; exit 0; fi
if [ "$1" = api ] && [ "$2" = graphql ]; then cat <<'JSON'
${PAGE}
JSON
exit 0; fi
exit 1
`;
    const dir = fakeBinDir({ gh: FAKE_GH });
    tmps.push(dir);
    const out = JSON.parse(
      runForge(["pr", "threads", "42", "--unresolved"], {
        env: { PATH: pathWith(dir), KEELSON_FORGE: "github" },
      }).stdout,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "T1", isResolved: false, path: "x.ts" });
  });
});

shimDescribe("forge pr reply / resolve-thread route per forge", () => {
  test("gitlab reply posts to the discussion notes endpoint", () => {
    const log = logFile();
    const dir = fakeBinDir({
      glab: `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$1" = repo ]; then echo '{"path_with_namespace":"grp/proj"}'; exit 0; fi\nexit 0\n`,
    });
    tmps.push(dir);
    runForge(["pr", "reply", "42", "--thread", "abc111", "--comment", "501", "--body", "thanks"], {
      env: { PATH: pathWith(dir), KEELSON_FORGE: "gitlab", FAKE_LOG: log },
    });
    const l = readLog(log);
    expect(l).toContain(
      "api -X POST projects/grp%2Fproj/merge_requests/42/discussions/abc111/notes",
    );
    expect(l).toContain("body=thanks");
  });

  test("github reply posts to the comment replies endpoint (keys on databaseId)", () => {
    const log = logFile();
    const dir = fakeBinDir({
      gh: `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$1" = repo ]; then echo 'o/r'; exit 0; fi\nexit 0\n`,
    });
    tmps.push(dir);
    runForge(["pr", "reply", "42", "--thread", "T1", "--comment", "501", "--body", "thanks"], {
      env: { PATH: pathWith(dir), KEELSON_FORGE: "github", FAKE_LOG: log },
    });
    expect(readLog(log)).toContain("api -X POST repos/o/r/pulls/42/comments/501/replies");
  });

  test("gitlab resolve-thread PUTs resolved=true and wraps the gh envelope", () => {
    const log = logFile();
    const dir = fakeBinDir({
      glab: `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$1" = repo ]; then echo '{"path_with_namespace":"grp/proj"}'; exit 0; fi\necho '{"notes":[{"resolvable":true,"resolved":true}]}'\nexit 0\n`,
    });
    tmps.push(dir);
    const r = runForge(["pr", "resolve-thread", "42", "--thread", "abc111"], {
      env: { PATH: pathWith(dir), KEELSON_FORGE: "gitlab", FAKE_LOG: log },
    });
    expect(readLog(log)).toContain(
      "api -X PUT projects/grp%2Fproj/merge_requests/42/discussions/abc111?resolved=true",
    );
    const o = JSON.parse(r.stdout);
    expect(o.data.resolveReviewThread.thread.isResolved).toBe(true);
  });

  test("github resolve-thread calls the resolveReviewThread mutation", () => {
    const log = logFile();
    const dir = fakeBinDir({
      gh: `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\necho '{"data":{"resolveReviewThread":{"thread":{"id":"T1","isResolved":true}}}}'\nexit 0\n`,
    });
    tmps.push(dir);
    const r = runForge(["pr", "resolve-thread", "42", "--thread", "T1"], {
      env: { PATH: pathWith(dir), KEELSON_FORGE: "github", FAKE_LOG: log },
    });
    expect(readLog(log)).toContain("api graphql");
    expect(readLog(log)).toContain("resolveReviewThread");
    expect(JSON.parse(r.stdout).data.resolveReviewThread.thread.isResolved).toBe(true);
  });
});

shimDescribe("forge pr review-batch anchors inline comments (GitLab)", () => {
  test("posts a NESTED position via --input - (RIGHT->new_*, LEFT->old_*)", () => {
    const stdinLog = logFile();
    const dir = fakeBinDir({
      glab: `#!/usr/bin/env bash
[ "$1" = repo ] && { echo '{"path_with_namespace":"g/p"}'; exit 0; }
[ "$1 $2" = "mr view" ] && { echo '{"diff_refs":{"base_sha":"BBB","start_sha":"SSS","head_sha":"HHH"}}'; exit 0; }
case "$*" in
  *discussions*"--input -"*) cat >> "${stdinLog}"; printf '\\n' >> "${stdinLog}"; exit 0 ;;
esac
exit 0
`,
    });
    tmps.push(dir);
    const payloadDir = mkdtempSync(join(tmpdir(), "keelson-forge-payload-"));
    tmps.push(payloadDir);
    const payload = join(payloadDir, "p.json");
    writeFileSync(
      payload,
      JSON.stringify({
        event: "COMMENT",
        body: "summary",
        comments: [
          { path: "src/a.ts", line: 42, side: "RIGHT", body: "nit" },
          { path: "src/b.ts", line: 10, side: "LEFT", body: "removed line" },
        ],
      }),
    );
    runForge(["pr", "review-batch", "42", "--input", payload], {
      env: { PATH: pathWith(dir), KEELSON_FORGE: "gitlab", STDIN_LOG: stdinLog },
    });
    const posted = readLog(stdinLog)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(posted).toHaveLength(2);
    expect(posted[0].position).toMatchObject({
      position_type: "text",
      new_path: "src/a.ts",
      new_line: 42,
      head_sha: "HHH",
    });
    expect(posted[1].position).toMatchObject({ old_path: "src/b.ts", old_line: 10 });
    // flat position[...] keys must NOT be present.
    expect(JSON.stringify(posted)).not.toContain("position[");
  });
});
