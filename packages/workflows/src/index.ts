// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export { evaluateCondition } from "./conditions.ts";
export {
  ExecutorValidationError,
  type MemoryTools,
  type NodeContext,
  type NodeHandler,
  type NodeOutputBody,
  type NodeResult,
  type NodeStreamEvent,
  type RunOptions,
  type RunStatus,
  type RunStreamEvent,
  type RunSummary,
  resolveBody,
  runWorkflow,
} from "./executor.ts";

export {
  buildTopologicalLayers,
  type DagShapeError,
  validateDagShape,
} from "./graph.ts";
export {
  type AwaitApproval,
  type AwaitInteraction,
  type MakeApprovalHandlerOptions,
  makeApprovalHandler,
} from "./handlers/approval.ts";
export { bashHandler, type MakeBashHandlerOptions, makeBashHandler } from "./handlers/bash.ts";
export {
  type MakeCancelHandlerOptions,
  makeCancelHandler,
  type RequestCancel,
} from "./handlers/cancel.ts";
export {
  type MakeCommandHandlerOptions,
  makeCommandHandler,
} from "./handlers/command.ts";
export {
  isValidCommandName,
  type ResolvedCommand,
  type ResolvedScript,
  resolveCommand,
  resolveScript,
  type ScriptRuntime,
} from "./handlers/discovery.ts";
export {
  defaultRunUntilBashProbe,
  type MakeLoopHandlerOptions,
  makeLoopHandler,
  type RunUntilBashProbe,
  type RunUntilBashProbeOptions,
  UNTIL_BASH_TIMEOUT_MS,
  type UntilBashResult,
} from "./handlers/loop.ts";
export {
  DEFAULT_TOOL_DENYLIST,
  type MakePromptHandlerOptions,
  makePromptHandler,
  type PromptHandlerLifecycle,
  type PromptHandlerProvider,
  type PromptHandlerSendOptions,
} from "./handlers/prompt.ts";
export {
  type MakeScriptHandlerOptions,
  makeScriptHandler,
  scriptHandler,
} from "./handlers/script.ts";
export {
  type DiscoveryResult,
  type DiscoveryRoot,
  discoverWorkflows,
  type ParseResult,
  parseWorkflow,
  type WorkflowLoadWarning,
} from "./loader.ts";
export * from "./schema/index.ts";
export {
  shellQuote,
  substituteNodeOutputRefs,
  substituteWorkflowVariables,
} from "./substitute.ts";
export { checkTriggerRule } from "./triggers.ts";
export {
  type BranchTemplateContext,
  type CreateWorktreeOptions,
  type CreateWorktreeResult,
  createWorktree,
  isGitRepo,
  listWorktrees,
  NotAGitRepoError,
  type RemoveWorktreeOptions,
  type RemoveWorktreeResult,
  removeWorktree,
  repoPathFromWorktree,
  resolveBranchTemplate,
  WorktreeCreationError,
  worktreePathForRepoLocal,
} from "./worktree.ts";
