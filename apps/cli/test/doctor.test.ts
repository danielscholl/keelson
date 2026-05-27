// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "@keelson/shared/exec";
import { runAuthCheck } from "../src/checks/auth.ts";
import { type DbReader, LATEST_MIGRATION_VERSION, runDbCheck } from "../src/checks/db.ts";
import { runServerCheck } from "../src/checks/server.ts";
import { runToolchainCheck } from "../src/checks/toolchain.ts";
import { runWorkflowsCheck } from "../src/checks/workflows.ts";
import { buildDoctorReport, exitCodeFor } from "../src/commands/doctor.ts";
import { EXIT_FAIL, EXIT_OK } from "../src/exit.ts";
import type { ServerInfo } from "../src/server-probe.ts";

function execOk(stdout: string): ExecResult<string> {
  return { ok: true, data: stdout, exitCode: 0 };
}

function execFail(error: string): ExecResult<string> {
  return { ok: false, error, code: null };
}

function fakeRunText(
  table: Record<string, ExecResult<string>>,
  fallback: ExecResult<string> = execFail("unstubbed cmd"),
) {
  return async (cmd: string): Promise<ExecResult<string>> => table[cmd] ?? fallback;
}

describe("toolchain check", () => {
  test("bun resolves → ok", async () => {
    const result = await runToolchainCheck({
      runText: fakeRunText({
        bun: execOk("1.2.21"),
      }),
    });
    expect(result.category).toBe("toolchain");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.status).toBe("ok");
    expect(result.checks[0]?.detail).toBe("1.2.21");
  });

  test("bun missing → warn with install hint", async () => {
    const result = await runToolchainCheck({
      runText: fakeRunText({
        bun: execFail("bun not found"),
      }),
    });
    const bun = result.checks.find((c) => c.name.startsWith("bun"));
    expect(bun?.status).toBe("warn");
    expect(bun?.hint).toContain("Bun");
  });
});

describe("server check", () => {
  test("server up → ok with version detail", async () => {
    const info: ServerInfo = {
      baseUrl: "http://127.0.0.1:7878",
      name: "keelson",
      phase: 2,
      schemaVersion: "2.7",
    };
    const result = await runServerCheck({ probeServer: async () => info });
    expect(result.checks[0]?.status).toBe("ok");
    expect(result.checks[0]?.detail).toContain("schema 2.7");
  });

  test("server down → warn (never fail)", async () => {
    const result = await runServerCheck({ probeServer: async () => null });
    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.hint).toContain("keelson serve");
  });
});

describe("db check", () => {
  const okReader: DbReader = {
    readSchemaVersion: () => LATEST_MIGRATION_VERSION,
  };

  test("LATEST_MIGRATION_VERSION matches highest version in server migrations.ts", () => {
    const migrationsPath = join(
      import.meta.dir,
      "..",
      "..",
      "server",
      "src",
      "db",
      "migrations.ts",
    );
    const source = readFileSync(migrationsPath, "utf8");
    const versions = Array.from(source.matchAll(/^\s*version:\s*(\d+)\s*,/gm), (m) => Number(m[1]));
    expect(versions.length).toBeGreaterThan(0);
    expect(LATEST_MIGRATION_VERSION).toBe(Math.max(...versions));
  });

  test("db missing → warn", async () => {
    const result = await runDbCheck({
      dbPath: "/tmp/does-not-exist.db",
      exists: () => false,
      reader: okReader,
    });
    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.detail).toContain("db not found");
  });

  test("schema at expected version → ok", async () => {
    const result = await runDbCheck({
      dbPath: "/tmp/fake.db",
      exists: () => true,
      reader: okReader,
    });
    expect(result.checks[0]?.status).toBe("ok");
    expect(result.checks[0]?.detail).toContain(`v${LATEST_MIGRATION_VERSION}`);
  });

  test("schema older than expected → warn with run-serve hint", async () => {
    const result = await runDbCheck({
      dbPath: "/tmp/fake.db",
      exists: () => true,
      reader: { readSchemaVersion: () => LATEST_MIGRATION_VERSION - 1 },
    });
    expect(result.checks[0]?.status).toBe("warn");
    expect(result.checks[0]?.hint).toContain("pending migrations");
  });

  test("schema newer than CLI knows → fail", async () => {
    const result = await runDbCheck({
      dbPath: "/tmp/fake.db",
      exists: () => true,
      reader: { readSchemaVersion: () => LATEST_MIGRATION_VERSION + 1 },
    });
    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.hint).toContain("upgrade keelson");
  });

  test("reader throws → fail", async () => {
    const result = await runDbCheck({
      dbPath: "/tmp/fake.db",
      exists: () => true,
      reader: {
        readSchemaVersion: () => {
          throw new Error("disk i/o error");
        },
      },
    });
    expect(result.checks[0]?.status).toBe("fail");
    expect(result.checks[0]?.detail).toContain("disk i/o error");
  });
});

