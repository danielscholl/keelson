// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { clearRegistry, isRegisteredProvider, registerStubProvider } from "@keelson/providers";
import type { RunStreamEvent } from "@keelson/workflows";

import { getCliCredential } from "../src/in-process/providers.ts";
import {
  MemoryRequiresServerError,
  resolveHeadlessProviderId,
  runHeadless,
  WorkflowPreflightError,
} from "../src/in-process/run-workflow.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures");
const BIN = resolve(import.meta.dir, "..", "bin", "keelson.ts");

// runHeadless registers providers into the process-global registry per
// KEELSON_PROVIDERS. Pin the env per test and clear the registry after each so
// no SDK-backed registration leaks into other test files (their default-pick
// assertions depend on what's registered, and file order varies by platform).
const ENV_KEYS = [
  "KEELSON_PROVIDERS",
  "KEELSON_WORKFLOW_PROVIDER",
  "KEELSON_WORKFLOW_PREFLIGHT",
  "KEELSON_HOME",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function initRepo(path: string): void {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: path });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
    }
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(path, "README.md"), "test\n");
  git("add", "README.md");
  git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init");
}

function writeWorkflow(root: string, name: string, body: string): string {
  const dir = join(root, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), body);
  return dir;
}

function artifactsDirs(): Set<string> {
  return new Set(
    readdirSync(tmpdir())
      .filter((entry) => entry.startsWith("keelson-cli-run-"))
      .map((entry) => join(tmpdir(), entry)),
  );
}

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
beforeEach(() => {
  process.env.KEELSON_PROVIDERS = "stub";
  delete process.env.KEELSON_WORKFLOW_PROVIDER;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearRegistry();
});

