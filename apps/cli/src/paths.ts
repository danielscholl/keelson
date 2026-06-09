// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { keelsonPaths, resolveKeelsonHome } from "@keelson/shared/paths";

export { resolveKeelsonHome };

// Default workflow discovery root — `workflows/` under the keelson home. The
// server resolves the identical path (apps/server/src/index.ts).
export function defaultWorkflowsDir(): string {
  return keelsonPaths().workflowsDir;
}

// Default SQLite path — `keelson.db` under the keelson home. Mirrors the
// server's resolution and honors the KEELSON_DB override.
export function defaultDbPath(): string {
  return keelsonPaths().dbPath;
}
