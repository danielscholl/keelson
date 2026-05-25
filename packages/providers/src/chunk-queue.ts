// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { MessageChunk } from "./types.ts";

// Producers push synchronously (Copilot session events; Claude tool emit
// closures); consumer awaits next(). Close-once semantics keep racing
// terminal events (session.idle + session.error, abort + idle) from
// deadlocking. Async-queue shape is load-bearing so a tool's emissions
// don't buffer until the next SDK message — would break long-running tools.
export class ChunkQueue {
  private buffer: MessageChunk[] = [];
  private pending: ((v: MessageChunk | null) => void) | null = null;
  private closed = false;

  push(chunk: MessageChunk): void {
    if (this.closed) return;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve(chunk);
      return;
    }
    this.buffer.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve(null);
    }
  }

  async next(): Promise<MessageChunk | null> {
    if (this.buffer.length > 0) {
      return this.buffer.shift()!;
    }
    if (this.closed) return null;
    return new Promise<MessageChunk | null>((resolve) => {
      this.pending = resolve;
    });
  }
}
