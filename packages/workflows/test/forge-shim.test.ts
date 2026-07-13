// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeBinDir, pathWith, runForge, SHIM } from "./forge-support.ts";

// The forge shim is a POSIX bash script executed via its shebang; on Windows it
// runs under Git Bash (validated manually — see the PR), which uv_spawn cannot
// invoke by path. Gate the shim-spawning suites to POSIX.
const shimDescribe = process.platform === "win32" ? describe.skip : describe;

const tmps: string[] = [];
function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "keelson-forge-tmp-"));
  tmps.push(dir);
  const p = join(dir, "f");
  writeFileSync(p, contents);
  return p;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

// ── GitHub passthrough: `exec gh "$@"` must be byte-for-byte ─────────────────

shimDescribe("GitHub passthrough is byte-for-byte", () => {
  // Fake gh echoes its argv to BOTH streams and derives its exit from a marker,
  // so we can compare `forge <args>` to a direct `gh <args>` invocation.
  const FAKE_GH = `#!/usr/bin/env bash
printf 'GH_OUT|%s\\n' "$*"
printf 'GH_ERR|%s\\n' "$*" >&2
case "$*" in
  *__EXIT8__*) exit 8 ;;
  *__FAIL__*) exit 1 ;;
esac
exit 0
`;
  const dir = fakeBinDir({ gh: FAKE_GH });
  const env = { PATH: pathWith(dir), KEELSON_FORGE: "github" };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function directGh(args: string[]) {
    const p = Bun.spawnSync({
      cmd: [join(dir, "gh"), ...args],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), exitCode: p.exitCode ?? -1 };
  }

  // Non-purpose verbs go through `exec gh`. (Purpose verbs like `pr threads` do
  // not — they are covered separately.)
  const matrix: string[][] = [
    ["repo", "view", "--json", "nameWithOwner"],
    ["pr", "view", "42", "--json", "state,url", "-q", ".state"],
    ["issue", "view", "7", "--json", "title,body"],
    ["pr", "checks", "42", "--watch", "--interval", "5"],
    ["api", "graphql", "-f", "query=query{viewer{login}}"],
    ["run", "list", "--branch", "main", "--json", "databaseId"],
    ["pr", "create", "--draft", "--base", "main"],
    ["repo", "view", "__FAIL__"],
    ["pr", "checks", "42", "__EXIT8__"],
  ];
  for (const args of matrix) {
    test(`forge ${args.join(" ")} == gh ${args.join(" ")}`, () => {
      const f = runForge(args, { env });
      const g = directGh(args);
      expect(f.stdout).toBe(g.stdout);
      expect(f.stderr).toBe(g.stderr);
      expect(f.exitCode).toBe(g.exitCode);
    });
  }

  test("exit codes pass through unchanged", () => {
    expect(runForge(["pr", "checks", "42", "__EXIT8__"], { env }).exitCode).toBe(8);
    expect(runForge(["repo", "view", "__FAIL__"], { env }).exitCode).toBe(1);
    expect(runForge(["repo", "view", "ok"], { env }).exitCode).toBe(0);
  });
});

// ── GitLab translation + output normalization ───────────────────────────────

const FAKE_GLAB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_LOG:-/dev/null}"
if [ "$1" = repo ] && [ "$2" = view ]; then
  echo '{"path_with_namespace":"grp/sub/proj","name":"proj","default_branch":"trunk","namespace":{"full_path":"grp/sub"},"web_url":"https://gitlab.com/grp/sub/proj","visibility":"private"}'; exit 0
fi
if [ "$1" = mr ] && [ "$2" = view ]; then
  echo '{"iid":42,"web_url":"https://gitlab.com/grp/sub/proj/-/merge_requests/42","title":"Fix it","description":"body text","state":"opened","draft":true,"target_branch":"trunk","source_branch":"feat/x","sha":"deadbeef","source_project_id":7,"target_project_id":7,"author":{"username":"alice"},"merge_status":"can_be_merged","labels":["bug"]}'; exit 0
