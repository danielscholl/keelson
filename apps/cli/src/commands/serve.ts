// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { serveUntilSignal } from "@keelson/server";
import { EXIT_FAIL } from "../exit.ts";

export interface ServeOptions {
  db?: string;
  json: boolean;
}

// Run the server in-process and block until a termination signal. serveUntilSignal
// builds the database/ribs/routes, installs the SIGINT/SIGTERM/SIGHUP →
// graceful-shutdown handlers, and never returns (it process.exits on signal).
export async function runServe(opts: ServeOptions): Promise<never> {
  try {
    return await serveUntilSignal(opts.db ? { dbPath: opts.db } : {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`failed to start server: ${msg}\n`);
    process.exit(EXIT_FAIL);
  }
}
