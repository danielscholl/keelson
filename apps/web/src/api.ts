import {
  type AgentRef,
  type ApprovalDecision,
  type BulkDeleteRunsBody,
  bulkDeleteRunsResponseSchema,
  type ClaudeCliStatus,
  type CloneProjectBody,
  type CommandCompletion,
  type CommandInvokeResult,
  type CommandRef,
  type Conversation,
  type CopilotCliStatus,
  type CreateProjectBody,
  type CreateProjectResponse,
  type CredentialStatus,
  claudeCliStatusSchema,
  commandInvokeResultSchema,
  copilotCliStatusSchema,
  createProjectResponseSchema,
  credentialStatusSchema,
  type GetRunArtifactResponse,
  getRunArtifactResponseSchema,
  getWorkflowDetailResponseSchema,
  getWorkflowRunResponseSchema,
  type ListWorkflowsResponse,
  listAgentsResponseSchema,
  listCommandCompletionsResponseSchema,
  listCommandsResponseSchema,
  listProjectsResponseSchema,
  listRibsResponseSchema,
  listRunsResponseSchema,
  listWorkflowsResponseSchema,
  type MemoryListQuery,
  type MemoryListResponse,
  type ModelInfo,
  memoryListResponseSchema,
  type OpenChatSeed,
  openChatSeedSchema,
  type Project,
  type ProviderInfo,
  type RegisteredToolInfo,
  type RememberChatMessageRequest,
  type RememberChatMessageResponse,
  type ReviewActionRequest,
  type ReviewActionResponse,
  type ReviewListQuery,
  type ReviewListResponse,
  type RibAction,
  type RibActionResponse,
  type RibSummary,
  rememberChatMessageResponseSchema,
  reviewActionResponseSchema,
  reviewListResponseSchema,
  ribActionResponseSchema,
  type SnapshotFrame,
  snapshotFrameSchema,
  startWorkflowRunResponseSchema,
  type UpdateProjectBody,
  type UsageBreakdownResponseWire,
  type UsageEventSourceWire,
  type UsageEventsResponseWire,
  type UsageSeriesResponseWire,
  type UsageSummaryResponseWire,
  usageBreakdownResponseSchema,
  usageEventsResponseSchema,
  usageSeriesResponseSchema,
  usageSummaryResponseSchema,
  type WorkflowDetail,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
} from "@keelson/shared";

export interface ServerConfig {
  schemaVersion: string;
  wireProtocolVersion: string;
}

type ApiErrorBody = "text" | "json-error";

interface ApiRequestOptions<TAllowed = never> extends RequestInit {
  label?: string;
  errorBody?: ApiErrorBody;
  responseBody?: "json" | "void";
  allowedStatuses?: readonly number[];
  allowedStatusValue?: TAllowed;
  emptyTextFallback?: "statusText" | "empty";
}