fi
if [ "$1" = issue ] && [ "$2" = view ]; then
  echo '{"iid":7,"web_url":"https://gitlab.com/grp/sub/proj/-/issues/7","title":"A bug","description":"it breaks","state":"opened","author":{"username":"bob"},"labels":["p1"]}'; exit 0
fi
if [ "$1" = mr ] && [ "$2" = list ]; then
  echo '[{"iid":5,"title":"m","web_url":"https://gitlab.com/grp/sub/proj/-/merge_requests/5","state":"opened","author":{"username":"a"},"target_branch":"main","source_branch":"f","draft":false,"source_project_id":1,"target_project_id":1,"description":""}]'; exit 0
fi
if [ "$1" = issue ] && [ "$2" = list ]; then
  echo '[{"iid":7,"title":"i","web_url":"https://gitlab.com/grp/sub/proj/-/issues/7","state":"opened","author":{"username":"a"},"labels":[]}]'; exit 0
fi
case "$*" in
  *"mr create"*)    echo 'Created !5: https://gitlab.com/grp/sub/proj/-/merge_requests/5'; exit 0 ;;
  *"issue create"*) echo 'https://gitlab.com/grp/sub/proj/-/issues/9'; exit 0 ;;
esac
exit 0
`;

function gitlabEnv(): { env: Record<string, string>; log: string } {
  const dir = fakeBinDir({ glab: FAKE_GLAB });
  const logDir = mkdtempSync(join(tmpdir(), "keelson-forge-log-"));
  tmps.push(dir, logDir);
  const log = join(logDir, "argv.log");
  return { env: { PATH: pathWith(dir), KEELSON_FORGE: "gitlab", FAKE_LOG: log }, log };
}
const logText = (log: string): string => {
  try {
    return readFileSync(log, "utf8");
  } catch {
    return "";
  }
};

shimDescribe("GitLab input translation", () => {
  test("pr create --draft --base --title --body-file -> mr create --yes --target-branch --draft ...", () => {
    const { env, log } = gitlabEnv();
    const body = tmpFile("PR BODY TEXT");
    const r = runForge(
      ["pr", "create", "--draft", "--base", "main", "--title", "My Title", "--body-file", body],
      {
        env,
      },
    );
    const l = logText(log);
    expect(l).toContain("mr create --yes --target-branch main");
    expect(l).toContain("--draft");
    expect(l).toContain("--title My Title");
    expect(l).toContain("--description PR BODY TEXT");
    // stdout is just the MR URL gh-style.
    expect(r.stdout.trim()).toBe("https://gitlab.com/grp/sub/proj/-/merge_requests/5");
  });

  test("pr ready toggles map to mr update --ready / --draft", () => {
    let e = gitlabEnv();
    runForge(["pr", "ready", "42"], { env: e.env });
    expect(logText(e.log)).toContain("mr update 42 --ready");
    e = gitlabEnv();
    runForge(["pr", "ready", "42", "--undo"], { env: e.env });
    expect(logText(e.log)).toContain("mr update 42 --draft");
  });

  test("pr edit --base -> mr update --target-branch", () => {
    const { env, log } = gitlabEnv();
    runForge(["pr", "edit", "42", "--base", "release/1"], { env });
    expect(logText(log)).toContain("mr update 42 --target-branch release/1");
  });

  test("issue comment --body-file -> issue note -m", () => {
    const { env, log } = gitlabEnv();
    const body = tmpFile("looks good");
    runForge(["issue", "comment", "7", "--body-file", body], { env });
    expect(logText(log)).toContain("issue note 7 -m looks good");
  });

  test("issue create -> issue create --yes with URL on stdout", () => {
    const { env } = gitlabEnv();
    const body = tmpFile("repro steps");
    const r = runForge(["issue", "create", "--title", "T", "--body-file", body], { env });
    expect(r.stdout.trim()).toBe("https://gitlab.com/grp/sub/proj/-/issues/9");
  });

  test("pr list --json maps to mr list -F json and emits gh-shaped rows", () => {
    const { env, log } = gitlabEnv();
    expect(
      runForge(["pr", "list", "--json", "number", "-q", ".[0].number"], { env }).stdout.trim(),
    ).toBe("5");
    expect(logText(log)).toContain("mr list -F json");
  });

  test("issue list --json maps to issue list -O json (its -F is a format switch, not json)", () => {
    const { env, log } = gitlabEnv();
    expect(
      runForge(["issue", "list", "--json", "number", "-q", ".[0].number"], { env }).stdout.trim(),
    ).toBe("7");
    const l = logText(log);
    expect(l).toContain("issue list -O json");
    expect(l).not.toContain("issue list -F json");
  });

  test("pr list / issue list with NO filter flags do not crash (empty-array guard)", () => {
    const { env } = gitlabEnv();
    expect(runForge(["pr", "list", "--json", "number"], { env }).exitCode).toBe(0);
    expect(runForge(["issue", "list", "--json", "number"], { env }).exitCode).toBe(0);
    expect(
      runForge(["pr", "list", "--json", "number"], { env }).stdout.trim().length,
    ).toBeGreaterThan(0);
  });

  test("pr review --approve -> mr approve (+ note); --request-changes -> MR note", () => {
    let e = gitlabEnv();
    expect(
      runForge(["pr", "review", "42", "--approve", "--body", "lgtm"], { env: e.env }).exitCode,
    ).toBe(0);
    expect(logText(e.log)).toContain("mr approve 42");
    expect(logText(e.log)).toContain("mr note 42 -m lgtm");
    e = gitlabEnv();
    runForge(["pr", "review", "42", "--request-changes", "--body", "fix this"], { env: e.env });
    expect(logText(e.log)).toContain("mr note 42 -m Changes requested:");
  });
});

shimDescribe("GitLab output normalization (gh-shaped fields)", () => {
  test("pr view remaps iid/description/web_url/branches/draft/cross-repo", () => {
    const { env } = gitlabEnv();
    const r = runForge(
      [
        "pr",
        "view",
        "42",
        "--json",
        "number,url,title,body,state,isDraft,baseRefName,headRefName,isCrossRepository,author",
      ],
      { env },
    );
    const o = JSON.parse(r.stdout);
    expect(o).toMatchObject({
      number: 42,
      url: "https://gitlab.com/grp/sub/proj/-/merge_requests/42",
      body: "body text",
      state: "OPEN",
      isDraft: true,
      baseRefName: "trunk",
      headRefName: "feat/x",
      isCrossRepository: false,
      author: { login: "alice" },
    });
    // The gitlab-native names must NOT leak.
    expect(r.stdout).not.toContain("iid");
    expect(r.stdout).not.toContain("web_url");
  });

  test("pr view -q '.number' extracts the bare gh field", () => {
    const { env } = gitlabEnv();
    expect(
      runForge(["pr", "view", "42", "--json", "number", "-q", ".number"], { env }).stdout.trim(),
    ).toBe("42");
  });

  test("issue view remaps iid->number, description->body, state->OPEN", () => {
    const { env } = gitlabEnv();
    const o = JSON.parse(
      runForge(["issue", "view", "7", "--json", "number,body,state,author"], { env }).stdout,
    );
    expect(o).toMatchObject({
      number: 7,
      body: "it breaks",
      state: "OPEN",
      author: { login: "bob" },
    });
  });

  test("repo view survives a nested namespace (no cut -f1/-f2 breakage)", () => {
    const { env } = gitlabEnv();
    expect(
      runForge(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
        env,
      }).stdout.trim(),
    ).toBe("grp/sub/proj");
    expect(
      runForge(["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], {
        env,
      }).stdout.trim(),
    ).toBe("trunk");
  });
});

// ── CI checks: exit-code synthesis from the pipeline jobs API ────────────────

shimDescribe("GitLab pr checks exit synthesis", () => {
  function checksEnv(opts: { jobs: string; hasPipeline?: boolean; status?: string }) {
    const has = opts.hasPipeline !== false;
    const FAKE = `#!/usr/bin/env bash
