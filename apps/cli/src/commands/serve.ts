// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { resolve } from "node:path";

import { EXIT_FAIL } from "../exit.ts";

export interface ServeOptions {
  db?: string;
  json: boolean;
}

// Resolve the workspace's server entry from the CLI source location so the
// command keeps working whether invoked via `bun apps/cli/bin/keelson.ts`,
// a global symlink, or `bun apps/cli/src/commands/serve.ts` directly. This
// path is the repo-internal target and is not part of the public surface.
function serverEntryPath(): string {
  // src/commands/serve.ts  →  ../../../server/src/index.ts
  return resolve(import.meta.dir, "..", "..", "..", "server", "src", "index.ts");
}

function workspaceRoot(): string {
  // src/commands/serve.ts  →  ../../../.. (monorepo root)
  return resolve(import.meta.dir, "..", "..", "..", "..");
}

export async function runServe(opts: ServeOptions): Promise<never> {
  const entry = serverEntryPath();
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts.db) env.KEELSON_DB = opts.db;

  // `detached: true` makes the child its own session/process-group leader
  // (POSIX setsid). The terminal then delivers SIGINT only to the parent's
  // foreground group, never the child — so our forwarder is the single
  // source of shutdown signals and the server's graceful-shutdown chain in
  // apps/server/src/index.ts runs exactly once for any of: Ctrl-C in a TTY,
  // `kill -INT <keelson-pid>`, `kill -TERM <keelson-pid>`, or a supervisor
  // sending SIGTERM. Without detach, an interactive Ctrl-C would race with
  // our forward and double-fire the server's drain → db.close path.
  const proc = Bun.spawn(["bun", entry], {
    // Pin cwd to the workspace root so agent execution and `process.cwd()`-
    // based paths (chat handlers, provider state) resolve against the
    // Keelson repo even when `keelson serve` is invoked from elsewhere via
    // an alias.
    cwd: workspaceRoot(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
    env,
  });

  const forwarded = new Set<NodeJS.Signals>();
  const forward = (sig: NodeJS.Signals) => {
    if (forwarded.has(sig)) return;
    forwarded.add(sig);
    try {
      proc.kill(sig);
    } catch {
      // Child may already be gone — ignore.
    }
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  // SIGHUP arrives when an SSH session closes or the controlling terminal
  // goes away. Translate it to SIGTERM so the server runs its graceful
  // shutdown chain instead of being orphaned.
  const onSighup = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  try {
    await proc.exited;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
  }

  const code = proc.exitCode ?? EXIT_FAIL;
  process.exit(code);
}