async function apiRequest<T, TAllowed = never>(
  path: string,
  options: ApiRequestOptions<TAllowed> = {},
): Promise<T | TAllowed> {
  const {
    label = path,
    errorBody = "text",
    responseBody = "json",
    allowedStatuses = [],
    allowedStatusValue,
    emptyTextFallback = "statusText",
    ...init
  } = options;
  const res = await fetch(path, init);
  if (allowedStatuses.includes(res.status)) {
    return allowedStatusValue as TAllowed;
  }
  if (!res.ok) {
    if (errorBody === "json-error") {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const msg = body?.error ?? `${res.status} ${res.statusText}`;
      throw new Error(`${label}: ${msg}`);
    }
    const text = await res.text().catch(() => "");
    const detail = text || (emptyTextFallback === "statusText" ? res.statusText : "");
    throw new Error(`${label} ${res.status}: ${detail}`);
  }
  if (responseBody === "void") {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// Boot-time constants from the server. Defensive: malformed/missing fields
// fall back to empty strings so a stale server can't brick the SPA boot.
export async function fetchConfig(): Promise<ServerConfig> {
  const body = await apiRequest<{
    schemaVersion?: unknown;
    wireProtocolVersion?: unknown;
  }>("/api/config");
  return {
    schemaVersion: typeof body.schemaVersion === "string" ? body.schemaVersion : "",
    wireProtocolVersion:
      typeof body.wireProtocolVersion === "string" ? body.wireProtocolVersion : "",
  };
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  // The provider the picker should preselect; null when the server didn't
  // resolve one (e.g. nothing chat-capable registered).
  defaultProvider: string | null;
}

export async function fetchProviders(): Promise<ProvidersResponse> {
  const body = await apiRequest<{ providers: ProviderInfo[]; defaultProvider?: string }>(
    "/api/providers",
  );
  return { providers: body.providers, defaultProvider: body.defaultProvider ?? null };
}

export async function fetchProviderModels(providerId: string): Promise<ModelInfo[]> {
  const body = await apiRequest<{ models: ModelInfo[] }>(
    `/api/providers/${encodeURIComponent(providerId)}/models`,
    { label: `/api/providers/${providerId}/models` },
  );
  return body.models;
}

export async function fetchTools(): Promise<RegisteredToolInfo[]> {
  const body = await apiRequest<{ tools: RegisteredToolInfo[] }>("/api/tools");
  return body.tools;
}

export interface ProjectNotebook {
  content: string;
  updatedAt: string | null;
}

export async function getProjectNotebook(projectId: string): Promise<ProjectNotebook> {
  return apiRequest<ProjectNotebook>(`/api/projects/${encodeURIComponent(projectId)}/notebook`, {
    label: `/api/projects/${projectId}/notebook`,
  });
}

export async function putProjectNotebook(
  projectId: string,
  content: string,
): Promise<ProjectNotebook> {
  return apiRequest<ProjectNotebook>(`/api/projects/${encodeURIComponent(projectId)}/notebook`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
    label: `/api/projects/${projectId}/notebook`,
  });
}

// `previousContent` is the notebook before the append, so a one-click Undo can
// restore it with a follow-up putProjectNotebook (last-write-wins).
export interface ProjectNotebookAppend extends ProjectNotebook {
  previousContent: string;
}

export async function appendProjectNotebook(
  projectId: string,
  entry: string,
  section?: string,
): Promise<ProjectNotebookAppend> {
  return apiRequest<ProjectNotebookAppend>(
    `/api/projects/${encodeURIComponent(projectId)}/notebook/append`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entry, ...(section !== undefined ? { section } : {}) }),
      label: `/api/projects/${projectId}/notebook/append`,
    },
  );
}

// `archivedCount` is how many log entries Tidy moved to `## Archive`; 0 means the
// notebook was already within the injection budget.
export interface ProjectNotebookTidy extends ProjectNotebookAppend {
  archivedCount: number;
}

export async function tidyProjectNotebook(projectId: string): Promise<ProjectNotebookTidy> {
  return apiRequest<ProjectNotebookTidy>(
    `/api/projects/${encodeURIComponent(projectId)}/notebook/tidy`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      label: `/api/projects/${projectId}/notebook/tidy`,
    },
  );
}

// Returns null on 404 so callers can distinguish "server lost the conversation"
// from a real network/server error.
export async function getConversation(id: string): Promise<Conversation | null> {
  return apiRequest<Conversation, null>(`/api/conversations/${encodeURIComponent(id)}`, {
    label: `/api/conversations/${id}`,
    allowedStatuses: [404],
    allowedStatusValue: null,
  });
}

export async function listConversations(): Promise<Conversation[]> {
  const body = await apiRequest<{ conversations: Conversation[] }>("/api/conversations");
  return body.conversations;
}

export async function renameConversation(id: string, name: string): Promise<Conversation> {
  return apiRequest<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
    label: `/api/conversations/${id}`,
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await apiRequest<void>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    responseBody: "void",
    label: `/api/conversations/${id}`,
  });
}

export interface CreateConversationOptions {
  model?: string;
  seedSystemPrompt?: string;
  name?: string;
  projectId?: string;
}

export async function createConversation(
  providerId: string,
  options: CreateConversationOptions = {},
): Promise<Conversation> {
  return apiRequest<Conversation>("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId,
      ...(options.model ? { model: options.model } : {}),
      ...(options.seedSystemPrompt ? { seedSystemPrompt: options.seedSystemPrompt } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
    }),
  });
}

