// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARRAY_FIELDS, HOOK_FIELDS } from "./rib-discovery.ts";

// Reads the docs tree directly (the contract reference lives outside this
// workspace) so the rib-contract page can never silently drift behind the hooks
// discovery actually enforces — the drift that left five hooks undocumented.
const RIB_CONTRACT_DOC = join(
  import.meta.dir,
  "../../../docs/src/content/docs/docs/reference/rib-contract.mdx",
);

describe("rib-contract reference stays in sync with the contract", () => {
  const doc = readFileSync(RIB_CONTRACT_DOC, "utf-8");

  for (const field of [...HOOK_FIELDS, ...ARRAY_FIELDS]) {
    it(`names the '${field}' member`, () => {
      expect(doc).toContain(field);
    });
  }

  it("does not pin a stale, fixed hook count", () => {
    expect(doc).not.toMatch(/\b(?:five|six|seven|eight|nine|ten)\s+optional\s+hooks?\b/i);
  });
});
