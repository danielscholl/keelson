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
  {
    id: "conv-2",
    name: "Second chat",
    providerId: "stub",
    model: "stub-model",
    projectId: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    messages: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        role: "user",
        content: "Second question",
        createdAt: "2026-01-02T00:00:01.000Z",
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        role: "assistant",
        content: "Second answer here",
        createdAt: "2026-01-02T00:00:02.000Z",
      },
    ],
  },
];

// Gate that lets a test hold a getConversation call open, so the intermediate
// loading state (skeleton, prior transcript cleared) is observable before the
// incoming conversation resolves. Null gate = resolve immediately.
let getConversationGate: Promise<void> | null = null;
let releaseConversationGate: (() => void) | null = null;
function armConversationGate(): void {
  getConversationGate = new Promise<void>((resolve) => {
    releaseConversationGate = () => {
      releaseConversationGate = null;
      getConversationGate = null;
      resolve();
    };
  });
}

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
  getConversation: async (id: string) => {
    if (getConversationGate) await getConversationGate;
    return conversations.find((c) => c.id === id) ?? null;
  },
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
  getConversationGate = null;
  releaseConversationGate = null;
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

describe("Chat conversation switch", () => {
  test("clears the previous transcript and shows a skeleton while the next loads", async () => {
    const { container } = renderChat();
    await screen.findByText("Send this summary");

    // Hold the incoming load open so the intermediate state is observable.
    armConversationGate();
    fireEvent.click(screen.getByText("Second chat"));

    // The outgoing conversation's messages must clear immediately rather than
    // linger until the incoming fetch resolves; a skeleton stands in.
    await waitFor(() => expect(screen.queryByText("Send this summary")).toBeNull());
    expect(container.querySelector(".chat-skeleton")).not.toBeNull();

    // Release the load; the incoming conversation renders.
    releaseConversationGate?.();
    expect(await screen.findByText("Second answer here")).toBeDefined();
  });
});

describe("Chat composer auto-grow", () => {
  test("clamps the composer height to the cap on a multi-line change", async () => {
    renderChat();
    const textarea = (await screen.findByPlaceholderText(
      "Type a message — Enter to send, Shift+Enter for newline",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.disabled).toBe(false));

    // happy-dom does no layout, so scrollHeight is 0; stub it above the cap so
    // the effect measures a real over-cap value. The deterministic guarantee
    // lives in autoGrowTextarea.test.ts.
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 500 });
    fireEvent.change(textarea, { target: { value: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj" } });

    expect(textarea.style.height).toBe("320px");
  });
});