export async function setCredential(serviceId: string, value: string): Promise<void> {
  await apiRequest<void>(`/api/credentials/${encodeURIComponent(serviceId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
    responseBody: "void",
    label: `/api/credentials/${serviceId}`,
  });
}

export async function deleteCredential(serviceId: string): Promise<void> {
  await apiRequest<void>(`/api/credentials/${encodeURIComponent(serviceId)}`, {
    method: "DELETE",
    responseBody: "void",
    label: `/api/credentials/${serviceId}`,
  });
}

export async function getCredentialStatus(serviceId: string): Promise<CredentialStatus> {
  return credentialStatusSchema.parse(
    await apiRequest<unknown>(`/api/credentials/${encodeURIComponent(serviceId)}/status`, {
      label: `/api/credentials/${serviceId}/status`,
    }),
  );
}

export async function getCopilotCliStatus(): Promise<CopilotCliStatus> {
  return copilotCliStatusSchema.parse(
    await apiRequest<unknown>("/api/credentials/copilot/cli-status"),
  );
}

export async function getClaudeCliStatus(): Promise<ClaudeCliStatus> {
  return claudeCliStatusSchema.parse(
    await apiRequest<unknown>("/api/credentials/claude/cli-status"),
  );
}

// --- Workflow surface ---

// projectId narrows the catalog to that project's view (its workflows
// overlaid on global); omitted = global only.
export async function listWorkflows(projectId?: string): Promise<ListWorkflowsResponse> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return listWorkflowsResponseSchema.parse(await apiRequest<unknown>(`/api/workflows${query}`));
}

export async function getWorkflowDetail(name: string, projectId?: string): Promise<WorkflowDetail> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return getWorkflowDetailResponseSchema.parse(
    await apiRequest<unknown>(`/api/workflows/${encodeURIComponent(name)}${query}`, {
      label: `/api/workflows/${name}`,
    }),
  ).workflow;
}

export async function listRuns(workflowName: string): Promise<WorkflowRunSummary[]> {
  return listRunsResponseSchema.parse(
    await apiRequest<unknown>(`/api/workflows/${encodeURIComponent(workflowName)}/runs`, {
      label: `/api/workflows/${workflowName}/runs`,
    }),
  ).runs;
}

// Drives the paused-runs badge on the Workflows nav.
export async function listPausedRuns(): Promise<WorkflowRunSummary[]> {
  return listRunsResponseSchema.parse(
    await apiRequest<unknown>("/api/workflows/runs?status=paused"),
  ).runs;
}

export interface ListWorkflowRunsFilter {
  // "manual" | "scheduled" — omit for both. The runs feed defaults to manual.
  origin?: "manual" | "scheduled";
  ribId?: string;
  workflow?: string;
  status?: WorkflowRunSummary["status"];
  limit?: number;
}

// General runs feed (one request for the whole table, vs. one per workflow).
// Filterable by origin / rib / workflow / status server-side.
export async function listWorkflowRuns(
  filter: ListWorkflowRunsFilter = {},
): Promise<WorkflowRunSummary[]> {
  const qs = new URLSearchParams();
  if (filter.origin) qs.set("origin", filter.origin);
  if (filter.ribId) qs.set("ribId", filter.ribId);
  if (filter.workflow) qs.set("workflow", filter.workflow);
  if (filter.status) qs.set("status", filter.status);
  if (filter.limit !== undefined) qs.set("limit", String(filter.limit));
  const suffix = qs.toString();
  return listRunsResponseSchema.parse(
    await apiRequest<unknown>(`/api/workflows/runs${suffix ? `?${suffix}` : ""}`, {
      label: "/api/workflows/runs",
    }),
  ).runs;
}

// Delete a group of runs in one call — explicit ids or a filter (e.g. every
// scheduled run, or all runs owned by a rib). Cancels in-flight runs and
// cascades linked conversations, same as single delete. Returns the count.
export async function bulkDeleteWorkflowRuns(body: BulkDeleteRunsBody): Promise<number> {
  const res = await apiRequest<unknown>("/api/workflows/runs/bulk-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    errorBody: "json-error",
    label: "/api/workflows/runs/bulk-delete",
  });
  return bulkDeleteRunsResponseSchema.parse(res).deleted;
}

export interface StartWorkflowRunOptions {
  inputs?: Record<string, string>;
  projectId?: string;
  workingDir?: string;
  isolation?: "worktree" | "none";
}

export async function startWorkflowRun(
  workflowName: string,
  options: StartWorkflowRunOptions = {},
): Promise<{ runId: string; workflowName?: string }> {
  return startWorkflowRunResponseSchema.parse(
    await apiRequest<unknown>(`/api/workflows/${encodeURIComponent(workflowName)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inputs: options.inputs ?? {},
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.workingDir ? { workingDir: options.workingDir } : {}),
        ...(options.isolation ? { isolation: options.isolation } : {}),
      }),
      errorBody: "json-error",
      label: `/api/workflows/${workflowName}/runs`,
    }),
  );
}

