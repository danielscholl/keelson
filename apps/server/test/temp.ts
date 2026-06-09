// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { rmSync } from "node:fs";
import { closeTrackedDatabases } from "../src/db/init.ts";

// Recursively remove a test's temp dir, tolerating Windows' refusal to unlink an
// open SQLite file. `closeTrackedDatabases()` closes the handles and forces a GC
// so the stores' prepared statements finalize and release the file. A dir whose
// db is still reachable from a live module-scope test variable can't be freed
// yet; it stays pending and is retried on the next call — by then the following
// test's beforeEach has reassigned those variables, so the prior dir's handles
// are collectable — and once more at process exit. Best-effort by design: this
// never throws, so a still-locked dir is left for the OS to reap rather than
// failing the test that owns it. A no-op on POSIX, where the open file deletes
// fine and the first attempt always succeeds.
const pending = new Set<string>();

export function rmTemp(dir: string): void {
  closeTrackedDatabases();
  pending.add(dir);
  sweep();
}

function sweep(): void {
  for (const dir of pending) {
    try {
      rmSync(dir, { recursive: true, force: true });
      pending.delete(dir);
    } catch {
      // Still held by a live handle; a later sweep (or the OS) will reclaim it.
    }
  }
}

process.on("exit", () => {
  closeTrackedDatabases();
  sweep();
});
