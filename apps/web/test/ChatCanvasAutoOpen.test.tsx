import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChatFrame, Conversation } from "@keelson/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CanvasProvider } from "../src/components/Canvas/CanvasHost.tsx";
import { ToastHost } from "../src/components/Toast.tsx";

const conversations: Conversation[] = [
  {
    id: "conv-1",
    name: "Canvas auto-open",
    providerId: "stub",
    model: "stub-model",
    projectId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
  },
];

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
  postRibAction: async () => ({ ok: true }),
  resolveAgent: async () => null,
  startWorkflowRun: async () => ({ runId: "run-1" }),
}));

mock.module("../src/hooks/useRibs.ts", () => ({
  useRibs: () => ({ status: "ready", ribs: [], error: null, refresh: () => {} }),
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

let onFrame: ((frame: ChatFrame) => void) | null = null;
mock.module("../src/ws.ts", () => ({
  createReconnectingChatWs: (callbacks: {
    onFrame: (frame: ChatFrame) => void;
    onStateChange?: (state: string) => void;
  }) => {
    onFrame = callbacks.onFrame;
    queueMicrotask(() => callbacks.onStateChange?.("open"));
    return { send: () => {}, close: () => {}, getState: () => "open" as const };
  },
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

const publishResult = JSON.stringify({
  key: "canvas:artifact:auto-open-check",
  slug: "auto-open-check",
  title: "Auto-open Check",
  updated: false,
  bytes: 100,
  palette: "none declared",
});

function chunk(payload: unknown): ChatFrame {
  return { conversationId: "conv-1", event: { type: "chunk", payload } } as ChatFrame;
}

async function sendPrompt(): Promise<void> {
  const box = await screen.findByPlaceholderText(/Type a message/);
  fireEvent.change(box, { target: { value: "publish it" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => {
    if (onFrame === null) throw new Error("ws not opened yet");
  });
}

beforeEach(() => {
  sessionStorage.setItem("keelson.conversationId", "conv-1");
  onFrame = null;
});

describe("canvas_publish auto-open", () => {
  test("result-before-use order (the copilot bridge) opens the drawer and hydrates the row", async () => {
    renderChat();
    await sendPrompt();
    act(() => {
      onFrame?.(chunk({ type: "tool_result", toolUseId: "call_1", content: publishResult }));
      onFrame?.(chunk({ type: "tool_use", id: "call_1", toolName: "canvas_publish" }));
    });
    await waitFor(() => expect(screen.getByText("Auto-open Check")).toBeTruthy());
    // The parked result also hydrates the tool row — the transcript shows the
    // publish outcome, not a forever-pending call.
    expect(document.body.textContent).toContain("canvas:artifact:auto-open-check");
  });

  test("use-before-result order opens the drawer too", async () => {
    renderChat();
    await sendPrompt();
    act(() => {
      onFrame?.(chunk({ type: "tool_use", id: "call_2", toolName: "canvas_publish" }));
      onFrame?.(chunk({ type: "tool_result", toolUseId: "call_2", content: publishResult }));
    });
    await waitFor(() => expect(screen.getByText("Auto-open Check")).toBeTruthy());
  });

  test("an errored publish result never opens the drawer", async () => {
    renderChat();
    await sendPrompt();
    act(() => {
      onFrame?.(chunk({ type: "tool_use", id: "call_3", toolName: "canvas_publish" }));
      onFrame?.(
        chunk({
          type: "tool_result",
          toolUseId: "call_3",
          content: "the declared dark palette fails validation",
          isError: true,
        }),
      );
      onFrame?.({ conversationId: "conv-1", event: { type: "done" } } as ChatFrame);
    });
    // Flush pending microtask/state updates before asserting absence, so a
    // late async open can't slip past the check.
    await act(async () => {});
    expect(screen.queryByText("Auto-open Check")).toBeNull();
  });

  test("a parked result does not leak across an errored turn (call-id reuse)", async () => {
    renderChat();
    await sendPrompt();
    act(() => {
      // Turn 1 parks a result with no matching tool_use, then errors out.
      onFrame?.(chunk({ type: "tool_result", toolUseId: "call_9", content: publishResult }));
      onFrame?.({
        conversationId: "conv-1",
        event: { type: "error", message: "provider fell over" },
      } as ChatFrame);
    });
    await sendPrompt();
    act(() => {
      // Turn 2 reuses the call id for a fresh canvas_publish; the stale parked
      // result must not pair with it and open the wrong artifact.
      onFrame?.(chunk({ type: "tool_use", id: "call_9", toolName: "canvas_publish" }));
      onFrame?.({ conversationId: "conv-1", event: { type: "done" } } as ChatFrame);
    });
    await act(async () => {});
    expect(screen.queryByText("Auto-open Check")).toBeNull();
  });
});