// Re-run a rib producer workflow to repopulate its bound snapshot key (a surface
// panel's refresh). The server owns the working dir, so no body is needed.
export async function refreshWorkflow(
  workflowName: string,
): Promise<{ runId: string; workflowName?: string }> {
  return startWorkflowRunResponseSchema.parse(
    await apiRequest<unknown>(`/api/workflows/${encodeURIComponent(workflowName)}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      errorBody: "json-error",
      label: `/api/workflows/${workflowName}/refresh`,
    }),
  );
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  return getWorkflowRunResponseSchema.parse(
    await apiRequest<unknown>(`/api/workflows/runs/${encodeURIComponent(runId)}`, {
      label: `/api/workflows/runs/${runId}`,
    }),
  ).run;
}

// Fetch a file from a run's sandboxed artifacts dir. Returns null on 410 — the
// dir only exists while the run is live/paused, so a finished/unknown run reads
// as "no longer available". A 404 (missing file in a live run) still throws.
export async function getRunArtifact(
  runId: string,
  path: string,
): Promise<GetRunArtifactResponse | null> {
  const res = await apiRequest<unknown, null>(
    `/api/workflows/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(path)}`,
    {
      label: `/api/workflows/runs/${runId}/artifact`,
      errorBody: "json-error",
      allowedStatuses: [410],
      allowedStatusValue: null,
    },
  );
  return res === null ? null : getRunArtifactResponseSchema.parse(res);
}

export type SnapshotFetch =
  | { kind: "frame"; frame: SnapshotFrame }
  | { kind: "pending" }
  | { kind: "gone" };

// Hydrate a snapshot key. 200 → the latest frame; 204 → registered but not yet
// composed ("pending", keep waiting); 404 → unregistered/unknown ("gone", the
// producer dropped it). The live hook needs pending-vs-gone to decide whether
// to keep the socket open or stop reconnecting.
export async function getSnapshot(key: string): Promise<SnapshotFetch> {
  const res = await fetch(`/api/snapshots/${encodeURIComponent(key)}`);
  if (res.status === 204) return { kind: "pending" };
  if (res.status === 404) return { kind: "gone" };
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/api/snapshots/${key} ${res.status}: ${detail}`);
  }
  return { kind: "frame", frame: snapshotFrameSchema.parse(await res.json()) };
}

// Resolve a pending policy ASK approval. 404 (already resolved / timed out) is
// surfaced as an error the dock swallows — a stale resolve shouldn't toast.
export async function resolveApproval(id: string, decision: ApprovalDecision): Promise<void> {
  await apiRequest<void>(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
    responseBody: "void",
    label: `/api/approvals/${id}`,
  });
}

