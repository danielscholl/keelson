import {
  type ClaudeCliStatus,
  type CloneProjectBody,
  type Conversation,
  type CopilotCliStatus,
  type CreateProjectBody,
  type CreateProjectResponse,
  type CredentialStatus,
  claudeCliStatusSchema,
  copilotCliStatusSchema,
  createProjectResponseSchema,
  credentialStatusSchema,
  getWorkflowDetailResponseSchema,
  getWorkflowRunResponseSchema,
  type ListWorkflowsResponse,
  listProjectsResponseSchema,
  listRunsResponseSchema,
  listWorkflowsResponseSchema,
  type MemoryListQuery,
  type MemoryListResponse,
  type ModelInfo,
  memoryListResponseSchema,
  type Project,
  type ProviderInfo,
  type RegisteredToolInfo,
  type RememberChatMessageRequest,
  type RememberChatMessageResponse,
  type ReviewActionRequest,
  type ReviewActionResponse,
  type ReviewListQuery,
  type ReviewListResponse,
  rememberChatMessageResponseSchema,
  reviewActionResponseSchema,
  reviewListResponseSchema,
  startWorkflowRunResponseSchema,
  type UpdateProjectBody,
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

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const body = await apiRequest<{ providers: ProviderInfo[] }>("/api/providers");
  return body.providers;
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

export async function listWorkflows(): Promise<ListWorkflowsResponse> {
  return listWorkflowsResponseSchema.parse(await apiRequest<unknown>("/api/workflows"));
}

export async function getWorkflowDetail(name: string): Promise<WorkflowDetail> {
  return getWorkflowDetailResponseSchema.parse(
    await apiRequest<unknown>(`/api/workflows/${encodeURIComponent(name)}`, {
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

export interface StartWorkflowRunOptions {
  inputs?: Record<string, string>;
  projectId?: string;
  workingDir?: string;
  isolation?: "worktree" | "none";
}

export async function startWorkflowRun(
  workflowName: string,
  options: StartWorkflowRunOptions = {},
): Promise<{ runId: string }> {
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

export async function getWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  return getWorkflowRunResponseSchema.parse(
    await apiRequest<unknown>(`/api/workflows/runs/${encodeURIComponent(runId)}`, {
      label: `/api/workflows/runs/${runId}`,
    }),
  ).run;
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