describe("runHeadless (in-process executor)", () => {
  test("bash-only fixture runs to succeeded and emits node events", async () => {
    const events: RunStreamEvent[] = [];
    const result = await runHeadless({
      name: "smoke-bash",
      inputs: { TEST_NAME: "cli" },
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
      onEvent: (ev) => events.push(ev),
    });

    expect(result.summary.status).toBe("succeeded");
    expect(events.some((e) => e.type === "run_started")).toBe(true);
    expect(events.some((e) => e.type === "node_done")).toBe(true);
    expect(events.some((e) => e.type === "run_done")).toBe(true);
  });

  test("unknown workflow name throws WorkflowNotFoundError", async () => {
    const promise = runHeadless({
      name: "does-not-exist",
      inputs: {},
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
    });
    expect(promise).rejects.toThrow(/no workflow named/);
  });

  test("memory-bearing workflow refused with MemoryRequiresServerError", async () => {
    const promise = runHeadless({
      name: "memory-required",
      inputs: {},
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
    });
    await expect(promise).rejects.toBeInstanceOf(MemoryRequiresServerError);
    await expect(promise).rejects.toThrow(/Memory requires the server/);
    await expect(promise).rejects.toThrow(/think/); // names the memory-bearing node
  });

  test("provider override beats workflow and node pins", async () => {
    const events: RunStreamEvent[] = [];
    const result = await runHeadless({
      name: "provider-override",
      inputs: {},
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
      provider: "stub",
      preflight: false,
      onEvent: (event) => events.push(event),
    });

    const providerIds = events
      .filter(
        (event): event is Extract<RunStreamEvent, { type: "node_done" }> =>
          event.type === "node_done",
      )
      .map((event) => event.result.provider);
    const warnings = events
      .filter(
        (event): event is Extract<RunStreamEvent, { type: "run_warning" }> =>
          event.type === "run_warning",
      )
      .map((event) => event.message);

    expect(result.summary.status).toBe("succeeded");
    expect(providerIds).toEqual(["stub", "stub"]);
    expect(warnings).toContain("provider override 'stub' displaces workflow pin 'copilot'");
    expect(warnings).toContain("provider override 'stub' displaces node pin 'claude'");
  });

  test("rejects a retired model pin before execution", async () => {
    const promise = runHeadless({
      name: "preflight-bad-pin",
      inputs: {},
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
    });

    await expect(promise).rejects.toBeInstanceOf(WorkflowPreflightError);
    await expect(promise).rejects.toThrow(
      "preflight failed:\n- pinned: model 'retired-model' is not in stub's live catalog",
    );
  });

  test("an explicit preflight disable skips a bad pin", async () => {
    const result = await runHeadless({
      name: "preflight-bad-pin",
      inputs: {},
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
      preflight: false,
    });

    expect(result.summary.status).toBe("succeeded");
  });

  test("reports a provider whose live catalog was not checked", async () => {
    process.env.KEELSON_WORKFLOW_PROVIDER = "offline";
    const events: RunStreamEvent[] = [];

    const result = await runHeadless({
      name: "preflight-unavailable",
      inputs: {},
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
      onEvent: (event) => events.push(event),
    });

    expect(result.summary.status).toBe("failed");
    expect(events).toContainEqual({
      type: "run_warning",
      message: "preflight not checked: offline",
    });
  });

  test("YAML-required isolation rejects a non-repository before nodes run", async () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-headless-isolation-"));
    try {
      const workflowsDir = writeWorkflow(
        root,
        "required",
        `name: required
description: required isolated run
worktree:
  enabled: true
nodes:
  - id: work
    bash: touch sentinel.txt
`,
      );
      const events: RunStreamEvent[] = [];
      const promise = runHeadless({
        name: "required",
        inputs: {},
        cwd: root,
        workflowsDir,
        onEvent: (event) => events.push(event),
      });

      await expect(promise).rejects.toThrow("worktree setup failed:");
      expect(events).toEqual([]);
      expect(existsSync(join(root, "sentinel.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit worktree isolation rejects a non-repository before nodes run", async () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-headless-isolation-"));
    try {
      const workflowsDir = writeWorkflow(
        root,
        "forced",
        `name: forced
description: explicitly isolated run
nodes:
  - id: work
    bash: touch sentinel.txt
`,
      );
      await expect(
        runHeadless({
          name: "forced",
          inputs: {},
          cwd: root,
          workflowsDir,
          isolation: "worktree",
        }),
      ).rejects.toThrow("worktree setup failed:");
      expect(existsSync(join(root, "sentinel.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit none overrides required YAML isolation", async () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-headless-isolation-"));
    try {
      const workflowsDir = writeWorkflow(
        root,
        "in-place",
        `name: in-place
description: caller-authorized in-place run
worktree:
  enabled: true
nodes:
  - id: work
    bash: touch sentinel.txt
`,
      );
      const result = await runHeadless({
        name: "in-place",
        inputs: {},
        cwd: root,
        workflowsDir,
        isolation: "none",
      });

      expect(result.summary.status).toBe("succeeded");
      expect(existsSync(join(root, "sentinel.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("setup failure rejects before execution and cleans headless artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-headless-isolation-"));
    initRepo(root);
    const before = artifactsDirs();
    try {
      const workflowsDir = writeWorkflow(
        root,
        "invalid-branch",
        `name: invalid-branch
description: deterministic worktree setup failure
worktree:
  enabled: true
  branch: invalid..branch
nodes:
  - id: work
    bash: touch sentinel.txt
`,
      );
      await expect(
        runHeadless({
          name: "invalid-branch",
          inputs: {},
          cwd: root,
          workflowsDir,
        }),
      ).rejects.toThrow("worktree setup failed:");
      expect(existsSync(join(root, "sentinel.txt"))).toBe(false);
      expect([...artifactsDirs()].filter((path) => !before.has(path))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("successful required isolation executes outside the source checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-headless-isolation-"));
    initRepo(root);
    try {
      const workflowsDir = writeWorkflow(
        root,
        "isolated",
        `name: isolated
description: successful isolated run
worktree:
  enabled: true
nodes:
  - id: work
    bash: pwd; touch sentinel.txt
`,
      );
      const result = await runHeadless({
        name: "isolated",
        inputs: {},
        cwd: root,
        workflowsDir,
      });

      expect(result.summary.status).toBe("succeeded");
      expect(result.summary.nodes.work?.output.replaceAll("\\", "/")).toContain("/.worktrees/");
      expect(existsSync(join(root, "sentinel.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("server-down CLI reports required setup failure with exit 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "keelson-headless-cli-isolation-"));
    const home = mkdtempSync(join(tmpdir(), "keelson-headless-cli-home-"));
    try {
      const workflowsDir = writeWorkflow(
        root,
        "required-cli",
        `name: required-cli
description: required isolated CLI run
worktree:
  enabled: true
nodes:
  - id: work
    bash: touch sentinel.txt
`,
      );
      const proc = Bun.spawn(
        ["bun", BIN, "--json", "workflow", "run", "required-cli", "--working-dir", root],
        {
          env: {
            ...process.env,
            KEELSON_HOME: home,
            KEELSON_PROVIDERS: "stub",
            KEELSON_SERVER_URL: "http://127.0.0.1:1",
            KEELSON_WORKFLOWS_DIR: workflowsDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.trim()).error).toContain("worktree setup failed:");
      expect(existsSync(join(root, "sentinel.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--no-preflight reaches the in-process runner", async () => {
    const home = mkdtempSync(join(tmpdir(), "keelson-preflight-cli-"));
    try {
      const proc = Bun.spawn(
        [
          "bun",
          BIN,
          "--json",
          "workflow",
          "run",
          "preflight-bad-pin",
          "--working-dir",
          process.cwd(),
          "--no-preflight",
        ],
        {
          env: {
            ...process.env,
            KEELSON_HOME: home,
            KEELSON_PROVIDERS: "stub",
            KEELSON_SERVER_URL: "http://127.0.0.1:1",
            KEELSON_WORKFLOWS_DIR: FIXTURES,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.trim()).data.status).toBe("succeeded");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("JSON output reports a live catalog that was not checked", async () => {
    const home = mkdtempSync(join(tmpdir(), "keelson-preflight-cli-"));
    try {
      const proc = Bun.spawn(
        [
          "bun",
          BIN,
          "--json",
          "workflow",
          "run",
          "preflight-unavailable",
          "--working-dir",
          process.cwd(),
        ],
        {
          env: {
            ...process.env,
            KEELSON_HOME: home,
            KEELSON_PROVIDERS: "stub",
            KEELSON_SERVER_URL: "http://127.0.0.1:1",
            KEELSON_WORKFLOW_PROVIDER: "offline",
            KEELSON_WORKFLOWS_DIR: FIXTURES,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.trim()).data.warnings).toEqual(["preflight not checked: offline"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("headless provider registration", () => {
  test("explicit unknown --provider fails fast with the available list", async () => {
    const promise = runHeadless({
      name: "smoke-bash",
      inputs: { TEST_NAME: "cli" },
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
      provider: "no-such-provider",
    });
    await expect(promise).rejects.toThrow(/provider 'no-such-provider' is not registered/);
    await expect(promise).rejects.toThrow(/Available: /);
  });

  test("KEELSON_PROVIDERS registers real providers in-process, no server", async () => {
    process.env.KEELSON_PROVIDERS = "stub,claude";
    const result = await runHeadless({
      name: "smoke-bash",
      inputs: { TEST_NAME: "cli" },
      cwd: process.cwd(),
      workflowsDir: FIXTURES,
      // Passes the registration gate because claude is now registered headless;
      // the bash-only fixture never instantiates the SDK.
      provider: "claude",
    });
    expect(result.summary.status).toBe("succeeded");
    expect(isRegisteredProvider("claude")).toBe(true);
  });

  test("resolveHeadlessProviderId: explicit flag beats the env pin", () => {
    process.env.KEELSON_WORKFLOW_PROVIDER = "pi";
    expect(resolveHeadlessProviderId(" codex ")).toBe("codex");
  });

  test("resolveHeadlessProviderId: KEELSON_WORKFLOW_PROVIDER pins the default", () => {
    process.env.KEELSON_WORKFLOW_PROVIDER = "pi";
    expect(resolveHeadlessProviderId()).toBe("pi");
  });

  test("resolveHeadlessProviderId: config defaultProvider wins when registered", () => {
    delete process.env.KEELSON_WORKFLOW_PROVIDER;
    registerStubProvider();
    const home = mkdtempSync(join(tmpdir(), "keelson-test-home-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ defaultProvider: "stub" }));
    process.env.KEELSON_HOME = home;
    expect(resolveHeadlessProviderId()).toBe("stub");
  });
});

describe("getCliCredential keychain tolerance", () => {
  test("unavailable keychain resolves undefined instead of throwing", async () => {
    const loader = () => Promise.reject(new Error("no secret service available"));
    await expect(getCliCredential("claude", loader)).resolves.toBeUndefined();
  });

  test("missing entry resolves undefined", async () => {
    const loader = () =>
      Promise.resolve({
        Entry: class {
          getPassword(): string {
            throw new Error("No Entry found for service keelson");
          }
        },
      } as unknown as typeof import("@napi-rs/keyring"));
    await expect(getCliCredential("claude", loader)).resolves.toBeUndefined();
  });
});
