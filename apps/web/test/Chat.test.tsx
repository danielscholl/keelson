import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClientFrame, Conversation, RibActionResponse } from "@keelson/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CanvasProvider } from "../src/components/Canvas/CanvasHost.tsx";
import { ToastHost } from "../src/components/Toast.tsx";
import { ribFixture } from "./ribsFixture.ts";

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

const postRibActionCalls: Array<{ id: string; action: unknown }> = [];
let postRibActionResult: RibActionResponse = { ok: true };
let sandboxConfig = { default: false, floor: false, summary: "sandbox off", platform: "darwin" };
const conversationPatches: Array<{ id: string; patch: unknown }> = [];
const sentFrames: ClientFrame[] = [];
const createCalls: Array<{ providerId: string; options: unknown }> = [];
// Holds a PATCH open, or fails it, so the toggle's in-flight and revert paths show.
let patchGate: Promise<void> | null = null;
let patchFails = false;
let configFails = false;
let wsCallbacks: { onFrame?: (frame: unknown) => void } | null = null;
let ledgerPricedEvents = 0;
let ledgerUnpricedEvents = 0;

// Spread the real modules so an export this file doesn't stub stays linkable
// for every later test file; bun's module mocks are process-wide.
const realApi = await import("../src/api.ts");
const realWs = await import("../src/ws.ts");