args="$*"
if [ "$1" = repo ]; then echo '{"path_with_namespace":"g/p"}'; exit 0; fi
if [ "$1" = api ]; then
  case "$args" in
    *"pipelines?per_page=1"*) ${has ? `echo '[{"id":123}]'` : `echo '[]'`}; exit 0 ;;
    *"pipelines/123/jobs"*)   echo '${opts.jobs}'; exit 0 ;;
    *"pipelines/123"*)        echo '{"status":"${opts.status ?? "success"}"}'; exit 0 ;;
  esac
  echo '[]'; exit 0
fi
exit 1
`;
    const dir = fakeBinDir({ glab: FAKE });
    tmps.push(dir);
    return { PATH: pathWith(dir), KEELSON_FORGE: "gitlab" };
  }
  const job = (status: string) =>
    `[{"name":"build","stage":"test","status":"${status}","allow_failure":false}]`;

  const cases: Array<[string, number]> = [
    ["success", 0],
    ["failed", 1],
    ["running", 8],
  ];
  for (const [status, code] of cases) {
    test(`${status} pipeline -> exit ${code}`, () => {
      const env = checksEnv({ jobs: job(status), status });
      expect(runForge(["pr", "checks", "42"], { env }).exitCode).toBe(code);
      expect(
        runForge(["pr", "checks", "42", "--json", "state", "-q", "length"], { env }).stdout.trim(),
      ).toBe("1");
    });
  }

  test("no pipeline -> length 0 (UNKNOWN), never a green signal", () => {
    const env = checksEnv({ jobs: "[]", hasPipeline: false });
    expect(
      runForge(["pr", "checks", "42", "--json", "state", "-q", "length"], { env }).stdout.trim(),
    ).toBe("0");
    expect(runForge(["pr", "checks", "42"], { env }).exitCode).toBe(0);
  });

  test("--json mode exits 0 even on a failed pipeline (gh returns early in JSON mode)", () => {
    const env = checksEnv({ jobs: job("failed"), status: "failed" });
    expect(
      runForge(["pr", "checks", "42", "--json", "state", "-q", "length"], { env }).exitCode,
    ).toBe(0);
    // ...but the plain form still surfaces the failure as exit 1.
    expect(runForge(["pr", "checks", "42"], { env }).exitCode).toBe(1);
  });

  test("a running pipeline with no jobs yet is pending (exit 8), never a false green", () => {
    const env = checksEnv({ jobs: "[]", status: "running" });
    expect(runForge(["pr", "checks", "42"], { env }).exitCode).toBe(8);
  });
});

// ── caps: GitHub-only capabilities degrade with exit 3 on GitLab ─────────────

shimDescribe("forge caps gates GitHub-only capabilities", () => {
  test("delegate is available on github", () => {
    expect(
      runForge(["caps", "--require", "delegate"], { env: { KEELSON_FORGE: "github" } }).exitCode,
    ).toBe(0);
  });
  test("delegate exits 3 with a clear message on gitlab", () => {
    const r = runForge(["caps", "--require", "delegate"], { env: { KEELSON_FORGE: "gitlab" } });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("GitHub-only");
  });
  test("api verb is refused on gitlab", () => {
    const r = runForge(["api", "graphql", "-f", "query=x"], { env: { KEELSON_FORGE: "gitlab" } });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("GitHub-only");
  });
});

test("shim ships executable", () => {
  expect(SHIM.endsWith("/bin/forge") || SHIM.endsWith("\\bin\\forge")).toBe(true);
});
