import {
  type ClaudeCliStatus,
  type Conversation,
  type CopilotCliStatus,
  type CredentialStatus,
  claudeCliStatusSchema,
  copilotCliStatusSchema,
  credentialStatusSchema,
  getWorkflowDetailResponseSchema,
  getWorkflowRunResponseSchema,
  type ListWorkflowsResponse,
  listRunsResponseSchema,
  listWorkflowsResponseSchema,
  type MemoryListQuery,
  type MemoryListResponse,
  type ModelInfo,
  memoryListResponseSchema,
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

export async function createConversation(
  providerId: string,
  model?: string,
  seedSystemPrompt?: string,
  name?: string,
): Promise<Conversation> {
  return apiRequest<Conversation>("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId,
      ...(model ? { model } : {}),
      ...(seedSystemPrompt ? { seedSystemPrompt } : {}),
      ...(name ? { name } : {}),
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

export async function startWorkflowRun(
  workflowName: string,
  inputs: Record<string, string> = {},
): Promise<{ runId: string }> {
  return startWorkflowRunResponseSchema.parse(
    await apiRequest<unknown>(`/api/workflows/${encodeURIComponent(workflowName)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs }),
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

// Resume a paused approval node. Text becomes $<nodeId>.output. 404/409
// means "no longer pending" — soft no-op so a double-click doesn't toast.
export async function submitApproval(runId: string, nodeId: string, text: string): Promise<void> {
  await apiRequest<void, void>(`/api/workflows/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId, text }),
    responseBody: "void",
    errorBody: "json-error",
    allowedStatuses: [404, 409],
    allowedStatusValue: undefined,
    label: `/api/workflows/runs/${runId}/resume`,
  });
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
