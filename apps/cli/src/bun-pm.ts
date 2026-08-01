// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

// Run `bun <args>` in the home and return its exit code. In JSON mode bun's
// output is discarded (`ignore`) so the envelope is the only thing on stdout —
// and, critically, piped-but-undrained stdio would deadlock once bun's output
// exceeds the OS pipe buffer (a `bun add github:…` clone easily does). Human
// mode inherits bun's progress.
export async function runBunPm(args: string[], home: string, quiet: boolean): Promise<number> {
  const proc = Bun.spawn(["bun", ...args], {
    cwd: home,
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
    windowsHide: true,
  });
  return await proc.exited;
}

export async function runBunPmCaptured(
  args: string[],
  home: string,
  quiet: boolean,
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", ...args], {
    cwd: home,
    stdout: quiet ? "ignore" : "inherit",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (!quiet && stderr.length > 0) process.stderr.write(stderr);
  return { code, stderr };
}
