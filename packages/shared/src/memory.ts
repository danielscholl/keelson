// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Memory layer hook seam (Phase 4 / W5).
 *
 * Declaration-only placeholder. Phase 4.5 fills the contract in per
 * `docs/agent-memory.md` (schema axes, provenance, use-policy, recall/
 * writeback). v1 only ships the type so the workflow executor's
 * `NodeContext.memory?: MemoryTools` slot and the prompt-handler factory's
 * `lifecycle.{beforeNode, afterNode}` hooks have a name to bind to.
 */

export interface MemoryTools {
	readonly __phase: "4.5-pending";
}