mock.module("../src/api.ts", () => ({
  ...realApi,
  cloneProject: async () => ({ id: "project-2", name: "copy" }),
  completeRibCommand: async () => [],
  createConversation: async (providerId: string, options: unknown) => {
    createCalls.push({ providerId, options });
    return conversations[0];
  },
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
  getUsageEvents: async () => [],
  getUsageSummary: async () => ({
    totals: {
      events: ledgerPricedEvents + ledgerUnpricedEvents,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: ledgerUnpricedEvents > 0 ? null : 0,
      pricedCostUsd: 0,
      pricedCostByTypeUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      unpricedEvents: ledgerUnpricedEvents,
      cacheHitRatio: null,
    },
    groups: [],
  }),
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

mock.module("../src/ws.ts", () => ({
  ...realWs,
  createReconnectingChatWs: (callbacks: {
    onStateChange?: (state: string) => void;
    onFrame?: (frame: unknown) => void;
  }) => {
    wsCallbacks = callbacks;
    queueMicrotask(() => callbacks.onStateChange?.("open"));
    return {
      send: (frame: ClientFrame) => sentFrames.push(frame),
      close: () => {},
      getState: () => "open" as const,
    };
  },
}));

mock.module("../src/hooks/useRibs.ts", () => ({
  useRibs: () => ({ status: "ready", ribs: ribFixture.ribs, error: null, refresh: () => {} }),
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
  ribFixture.ribs = [];
  postRibActionCalls.length = 0;
  postRibActionResult = { ok: true };
  getConversationGate = null;
  releaseConversationGate = null;
  ledgerPricedEvents = 0;
  ledgerUnpricedEvents = 0;
  sandboxConfig = { default: false, floor: false, summary: "sandbox off", platform: "darwin" };
  conversationPatches.length = 0;
  sentFrames.length = 0;
  createCalls.length = 0;
  patchGate = null;
  patchFails = false;
  configFails = false;
  for (const c of conversations) delete c.sandbox;
});

describe("Chat conversation usage", () => {
  test("restored conversations use ledger event counts for a zero-cost floor", async () => {
    ledgerPricedEvents = 2;
    ledgerUnpricedEvents = 8;
    const assistant = conversations[0]!.messages[1]!;
    assistant.usage = { inputTokens: 1000, outputTokens: 500 };
    try {
      renderChat();
      expect(await screen.findByText("≥ $0.0000")).toBeDefined();
      expect(screen.getByText("Unpriced turns").parentElement?.textContent).toBe("Unpriced turns8");
    } finally {
      delete assistant.usage;
    }
  });
});

describe("Chat send to surface", () => {
  test("shows no send control when no active rib accepts ingest", async () => {
    renderChat();
    await screen.findByText("Send this summary");
    expect(screen.queryByRole("button", { name: "Send to surface" })).toBeNull();
  });

  test("sends a persisted assistant message to the single ingest target", async () => {
    ribFixture.ribs = [
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

describe("Chat sandbox", () => {
  const chip = () => screen.getByRole("button", { name: /^Sandbox/ });
  // happy-dom has no Popover API; the slash picker opens one on "/".
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.showPopover ??= () => {};
  proto.hidePopover ??= () => {};
  // fetchConfig and updateConversation stay real (a stub would leak into other
  // files), so the server they reach is faked here.
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/config" && configFails) return new Response("down", { status: 503 });
      if (path === "/api/config") {
        return Response.json({
          schemaVersion: "",
          wireProtocolVersion: "",
          sandbox: sandboxConfig,
        });
      }
      const m = /^\/api\/conversations\/([^/]+)$/.exec(path);
      if (m && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (m && init?.method === "PATCH") {
        if (patchGate) await patchGate;
        if (patchFails) return new Response("nope", { status: 500 });
        const patch = JSON.parse(String(init.body)) as { sandbox?: "on" | "off" };
        conversationPatches.push({ id: m[1]!, patch });
        const conv = conversations.find((c) => c.id === m[1])!;
        return Response.json({ ...conv, ...patch });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("the chip follows the server default until a conversation's saved choice hydrates", async () => {
    sandboxConfig = { ...sandboxConfig, default: true };
    conversations[0]!.sandbox = "off";
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("false"));
  });

  test("a fresh chat seeds the chip from /api/config", async () => {
    sessionStorage.removeItem("keelson.conversationId");
    sandboxConfig = { ...sandboxConfig, default: true };
    renderChat();
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
  });

  const send = (text: string) => {
    const box = screen.getByPlaceholderText(/Type a message/);
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: "Enter" });
  };

  test("a saved row speaks for itself: the frame carries no override", async () => {
    conversations[0]!.sandbox = "on";
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
    send("hello");
    await waitFor(() => expect(sentFrames.length).toBe(1));
    expect(sentFrames[0]?.message).not.toHaveProperty("sandbox");
  });

  test("a toggle applies at once, so a send during its save carries the new value", async () => {
    let release = () => {};
    patchGate = new Promise<void>((r) => {
      release = r;
    });
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("false"));
    fireEvent.click(chip());
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
    // A second toggle waits for the first save.
    expect((chip() as HTMLButtonElement).disabled).toBe(true);
    send("hello");
    await waitFor(() => expect(sentFrames.length).toBe(1));
    expect(sentFrames[0]?.message).toMatchObject({ sandbox: true });
    release();
    await waitFor(() =>
      expect(conversationPatches).toEqual([{ id: "conv-1", patch: { sandbox: "on" } }]),
    );
  });

  test("a failed save adopts the row's value and says why", async () => {
    patchFails = true;
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("false"));
    fireEvent.click(chip());
    expect(await screen.findByText(/saving the sandbox choice failed/)).toBeDefined();
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("false"));
  });

  test("a failed save after a send adopts what that send persisted, not the old value", async () => {
    conversations[0]!.sandbox = "on";
    let release = () => {};
    patchGate = new Promise<void>((r) => {
      release = r;
    });
    patchFails = true;
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(chip());
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("false"));
    send("hello");
    await waitFor(() => expect(sentFrames.length).toBe(1));
    expect(sentFrames[0]?.message).toMatchObject({ sandbox: false });
    // The server mirrored the frame's choice onto the row before the PATCH failed.
    conversations[0]!.sandbox = "off";
    release();
    expect(await screen.findByText(/saving the sandbox choice failed/)).toBeDefined();
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("false"));
  });

  test("a hydrated row's choice survives the recreate after the server lost it", async () => {
    conversations[0]!.sandbox = "on";
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
    send("hello");
    await waitFor(() => expect(sentFrames.length).toBe(1));
    expect(sentFrames[0]?.message).not.toHaveProperty("sandbox");
    act(() => {
      wsCallbacks?.onFrame?.({
        conversationId: "conv-1",
        event: { type: "error", code: "UNKNOWN_CONVERSATION", message: "unknown conversation" },
      });
    });
    await waitFor(() => expect(sentFrames.length).toBe(2));
    expect(createCalls[0]?.options).toMatchObject({ sandbox: "on" });
    expect(sentFrames[1]?.message).toMatchObject({ sandbox: true });
  });

  test("an unread /api/config picks nothing: the chip is mixed and a fresh chat sends no override", async () => {
    sessionStorage.removeItem("keelson.conversationId");
    configFails = true;
    renderChat();
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("mixed"));
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement).disabled).toBe(
        false,
      ),
    );
    send("hello");
    await waitFor(() => expect(sentFrames.length).toBe(1));
    expect(sentFrames[0]?.message).not.toHaveProperty("sandbox");
    expect(createCalls[0]?.options).not.toHaveProperty("sandbox");
  });

  test("a choice made before the chat exists goes on the create and the frame", async () => {
    sessionStorage.removeItem("keelson.conversationId");
    renderChat();
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("false"));
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(chip());
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
    send("hello");
    await waitFor(() => expect(sentFrames.length).toBe(1));
    expect(createCalls[0]?.options).toMatchObject({ sandbox: "on" });
    expect(sentFrames[0]?.message).toMatchObject({ sandbox: true });
    expect(conversationPatches).toEqual([]);
  });

  test("clicking the chip saves the choice on the open conversation", async () => {
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("false"));
    fireEvent.click(chip());
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
    expect(conversationPatches).toEqual([{ id: "conv-1", patch: { sandbox: "on" } }]);
  });

  test("/sandbox off is refused while KEELSON_SANDBOX=required holds the floor", async () => {
    sandboxConfig = { ...sandboxConfig, floor: true };
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
    expect((chip() as HTMLButtonElement).disabled).toBe(true);
    const box = screen.getByPlaceholderText(/Type a message/);
    fireEvent.change(box, { target: { value: "/sandbox off" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(/KEELSON_SANDBOX=required holds the sandbox on/)).toBeDefined();
    expect(conversationPatches).toEqual([]);
  });

  test("deleting the open chat drops its saved choice back to the default", async () => {
    conversations[0]!.sandbox = "on";
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Delete conversation Surface handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("false"));
  });

  test("starting a new chat drops the old row's choice too", async () => {
    conversations[0]!.sandbox = "on";
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getAllByRole("button", { name: "Start a new conversation" })[0]!);
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("false"));
  });

  test("/sandbox status prints the same lines as the CLI", async () => {
    conversations[0]!.sandbox = "on";
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("true"));
    const box = screen.getByPlaceholderText(/Type a message/);
    fireEvent.change(box, { target: { value: "/sandbox status" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(/sandbox: on \(saved on this conversation\)/)).toBeDefined();
    expect(screen.getByText(/stub cannot sandbox its tools; turns fail closed/)).toBeDefined();
  });

  test("a saved off with /api/config unread is only requested, so the chip is mixed", async () => {
    conversations[0]!.sandbox = "off";
    configFails = true;
    renderChat();
    await screen.findByText("Send this summary");
    await waitFor(() => expect(chip().getAttribute("aria-pressed")).toBe("mixed"));
    expect(chip().getAttribute("aria-label")).toContain("Sandbox off requested");
    const box = screen.getByPlaceholderText(/Type a message/);
    fireEvent.change(box, { target: { value: "/sandbox status" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(/sandbox: off requested; server policy unknown/)).toBeDefined();
  });
});
