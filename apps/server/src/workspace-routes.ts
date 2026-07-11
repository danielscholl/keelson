// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Hono } from "hono";
import type { WorkspaceLeaseStore } from "./workspace-lease-store.ts";

export interface WorkspaceRoutesOptions {
  store: WorkspaceLeaseStore;
}

export function workspaceRoutes(app: Hono, opts: WorkspaceRoutesOptions): void {
  const { store } = opts;

  app.get("/api/workspaces/leases", (c) => {
    // Pending rows are crash-recovery bookkeeping, not operator-facing leases.
    return c.json({ leases: store.list().filter((lease) => lease.status === "active") });
  });
}
