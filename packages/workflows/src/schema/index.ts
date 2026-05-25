/**
 * Re-export surface for workflow schemas.
 *
 * All schemas are re-exported from this index. Types are derived from schemas
 * via `z.infer<typeof Schema>` (WorkflowDefinition uses `Omit<...>` because
 * node parsing happens per-node in loader.ts).
 */

// Command name validation
export { isValidCommandName } from './command-validation.ts';

// Retry configuration
export { stepRetryConfigSchema } from './retry.ts';
export type { StepRetryConfig } from './retry.ts';

// Loop node configuration
export { loopNodeConfigSchema } from './loop.ts';
export type { LoopNodeConfig } from './loop.ts';

// Hooks
export {
	workflowHookEventSchema,
	workflowHookMatcherSchema,
	workflowNodeHooksSchema,
	WORKFLOW_HOOK_EVENTS,
} from './hooks.ts';
export type { WorkflowHookEvent, WorkflowHookMatcher, WorkflowNodeHooks } from './hooks.ts';

// DAG node types
export {
	triggerRuleSchema,
	TRIGGER_RULES,
	dagNodeBaseSchema,
	commandNodeSchema,
	promptNodeSchema,
	bashNodeSchema,
	loopNodeSchema,
	approvalNodeSchema,
	approvalOnRejectSchema,
	cancelNodeSchema,
	scriptNodeSchema,
	dagNodeSchema,
	isBashNode,
	isLoopNode,
	isApprovalNode,
	isCancelNode,
	isScriptNode,
	isTriggerRule,
	BASH_NODE_AI_FIELDS,
	SCRIPT_NODE_AI_FIELDS,
	LOOP_NODE_AI_FIELDS,
	effortLevelSchema,
	thinkingConfigSchema,
	sandboxSettingsSchema,
	agentDefinitionSchema,
} from './dag-node.ts';
export type {
	TriggerRule,
	DagNodeBase,
	CommandNode,
	PromptNode,
	BashNode,
	LoopNode,
	ApprovalNode,
	ApprovalOnReject,
	CancelNode,
	ScriptNode,
	DagNode,
	EffortLevel,
	ThinkingConfig,
	SandboxSettings,
	AgentDefinition,
} from './dag-node.ts';

// Workflow definition
export {
	modelReasoningEffortSchema,
	webSearchModeSchema,
	workflowBaseSchema,
	workflowDefinitionSchema,
} from './workflow.ts';
export type {
	ModelReasoningEffort,
	WebSearchMode,
	WorkflowBase,
	WorkflowDefinition,
	LoadCommandResult,
	WorkflowExecutionResult,
	WorkflowLoadError,
	WorkflowLoadResult,
	WorkflowSource,
	WorkflowWithSource,
} from './workflow.ts';

// Workflow run state
export {
	workflowRunStatusSchema,
	workflowStepStatusSchema,
	nodeStateSchema,
	nodeOutputSchema,
	tokenUsageSchema,
	workflowRunSchema,
	artifactTypeSchema,
	TERMINAL_WORKFLOW_STATUSES,
	RESUMABLE_WORKFLOW_STATUSES,
	isApprovalContext,
} from './workflow-run.ts';
export type {
	WorkflowRunStatus,
	WorkflowStepStatus,
	NodeState,
	NodeOutput,
	TokenUsage,
	WorkflowRun,
	ArtifactType,
	ApprovalContext,
} from './workflow-run.ts';
