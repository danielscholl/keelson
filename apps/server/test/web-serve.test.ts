// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import "./test-setup.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../src/index.ts";

let handle: ServerHandle;
let home: string;
let webDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  home = join(mkdtempSync(join(tmpdir(), "keelson-web-serve-")), "keelson");
  // A minimal built SPA: an index.html and one hashed asset.
  webDir = mkdtempSync(join(tmpdir(), "keelson-web-dist-"));
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Keelson</title><div id=root>");
  writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log('keelson spa');");

  for (const k of ["KEELSON_HOME", "KEELSON_WORKSPACE", "KEELSON_DISABLE_SCHEDULER"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.KEELSON_HOME = home;
  process.env.KEELSON_WORKSPACE = home;
  process.env.KEELSON_DISABLE_SCHEDULER = "1";
  handle = await startServer({ port: 0, webDir });
});

afterAll(async () => {
  await handle.shutdown();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(webDir, { recursive: true, force: true });
});

describe("static SPA serving", () => {
  test("GET / serves index.html", async () => {
    const res = await fetch(new URL("/", handle.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<div id=root>");
  });

  test("GET an asset serves it with an immutable cache header", async () => {
    const res = await fetch(new URL("/assets/app-abc123.js", handle.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toContain("keelson spa");
  });

  test("an extensionless client route falls back to index.html", async () => {
    const res = await fetch(new URL("/workflows/some/deep/route", handle.url));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<div id=root>");
  });

  test("the API is not shadowed by static serving", async () => {
    const res = await fetch(new URL("/api/health", handle.url));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("a missing asset with an extension is not faked into index.html", async () => {
    const res = await fetch(new URL("/assets/missing-xyz.js", handle.url));
    expect(res.status).toBe(404);
  });
});
