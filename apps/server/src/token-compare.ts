// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { createHash, timingSafeEqual } from "node:crypto";

// Constant-time bearer-token comparison. Hashing both sides first gives
// timingSafeEqual equal-length buffers regardless of the presented value's
// length. Shared by the shutdown and MCP token gates.
export function constantTimeTokenEqual(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