// 404 is treated as "already done / unknown" — surface no error so the UI
// doesn't toast when the Cancel button raced a `run_done` frame.
export async function cancelWorkflowRun(runId: string): Promise<void> {
  await apiRequest<void, void>(`/api/workflows/runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
    responseBody: "void",
    allowedStatuses: [404],
    allowedStatusValue: undefined,
    label: `/api/workflows/runs/${runId} DELETE`,
  });
}

// Hard-delete a run row + its linked conversation. Cancels in-flight runs
// first as part of the same call.
export async function deleteWorkflowRun(runId: string): Promise<void> {
  await apiRequest<void, void>(`/api/workflows/runs/${encodeURIComponent(runId)}?purge=1`, {
    method: "DELETE",
    responseBody: "void",
    allowedStatuses: [404],
    allowedStatusValue: undefined,
    label: `/api/workflows/runs/${runId}?purge=1 DELETE`,
  });
}

/**
 * Thrown by `submitApproval` when the server rejects a resume because the
 * supplied `pauseId` doesn't match the current pause (the loop has moved
 * to a new iteration, or another client already resumed this one). The
 * caller should refetch the run state and let the user retry against the
 * new pauseId.
 */
export class StalePauseError extends Error {
  constructor(message = "pauseId mismatch — pause has advanced") {
    super(message);
    this.name = "StalePauseError";
  }
}

// Resume a paused approval node. Text becomes $<nodeId>.output.
// `pauseId`, when provided, is verified server-side. 404 always falls
// through as a soft no-op (run gone). 409 is a soft no-op ONLY when no
// pauseId was sent (legacy double-submit case); when a pauseId was sent,
// a 409 indicates a real mismatch and surfaces via `StalePauseError` so
// the caller can refetch and prompt the user — silently swallowing it
// would clear the composer text while the UI keeps stale state.
export async function submitApproval(
  runId: string,
  nodeId: string,
  text: string,
  pauseId?: string,
): Promise<void> {
  const url = `/api/workflows/runs/${encodeURIComponent(runId)}/resume`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pauseId !== undefined ? { nodeId, text, pauseId } : { nodeId, text }),
  });
  if (res.ok) return;
  if (res.status === 404) return;
  if (res.status === 409) {
    if (pauseId !== undefined) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new StalePauseError(body?.error);
    }
    return;
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `submitApproval failed: ${res.status}`);
}

// === Memory ================================================================

function buildMemoryListQuery(query: ReviewListQuery | MemoryListQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// Pending review queue — the Memory tab opens on this by default.
export async function listPendingMemories(
  query: ReviewListQuery = {},
): Promise<ReviewListResponse> {
  return reviewListResponseSchema.parse(
    await apiRequest<unknown>(`/api/memory/review${buildMemoryListQuery(query)}`),
  );
}

// Browsable list across review statuses + lifecycles — backs the "All" sub-tab.
export async function listMemories(query: MemoryListQuery = {}): Promise<MemoryListResponse> {
  return memoryListResponseSchema.parse(
    await apiRequest<unknown>(`/api/memory/list${buildMemoryListQuery(query)}`),
  );
}

export async function postReviewAction(req: ReviewActionRequest): Promise<ReviewActionResponse> {
  return reviewActionResponseSchema.parse(
    await apiRequest<unknown>("/api/memory/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      errorBody: "json-error",
    }),
  );
}

// === Ribs ==================================================================

export async function getRibs(): Promise<RibSummary[]> {
  return listRibsResponseSchema.parse(await apiRequest<unknown>("/api/ribs")).ribs;
}

export async function postRibAction(id: string, action: RibAction): Promise<RibActionResponse> {
  return ribActionResponseSchema.parse(
    await apiRequest<unknown>(`/api/ribs/${encodeURIComponent(id)}/action`, {
      label: `/api/ribs/${id}/action`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
      errorBody: "json-error",
    }),
  );
}

// === Usage ==================================================================

export type UsageWindow = "24h" | "7d" | "30d";
export type UsageGroupBy = "model" | "provider" | "source" | "rib" | "workflow";
export type UsageSeriesBucket = "hour" | "day";

function buildUsageQuery(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export interface UsageSummaryQuery {
  window?: UsageWindow;
  groupBy?: UsageGroupBy;
}

export async function getUsageSummary(
  query: UsageSummaryQuery = {},
): Promise<UsageSummaryResponseWire> {
  const qs = buildUsageQuery({ window: query.window, groupBy: query.groupBy });
  return usageSummaryResponseSchema.parse(
    await apiRequest<unknown>(`/api/usage/summary${qs}`, { label: "/api/usage/summary" }),
  );
}

export interface UsageSeriesQuery {
  window?: UsageWindow;
  groupBy?: UsageGroupBy;
  bucket?: UsageSeriesBucket;
}

export async function getUsageSeries(
  query: UsageSeriesQuery = {},
): Promise<UsageSeriesResponseWire> {
  const qs = buildUsageQuery({
    window: query.window,
    groupBy: query.groupBy,
    bucket: query.bucket,
  });
  return usageSeriesResponseSchema.parse(
    await apiRequest<unknown>(`/api/usage/series${qs}`, { label: "/api/usage/series" }),
  );
}

export interface UsageBreakdownQuery {
  window?: UsageWindow;
  groupBy?: UsageGroupBy;
  splitBy?: UsageGroupBy;
}

export async function getUsageBreakdown(
  query: UsageBreakdownQuery = {},
): Promise<UsageBreakdownResponseWire> {
  const qs = buildUsageQuery({
    window: query.window,
    groupBy: query.groupBy,
    splitBy: query.splitBy,
  });
  return usageBreakdownResponseSchema.parse(
    await apiRequest<unknown>(`/api/usage/breakdown${qs}`, { label: "/api/usage/breakdown" }),
  );
}

export interface UsageEventsQuery {
  window?: UsageWindow;
  limit?: number;
  source?: UsageEventSourceWire;
  model?: string;
  status?: string;
}

export async function getUsageEvents(
  query: UsageEventsQuery = {},
): Promise<UsageEventsResponseWire> {
  const qs = buildUsageQuery({
    window: query.window,
    limit: query.limit,
    source: query.source,
    model: query.model,
    status: query.status,
  });
  return usageEventsResponseSchema.parse(
    await apiRequest<unknown>(`/api/usage/events${qs}`, { label: "/api/usage/events" }),
  );
}

// === Agents (the GET /api/agents source) ===================================

export async function getAgents(): Promise<AgentRef[]> {
  return listAgentsResponseSchema.parse(await apiRequest<unknown>("/api/agents")).agents;
}

export async function resolveAgent(ribId: string, slug: string): Promise<OpenChatSeed> {
  return openChatSeedSchema.parse(
    await apiRequest<unknown>(
      `/api/agents/${encodeURIComponent(ribId)}/${encodeURIComponent(slug)}/resolve`,
      { label: "/api/agents/resolve", method: "POST", errorBody: "json-error" },
    ),
  );
}

// === Commands (rib-contributed slash commands) =============================

// Merged with the surface's base commands (project / workflow) into the slash menu.
export async function getCommands(): Promise<CommandRef[]> {
  return listCommandsResponseSchema.parse(await apiRequest<unknown>("/api/commands")).commands;
}

// Argument type-ahead for a rib command whose descriptor sets argument.completes.
// Propagates failures rather than swallowing them: the caller catches and leaves
// its cache unset so a transient error retries on re-entry, instead of caching an
// empty result that suppresses completions for the rest of the session.
export async function completeRibCommand(
  ribId: string,
  name: string,
  prefix: string,
): Promise<CommandCompletion[]> {
  const url = `/api/commands/${encodeURIComponent(ribId)}/${encodeURIComponent(name)}/complete?prefix=${encodeURIComponent(prefix)}`;
  return listCommandCompletionsResponseSchema.parse(await apiRequest<unknown>(url, { label: url }))
    .completions;
}

// Invoke a rib command; the returned effect is performed by the caller. A
// rib-level failure ({ ok: false }) arrives as a 200, so it's a normal return.
export async function invokeRibCommand(
  ribId: string,
  name: string,
  arg: string,
): Promise<CommandInvokeResult> {
  const url = `/api/commands/${encodeURIComponent(ribId)}/${encodeURIComponent(name)}/invoke`;
  return commandInvokeResultSchema.parse(
    await apiRequest<unknown>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arg }),
      errorBody: "json-error",
      label: url,
    }),
  );
}

// === Projects ==============================================================

export async function listProjects(): Promise<Project[]> {
  const body = listProjectsResponseSchema.parse(await apiRequest<unknown>("/api/projects"));
  return body.projects;
}

export async function createProject(input: CreateProjectBody): Promise<Project> {
  const body = createProjectResponseSchema.parse(
    await apiRequest<CreateProjectResponse>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      errorBody: "json-error",
    }),
  );
  return body.project;
}

export async function deleteProject(id: string): Promise<void> {
  await apiRequest<void>(`/api/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
    responseBody: "void",
    errorBody: "json-error",
    label: `/api/projects/${id} DELETE`,
  });
}

export async function cloneProject(input: CloneProjectBody): Promise<Project> {
  const body = createProjectResponseSchema.parse(
    await apiRequest<CreateProjectResponse>("/api/projects/clone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      errorBody: "json-error",
    }),
  );
  return body.project;
}

export async function updateProject(id: string, patch: UpdateProjectBody): Promise<Project> {
  const body = createProjectResponseSchema.parse(
    await apiRequest<CreateProjectResponse>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
      errorBody: "json-error",
      label: `/api/projects/${id} PATCH`,
    }),
  );
  return body.project;
}

export async function rememberChatMessage(
  conversationId: string,
  messageId: string,
  draft: RememberChatMessageRequest,
): Promise<RememberChatMessageResponse> {
  return rememberChatMessageResponseSchema.parse(
    await apiRequest<unknown>(
      `/api/chat/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/remember`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
        errorBody: "json-error",
        label: `/api/chat/${conversationId}/messages/${messageId}/remember`,
      },
    ),
  );
}
