// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export * from "./schema/index.ts";

export {
  parseWorkflow,
  discoverWorkflows,
  type ParseResult,
  type WorkflowLoadWarning,
  type DiscoveryRoot,
  type DiscoveryResult,
} from "./loader.ts";

export {
  validateDagShape,
  buildTopologicalLayers,
  type DagShapeError,
} from "./graph.ts";

export { evaluateCondition } from "./conditions.ts";

export {
  shellQuote,
  substituteWorkflowVariables,
  substituteNodeOutputRefs,
} from "./substitute.ts";

export { checkTriggerRule } from "./triggers.ts";

export {
	runWorkflow,
	resolveBody,
	ExecutorValidationError,
	type NodeHandler,
	type NodeContext,
	type NodeResult,
	type NodeOutputBody,
	type NodeStreamEvent,
	type MemoryTools,
	type RunOptions,
	type RunStreamEvent,
	type RunStatus,
	type RunSummary,
} from "./executor.ts";

export { bashHandler, makeBashHandler, type MakeBashHandlerOptions } from "./handlers/bash.ts";

export {
	makePromptHandler,
	DEFAULT_TOOL_DENYLIST,
	type MakePromptHandlerOptions,
	type PromptHandlerProvider,
	type PromptHandlerSendOptions,
	type PromptHandlerLifecycle,
} from "./handlers/prompt.ts";

export {
	makeApprovalHandler,
	type AwaitApproval,
	type MakeApprovalHandlerOptions,
} from "./handlers/approval.ts";

export {
	makeCancelHandler,
	type RequestCancel,
	type MakeCancelHandlerOptions,
} from "./handlers/cancel.ts";

export {
	makeCommandHandler,
	type MakeCommandHandlerOptions,
} from "./handlers/command.ts";

export {
	scriptHandler,
	makeScriptHandler,
	type MakeScriptHandlerOptions,
} from "./handlers/script.ts";

export {
	makeLoopHandler,
	type MakeLoopHandlerOptions,
} from "./handlers/loop.ts";

export {
	resolveCommand,
	resolveScript,
	isValidCommandName,
	type ResolvedCommand,
	type ResolvedScript,
	type ScriptRuntime,
} from "./handlers/discovery.ts";
