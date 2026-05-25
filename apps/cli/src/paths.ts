// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { resolve } from "node:path";

// CLI source lives at apps/cli/src/; the monorepo root is four levels up.
// Resolve from the file's location so the path holds whether invoked via
// the bin script, a global symlink, or `bun apps/cli/src/...` directly.
export function workspaceRoot(): string {
  return resolve(import.meta.dir, "..", "..", "..");
}

// Default workflow discovery root — `.keelson/workflows/` under the
// workspace. The server uses the same path (apps/server/src/bootstrap.ts
// bootstrapWorkflows).
export function defaultWorkflowsDir(): string {
  return resolve(workspaceRoot(), ".keelson", "workflows");
}

// Default SQLite path — `.keelson/keelson.db` under the workspace. Mirrors
// the server's KEELSON_DB default in apps/server/src/db/init.ts.
export function defaultDbPath(): string {
  return resolve(workspaceRoot(), ".keelson", "keelson.db");
}
