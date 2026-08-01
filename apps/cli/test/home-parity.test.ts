// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultUserHome } from "@keelson/shared/paths";
import { keelsonHome } from "@keelson/workflows";

// @keelson/workflows is a leaf package that deliberately does not depend on
// @keelson/shared, so it carries its own copy of the per-user home rule. This
// file is the drift guard: it lives in a package that can see both. If they
// disagree, a named `command` or `script` node searches a different home than
// the workflow that referenced it and reports its asset missing.
describe("command/script discovery home matches the shared resolver", () => {
  const saved = process.env.KEELSON_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.KEELSON_HOME;
    else process.env.KEELSON_HOME = saved;
  });

  test("agrees on the per-user default when KEELSON_HOME is unset", () => {
    delete process.env.KEELSON_HOME;
    expect(keelsonHome()).toBe(defaultUserHome());
  });

  describe("with an explicit KEELSON_HOME", () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "keelson-parity-"));
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    test("both honor it", () => {
      process.env.KEELSON_HOME = tmp;
      expect(keelsonHome()).toBe(tmp);
    });
  });
});
