// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { clearRegistry, isRegisteredProvider, registerStubProvider } from "@keelson/providers";
import type { RunStreamEvent } from "@keelson/workflows";

import { getCliCredential } from "../src/in-process/providers.ts";
import {
  MemoryRequiresServerError,
  resolveHeadlessProviderId,
  runHeadless,
} from "../src/in-process/run-workflow.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures");

// runHeadless registers providers into the process-global registry per
// KEELSON_PROVIDERS. Pin the env per test and clear the registry after each so
// no SDK-backed registration leaks into other test files (their default-pick
// assertions depend on what's registered, and file order varies by platform).
const ENV_KEYS = ["KEELSON_PROVIDERS", "KEELSON_WORKFLOW_PROVIDER", "KEELSON_HOME"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
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
