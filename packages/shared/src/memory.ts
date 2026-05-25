// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Memory layer hook seam.
 *
 * Declaration-only placeholder — only the type ships today so the workflow
 * executor's `NodeContext.memory?: MemoryTools` slot and the prompt-handler
 * factory's `lifecycle.{beforeNode, afterNode}` hooks have a name to bind to.
 * A future memory layer fills in the contract (schema axes, provenance,
 * use-policy, recall/writeback).
 */

export interface MemoryTools {
  readonly __phase: "pending";
}
