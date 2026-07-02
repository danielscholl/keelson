import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Conversation, RibActionResponse, RibSummary } from "@keelson/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CanvasProvider } from "../src/components/Canvas/CanvasHost.tsx";
import { ToastHost } from "../src/components/Toast.tsx";

const conversations: Conversation[] = [
  {
    id: "conv-1",
    name: "Surface handoff",
    providerId: "stub",
    model: "stub-model",
    projectId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        role: "user",
        content: "Inspect this surface",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        role: "assistant",
        content: "Send this summary",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ],
  },
];

let ribSummaries: RibSummary[] = [];
const postRibActionCalls: Array<{ id: string; action: unknown }> = [];
let postRibActionResult: RibActionResponse = { ok: true };

mock.module("../src/api.ts", () => ({
  cloneProject: async () => ({ id: "project-2", name: "copy" }),
  completeRibCommand: async () => [],
  createConversation: async () => conversations[0],
  createProject: async () => ({ id: "project-1", name: "default" }),
  deleteProject: async () => undefined,
  fetchProviderModels: async () => [{ id: "stub-model" }],
  fetchProviders: async () => ({
    providers: [
      {
        id: "stub",
        displayName: "Stub",
        authenticated: true,
        capabilities: { chat: true, models: ["stub-model"] },
      },
    ],
    defaultProvider: "stub",
  }),
  fetchTools: async () => [],
  getCommands: async () => [],
  getConversation: async (id: string) => conversations.find((c) => c.id === id) ?? null,
  invokeRibCommand: async () => ({ effect: "message", message: "ok" }),
  listConversations: async () => conversations,
  listProjects: async () => [],
  listWorkflows: async () => ({ workflows: [] }),
  postRibAction: async (id: string, action: unknown) => {
    postRibActionCalls.push({ id, action });
    return postRibActionResult;
  },
  resolveAgent: async () => null,
  startWorkflowRun: async () => ({ runId: "run-1" }),
}));

mock.module("../src/hooks/useRibs.ts", () => ({
  useRibs: () => ({ status: "ready", ribs: ribSummaries, error: null, refresh: () => {} }),
}));

mock.module("../src/hooks/useSnapshot.ts", () => ({
  useSnapshot: () => ({
    status: "empty",
    data: null,
    version: null,
    composedAt: null,
    reload: () => {},
  }),
}));

const { RibsProvider } = await import("../src/components/RibsProvider.tsx");
const { Chat } = await import("../src/views/Chat.tsx");

function renderChat() {
  return render(
    <ToastHost>
      <RibsProvider>
        <CanvasProvider>
          <Chat />
        </CanvasProvider>
      </RibsProvider>
    </ToastHost>,
  );
}

beforeEach(() => {
  sessionStorage.setItem("keelson.conversationId", "conv-1");
  ribSummaries = [];
  postRibActionCalls.length = 0;
  postRibActionResult = { ok: true };
});

describe("Chat send to surface", () => {
  test("shows no send control when no active rib accepts ingest", async () => {
    renderChat();
    await screen.findByText("Send this summary");
    expect(screen.queryByRole("button", { name: "Send to surface" })).toBeNull();
  });

  test("sends a persisted assistant message to the single ingest target", async () => {
    ribSummaries = [
      {
        id: "receiver",
        displayName: "Receiver",
        registered: [],
        views: [],
        surfaces: [],
        hasOnAction: true,
        acceptsIngest: true,
      },
    ];
    renderChat();
    await screen.findByText("Send this summary");

    fireEvent.click(screen.getAllByRole("button", { name: "Send to surface" })[1]!);

    await waitFor(() =>
      expect(postRibActionCalls).toEqual([
        {
          id: "receiver",
          action: {
            type: "ingest",
            payload: { text: "Send this summary", sourceConversationId: "conv-1" },
          },
        },
      ]),
    );
    expect(await screen.findByText("Sent to surface")).toBeDefined();
  });
});