describe("auth check", () => {
  test("keyring round-trip ok → ok", async () => {
    const result = await runAuthCheck({
      keyring: { roundTrip: async () => ({ ok: true }) },
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.status).toBe("ok");
  });

  test("keyring failure → fail", async () => {
    const result = await runAuthCheck({
      keyring: {
        roundTrip: async () => ({ ok: false, error: "keychain locked" }),
      },
    });
    const keyring = result.checks.find((c) => c.name === "keyring round-trip");
    expect(keyring?.status).toBe("fail");
    expect(keyring?.detail).toBe("keychain locked");
  });
});

describe("workflows check", () => {
  test("clean discovery → ok with count", async () => {
    const result = await runWorkflowsCheck({
      workflowsDir: "/tmp/fake-wf",
      discoverWorkflows: () => ({
        workflows: [
          // Cast-as-any: the test only needs the array length, not the
          // workflow shape — the real DiscoveryResult ships a full
          // WorkflowDefinition that's overkill to fabricate here.
          { workflow: {} as never, path: "a.yaml", source: "project" },
          { workflow: {} as never, path: "b.yaml", source: "project" },
        ],
        errors: [],
        warnings: [],
      }),
    });
    expect(result.checks[0]?.status).toBe("ok");
    expect(result.checks[0]?.detail).toContain("2 workflow(s)");
    expect(result.checks[1]?.status).toBe("ok");
  });

  test("parse error → warn row per file", async () => {
    const result = await runWorkflowsCheck({
      workflowsDir: "/tmp/fake-wf",
      discoverWorkflows: () => ({
        workflows: [],
        errors: [
          {
            filename: "/tmp/fake-wf/broken.yaml",
            error: "schema error: missing name",
            errorType: "validation_error",
          },
        ],
        warnings: [],
      }),
    });
    const broken = result.checks.find((c) => c.name.endsWith("broken.yaml"));
    expect(broken?.status).toBe("warn");
    expect(broken?.detail).toContain("schema error");
    // Discovery row is still present even when there are errors.
    expect(result.checks[0]?.name).toBe("discovery");
    expect(result.checks[0]?.status).toBe("ok");
  });
});

describe("runDoctor exit-code rollup", () => {
  function allOkDeps() {
    return {
      toolchain: {
        runText: fakeRunText({ bun: execOk("1.2.21") }),
      },
      server: {
        probeServer: async () => ({
          baseUrl: "http://127.0.0.1:7878",
          name: "keelson",
          phase: 2,
          schemaVersion: "2.7",
        }),
      },
      db: {
        dbPath: "/tmp/fake.db",
        exists: () => true,
        reader: { readSchemaVersion: () => LATEST_MIGRATION_VERSION },
      },
      auth: {
        keyring: { roundTrip: async () => ({ ok: true }) },
      },
      workflows: {
        workflowsDir: "/tmp/fake-wf",
        discoverWorkflows: () => ({ workflows: [], errors: [], warnings: [] }),
      },
    };
  }

  test("all checks ok → exit 0 (strict or not)", async () => {
    const report = await buildDoctorReport(false, allOkDeps());
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(exitCodeFor(report)).toBe(EXIT_OK);
    const strictReport = await buildDoctorReport(true, allOkDeps());
    expect(exitCodeFor(strictReport)).toBe(EXIT_OK);
  });

  test("warn-only → exit 0 normally, exit 1 with --strict", async () => {
    const deps = allOkDeps();
    deps.toolchain = {
      runText: fakeRunText({ bun: execFail("bun not found") }),
    };
    const loose = await buildDoctorReport(false, deps);
    expect(loose.summary.warn).toBe(1);
    expect(exitCodeFor(loose)).toBe(EXIT_OK);
    const strict = await buildDoctorReport(true, deps);
    expect(exitCodeFor(strict)).toBe(EXIT_FAIL);
  });

  test("any fail → exit 1 regardless of strict", async () => {
    const deps = allOkDeps();
    deps.auth = {
      keyring: {
        roundTrip: async () => ({ ok: false, error: "keychain locked" }),
      },
    };
    const report = await buildDoctorReport(false, deps);
    expect(report.summary.fail).toBe(1);
    expect(exitCodeFor(report)).toBe(EXIT_FAIL);
  });
});
