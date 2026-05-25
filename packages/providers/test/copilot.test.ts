import { beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import type {
  CopilotClientLike,
  CopilotModelInfo,
  CopilotSdkModule,
  CopilotSessionLike,
  MessageChunk,
} from "../src/index.ts";
import {
  buildFriendlyCopilotError,
  COPILOT_CAPABILITIES,
  COPILOT_CREDENTIAL_SERVICE_ID,
  COPILOT_DEFAULT_MODEL,
  CopilotClientFactory,
  CopilotProvider,
  clearRegistry,
  getAgentProvider,
  getProviderInfoList,
  isRegisteredProvider,
  registerCopilotProvider,
} from "../src/index.ts";

// --- Mock SDK harness ---

interface MockSession extends CopilotSessionLike {
  emit(event: string, data?: Record<string, unknown>): void;
  readonly sent: Array<{ prompt: string }>;
  readonly aborted: boolean;
  readonly disconnected: boolean;
  // F10.6: record setModel invocations so tests can assert effort change-overs
  // happened on the resume path.
  readonly setModelCalls: Array<{
    model: string;
    options?: { reasoningEffort?: "low" | "medium" | "high" | "xhigh" };
  }>;
}

interface MockClient extends CopilotClientLike {
  readonly started: boolean;
  readonly stopped: boolean;
  readonly options: Record<string, unknown>;
}

// scenario fires from inside send() via queueMicrotask — by the time it
// runs, the provider has wired its event handlers and entered the drain
// loop, so emit() calls land on a live listener.
interface MockSdkOptions {
  createSessionError?: Error;
  sendError?: Error;
  startError?: Error;
  scenario?: (session: MockSession) => void | Promise<void>;
  // F9: drives the lightweight checkAuthStatus probe. Default is a happy
  // "user" result so existing tests don't have to opt in.
  authStatus?: {
    isAuthenticated: boolean;
    authType?: "user" | "env" | "gh-cli" | "hmac" | "api-key" | "token";
    host?: string;
    login?: string;
    statusMessage?: string;
  };
  // Drives client.listModels(). When undefined, returns a stable trio so
  // existing tests don't have to opt in. Set listModelsError to simulate
  // the "not connected" / API failure path.
  models?: CopilotModelInfo[];
  listModelsError?: Error;
}

interface MockSdkHandle {
  module: CopilotSdkModule;
  lastSession: () => MockSession | null;
  lastClient: () => MockClient | null;
  lastSessionConfig: () => Record<string, unknown> | null;
  approveAll: (...args: unknown[]) => unknown;
}

function makeMockSdk(opts: MockSdkOptions = {}): MockSdkHandle {
  let lastSession: MockSession | null = null;
  let lastClient: MockClient | null = null;

  const makeSession = (): MockSession => {
    const handlers = new Map<string, Set<(event: unknown) => void>>();
    const sent: Array<{ prompt: string }> = [];
    let aborted = false;
    let disconnected = false;
    const setModelCalls: Array<{
      model: string;
      options?: { reasoningEffort?: "low" | "medium" | "high" | "xhigh" };
    }> = [];

    const session: MockSession = {
      sessionId: "mock-session-id",
      get sent() {
        return sent;
      },
      get aborted() {
        return aborted;
      },
      get disconnected() {
        return disconnected;
      },
      get setModelCalls() {
        return setModelCalls;
      },
      send(options: { prompt: string }): Promise<unknown> {
        if (opts.sendError) return Promise.reject(opts.sendError);
        sent.push({ prompt: options.prompt });
        // Real SDK behavior: send() resolves only after the turn reaches
        // its terminal state (session.idle / session.error). The provider
        // must drain events concurrently — if it awaits send before
        // entering the drain, all deltas buffer until idle and streaming
        // is broken. We mimic that here so the test exercises the same
        // race: schedule the scenario, then resolve after it completes.
        return new Promise((resolve, reject) => {
          queueMicrotask(async () => {
            try {
              if (opts.scenario) await opts.scenario(session);
              resolve("msg-id");
            } catch (err) {
              reject(err);
            }
          });
        });
      },
      on(eventType: string, handler: (event: unknown) => void): () => void {
        let set = handlers.get(eventType);
        if (!set) {
          set = new Set();
          handlers.set(eventType, set);
        }
        set.add(handler);
        return () => set!.delete(handler);
      },
      async abort(): Promise<void> {
        aborted = true;
      },
      async disconnect(): Promise<void> {
        disconnected = true;
      },
      async setModel(
        model: string,
        options?: { reasoningEffort?: "low" | "medium" | "high" | "xhigh" },
      ): Promise<void> {
        setModelCalls.push({ model, options });
      },
      emit(eventType: string, data?: Record<string, unknown>): void {
        const set = handlers.get(eventType);
        if (!set) return;
        const event = { type: eventType, data: data ?? {} };
        for (const h of set) h(event);
      },
    };
    return session;
  };

  let lastSessionConfig: Record<string, unknown> | null = null;

  // Permissive permission handler — matches SDK's approveAll. Tests assert
  // identity reference to verify the provider threads it through.
  const mockApproveAll = (): { kind: "permit" } => ({ kind: "permit" });

  class MockClientImpl implements CopilotClientLike {
    started = false;
    stopped = false;
    constructor(public readonly options: Record<string, unknown>) {
      lastClient = this;
    }
    async start(): Promise<void> {
      if (opts.startError) throw opts.startError;
      this.started = true;
    }
    async stop(): Promise<unknown> {
      this.stopped = true;
      return [];
    }
    async createSession(config?: unknown): Promise<CopilotSessionLike> {
      lastSessionConfig = (config as Record<string, unknown> | null) ?? null;
      if (opts.createSessionError) throw opts.createSessionError;
      const session = makeSession();
      lastSession = session;
      return session;
    }
    async resumeSession(_sessionId: string, config?: unknown): Promise<CopilotSessionLike> {
      lastSessionConfig = (config as Record<string, unknown> | null) ?? null;
      if (opts.createSessionError) throw opts.createSessionError;
      const session = makeSession();
      lastSession = session;
      return session;
    }
    async getAuthStatus(): Promise<{
      isAuthenticated: boolean;
      authType?: "user" | "env" | "gh-cli" | "hmac" | "api-key" | "token";
      host?: string;
      login?: string;
      statusMessage?: string;
    }> {
      return (
        opts.authStatus ?? {
          isAuthenticated: true,
          authType: "user",
          login: "test-user",
        }
      );
    }
    async listModels(): Promise<CopilotModelInfo[]> {
      if (opts.listModelsError) throw opts.listModelsError;
      return opts.models ?? [{ id: "auto" }, { id: "gpt-5" }, { id: "claude-sonnet-4.5" }];
    }
  }

  const module: CopilotSdkModule = {
    CopilotClient: MockClientImpl as unknown as CopilotSdkModule["CopilotClient"],
    approveAll: mockApproveAll as unknown as CopilotSdkModule["approveAll"],
  };

  return {
    module,
    lastSession: () => lastSession,
    lastClient: () => lastClient,
    lastSessionConfig: () => lastSessionConfig,
    approveAll: mockApproveAll,
  };
}

function loaderFor(sdk: MockSdkHandle) {
  let count = 0;
  return {
    load: () => {
      count++;
      return Promise.resolve(sdk.module);
    },
    count: () => count,
  };
}

beforeEach(() => {
  clearRegistry();
});

describe("registerCopilotProvider", () => {
  it("registers a copilot provider with the expected identity", () => {
    registerCopilotProvider({ getCredential: async () => undefined });
    expect(isRegisteredProvider("copilot")).toBe(true);
    const info = getProviderInfoList().find((p) => p.id === "copilot");
    expect(info).toBeDefined();
    expect(info!.displayName).toBe("GitHub Copilot");
    expect(info!.builtIn).toBe(true);
    expect(info!.credentialServiceId).toBe(COPILOT_CREDENTIAL_SERVICE_ID);
    expect(info!.capabilities).toEqual(COPILOT_CAPABILITIES);
  });

  it("is idempotent — calling twice does not throw", () => {
    const opts = { getCredential: async () => undefined };
    registerCopilotProvider(opts);
    expect(() => registerCopilotProvider(opts)).not.toThrow();
  });
});

describe("CopilotProvider — identity", () => {
  it("getType returns 'copilot'", () => {
    const p = new CopilotProvider({ getCredential: async () => undefined });
    expect(p.getType()).toBe("copilot");
  });

  it("getCapabilities matches the registered shape", () => {
    const p = new CopilotProvider({ getCredential: async () => undefined });
    expect(p.getCapabilities()).toEqual(COPILOT_CAPABILITIES);
  });
});

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe("CopilotProvider — credential modes", () => {
  it("falls back to useLoggedInUser: true when no paste-token is saved", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => undefined,
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/tmp"));
    // Without a saved token, the SDK is loaded and the client is asked
    // to reuse the local `copilot auth login` OAuth.
    expect(loader.count()).toBe(1);
    const opts = sdk.lastClient()!.options;
    expect(opts.useLoggedInUser).toBe(true);
    expect("gitHubToken" in opts).toBe(false);
  });

  it("uses paste-token mode when a credential is saved", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "paste-token-xyz",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/tmp"));
    const opts = sdk.lastClient()!.options;
    expect(opts.gitHubToken).toBe("paste-token-xyz");
    expect(opts.useLoggedInUser).toBe(false);
  });
});

describe("CopilotProvider — happy path stream translation", () => {
  it("translates assistant.message_delta events to text chunks", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("assistant.message_delta", { deltaContent: "2 " });
        session.emit("assistant.message_delta", { deltaContent: "+ " });
        session.emit("assistant.message_delta", { deltaContent: "2 = 4" });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const chunks = await drain(provider.sendQuery("hello", "/tmp"));

    expect(loader.count()).toBe(1);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.type === "text")).toBe(true);
    expect(chunks.map((c) => (c as { content: string }).content).join("")).toBe("2 + 2 = 4");
    expect(sdk.lastSession()!.sent[0]!.prompt).toBe("hello");
    expect(sdk.lastSession()!.disconnected).toBe(true);
    expect(sdk.lastClient()!.stopped).toBe(true);
  });

  it("translates tool.execution_start events to tool_use chunks", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("tool.execution_start", {
          toolName: "read_file",
          arguments: { path: "/etc/hosts" },
        });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const chunks = await drain(provider.sendQuery("hello", "/tmp"));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("tool_use");
    const tu = chunks[0] as Extract<MessageChunk, { type: "tool_use" }>;
    expect(tu.toolName).toBe("read_file");
    expect(tu.toolInput).toEqual({ path: "/etc/hosts" });
  });

  it("ignores empty deltaContent and unknown event shapes", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("assistant.message_delta", { deltaContent: "" });
        session.emit("assistant.message_delta", {}); // no deltaContent at all
        session.emit("assistant.message_delta", { deltaContent: "hi" });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const chunks = await drain(provider.sendQuery("hello", "/tmp"));
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { content: string }).content).toBe("hi");
  });
});

describe("CopilotProvider — error paths", () => {
  it("yields system chunk and throws when createSession fails", async () => {
    const sdk = makeMockSdk({
      createSessionError: new Error("401 Unauthorized"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "bad-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const chunks: MessageChunk[] = [];
    let thrown: unknown = null;
    try {
      for await (const chunk of provider.sendQuery("hi", "/tmp")) {
        chunks.push(chunk);
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("system");
    expect((chunks[0] as { content: string }).content.toLowerCase()).toContain("authentication");
    // Client was started, so cleanup should have called stop.
    expect(sdk.lastClient()!.stopped).toBe(true);
  });

  it("yields error chunk and throws when session emits session.error", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("session.error", {
          message: "429 rate_limit",
          errorType: "rate_limit",
        });
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const chunks: MessageChunk[] = [];
    let thrown: unknown = null;
    try {
      for await (const chunk of provider.sendQuery("hi", "/tmp")) {
        chunks.push(chunk);
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(chunks.some((c) => c.type === "error")).toBe(true);
    const errChunk = chunks.find((c) => c.type === "error") as
      | Extract<MessageChunk, { type: "error" }>
      | undefined;
    expect(errChunk).toBeDefined();
    expect(errChunk!.message.toLowerCase()).toContain("rate limit");
  });

  it("yields system chunk when client.start fails", async () => {
    const sdk = makeMockSdk({ startError: new Error("ECONNREFUSED 127.0.0.1") });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const chunks: MessageChunk[] = [];
    let thrown: unknown = null;
    try {
      for await (const chunk of provider.sendQuery("hi", "/tmp")) {
        chunks.push(chunk);
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("system");
    expect((chunks[0] as { content: string }).content.toLowerCase()).toContain("network");
    // start() failure must not leak the spawned CLI process — the factory
    // is required to call stop() on the client before rethrowing.
    expect(sdk.lastClient()).not.toBeNull();
    expect(sdk.lastClient()!.stopped).toBe(true);
  });

  it("CopilotClientFactory.createClient stops the client when start() throws", async () => {
    // Direct factory test: the provider can't reach into createClient's
    // local `client` reference, so this guard lives on the factory itself.
    const sdk = makeMockSdk({ startError: new Error("protocol handshake failed") });
    const loader = loaderFor(sdk);
    const factory = new CopilotClientFactory({ sdkLoader: loader.load });
    let thrown: unknown = null;
    try {
      await factory.createClient("tok", "/tmp");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("protocol handshake failed");
    // The spawned mock client must have stop() called even though
    // createClient never returned a usable reference.
    expect(sdk.lastClient()).not.toBeNull();
    expect(sdk.lastClient()!.stopped).toBe(true);
  });
});

describe("CopilotProvider — concurrent drain (real-time streaming)", () => {
  it("yields a delta before session.idle (i.e., while send() is still pending)", async () => {
    // Hold the scenario open so send() cannot resolve until the test
    // releases it. If the provider awaits send() before draining, the
    // first call to gen.next() would block here.
    let releaseScenario: (() => void) | null = null;
    const scenarioOpen = new Promise<void>((r) => {
      releaseScenario = r;
    });

    const sdk = makeMockSdk({
      scenario: async (session) => {
        session.emit("assistant.message_delta", { deltaContent: "first " });
        await scenarioOpen; // pause until test signals
        session.emit("assistant.message_delta", { deltaContent: "second" });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const gen = provider.sendQuery("hello", "/tmp");

    // The first chunk must arrive before the scenario completes — that's
    // the proof that drain runs concurrently with send().
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value!.type).toBe("text");
    expect((first.value as { content: string }).content).toBe("first ");

    // Release the scenario so send() can finally resolve.
    releaseScenario!();

    const rest: MessageChunk[] = [];
    for await (const chunk of gen) rest.push(chunk);
    const fullText = [first.value!, ...rest]
      .filter((c) => c.type === "text")
      .map((c) => (c as { content: string }).content)
      .join("");
    expect(fullText).toBe("first second");
  });

  it("surfaces send rejection as an error chunk + throw, even when concurrent", async () => {
    const sdk = makeMockSdk({ sendError: new Error("invalid prompt") });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const chunks: MessageChunk[] = [];
    let thrown: unknown = null;
    try {
      for await (const chunk of provider.sendQuery("hi", "/tmp")) {
        chunks.push(chunk);
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(chunks.some((c) => c.type === "error")).toBe(true);
    expect(sdk.lastClient()!.stopped).toBe(true);
  });
});

describe("CopilotProvider — abort", () => {
  it("stops the drain when abortSignal fires", async () => {
    const ac = new AbortController();
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("assistant.message_delta", { deltaContent: "first " });
        ac.abort();
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const chunks = await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        abortSignal: ac.signal,
      }),
    );

    // We should see the first chunk; the abort closes the queue so no more.
    expect(chunks.length).toBeLessThanOrEqual(1);
    expect(sdk.lastSession()!.aborted).toBe(true);
  });

  it("returns immediately if the signal is already aborted (pre-credential)", async () => {
    const ac = new AbortController();
    ac.abort();
    let credentialCalled = false;
    const sdk = makeMockSdk();
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => {
        credentialCalled = true;
        return "real-token";
      },
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const chunks = await drain(
      provider.sendQuery("hi", "/tmp", undefined, { abortSignal: ac.signal }),
    );

    // Pre-aborted callers must not see a spawned CLI or a yielded chunk.
    // The provider returns before reaching the credential lookup.
    expect(chunks).toHaveLength(0);
    expect(credentialCalled).toBe(false);
    expect(loader.count()).toBe(0);
    expect(sdk.lastClient()).toBeNull();
  });

  it("stops cleanly after credential resolution if signal has aborted", async () => {
    const ac = new AbortController();
    const sdk = makeMockSdk();
    const loader = loaderFor(sdk);
    // Abort right after credential resolves but before the client starts —
    // covers the WS-close-during-keychain-read race.
    const provider = new CopilotProvider({
      getCredential: async () => {
        ac.abort();
        return "real-token";
      },
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const chunks = await drain(
      provider.sendQuery("hi", "/tmp", undefined, { abortSignal: ac.signal }),
    );
    expect(chunks).toHaveLength(0);
    // SDK never loaded → no CLI process spawned.
    expect(loader.count()).toBe(0);
  });

  it("stops the spawned client without sending the prompt if abort fires during createClient", async () => {
    const ac = new AbortController();
    const sdk = makeMockSdk();
    const loader = {
      count: () => 1,
      load: async () => {
        // Abort while we're inside the SDK load — simulates the abort
        // firing between client-start and session-create.
        ac.abort();
        return sdk.module;
      },
    };
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });

    const chunks = await drain(
      provider.sendQuery("hi", "/tmp", undefined, { abortSignal: ac.signal }),
    );
    expect(chunks).toHaveLength(0);
    // Client was constructed and started, but the post-createClient abort
    // gate stops the flow — no session is created, no prompt is sent.
    expect(sdk.lastClient()).not.toBeNull();
    expect(sdk.lastClient()!.stopped).toBe(true);
    expect(sdk.lastSession()).toBeNull();
  });
});

describe("buildFriendlyCopilotError", () => {
  it("classifies 401 / unauthorized as auth failure", () => {
    const msg = buildFriendlyCopilotError(new Error("HTTP 401 Unauthorized"));
    expect(msg.toLowerCase()).toContain("authentication");
  });

  it("classifies rate_limit / 429", () => {
    const msg = buildFriendlyCopilotError("Got 429 rate_limit");
    expect(msg.toLowerCase()).toContain("rate limit");
  });

  it("classifies network errors", () => {
    const msg = buildFriendlyCopilotError(new Error("fetch failed: ETIMEDOUT"));
    expect(msg.toLowerCase()).toContain("network");
  });

  it("classifies module-not-found as SDK missing", () => {
    const msg = buildFriendlyCopilotError(new Error("Cannot find module '@github/copilot-sdk'"));
    expect(msg.toLowerCase()).toContain("sdk is not installed");
  });

  it("falls back to a generic 'Copilot error' wrapper", () => {
    const msg = buildFriendlyCopilotError(new Error("something weird"));
    expect(msg).toBe("Copilot error: something weird");
  });
});

describe("CopilotProvider — registered factory wiring", () => {
  it("registry-built provider passes through to a real CopilotProvider", () => {
    registerCopilotProvider({ getCredential: async () => undefined });
    const provider = getAgentProvider("copilot");
    expect(provider.getType()).toBe("copilot");
    expect(provider.getCapabilities()).toEqual(COPILOT_CAPABILITIES);
  });
});

describe("CopilotProvider — SDK option wiring (P1 regression guards)", () => {
  it("constructs the SDK client with `gitHubToken` (capital H), not `githubToken`", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "secret-token-abc",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/workspace/x"));
    const opts = sdk.lastClient()!.options;
    expect(opts.gitHubToken).toBe("secret-token-abc");
    // The misspelling that caused the original P1 must not appear in the
    // constructed options — guards against accidental regression.
    expect("githubToken" in opts).toBe(false);
    expect(opts.useLoggedInUser).toBe(false);
    // cwd from sendQuery threads into the CLI process options.
    expect(opts.cwd).toBe("/workspace/x");
  });

  it("threads the SDK's permission handler into createSession config", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/workspace/y"));
    const cfg = sdk.lastSessionConfig();
    expect(cfg).not.toBeNull();
    // onPermissionRequest is REQUIRED by the SDK; absent → synchronous reject.
    expect(cfg!.onPermissionRequest).toBe(sdk.approveAll);
    // streaming: true is REQUIRED for assistant.message_delta events;
    // without it normal turns produce no text chunks.
    expect(cfg!.streaming).toBe(true);
    // workingDirectory pins tool ops + AGENTS.md discovery to the request cwd.
    expect(cfg!.workingDirectory).toBe("/workspace/y");
  });

  it("threads the permission handler into resumeSession config too", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/tmp", "prior-session-id"));
    const cfg = sdk.lastSessionConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.onPermissionRequest).toBe(sdk.approveAll);
  });

  it("falls back to assistant.message when streaming was missed", async () => {
    // Simulate the non-streaming path: no deltas, just a final message.
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("assistant.message", { content: "the full answer" });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("text");
    expect((chunks[0] as { content: string }).content).toBe("the full answer");
  });

  it("emits only the unstreamed tail when assistant.message follows deltas", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("assistant.message_delta", { deltaContent: "hello " });
        session.emit("assistant.message_delta", { deltaContent: "world" });
        // Final message repeats the streamed prefix and adds a tail.
        session.emit("assistant.message", { content: "hello world!" });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    const text = chunks
      .filter((c) => c.type === "text")
      .map((c) => (c as { content: string }).content)
      .join("");
    expect(text).toBe("hello world!");
    // Three chunks: two deltas + the tail "!".
    expect(chunks.filter((c) => c.type === "text")).toHaveLength(3);
  });

  it("passes systemPrompt and model alongside the permission handler", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        model: "claude-sonnet-4.5",
        systemPrompt: "You are concise.",
      }),
    );
    const cfg = sdk.lastSessionConfig();
    expect(cfg!.model).toBe("claude-sonnet-4.5");
    expect(cfg!.systemMessage).toEqual({ content: "You are concise." });
    expect(cfg!.onPermissionRequest).toBe(sdk.approveAll);
  });
});

describe("CopilotProvider — defaultModel + listModels", () => {
  it("capabilities pin 'auto' as the default model", () => {
    expect(COPILOT_DEFAULT_MODEL).toBe("auto");
    expect(COPILOT_CAPABILITIES.defaultModel).toBe("auto");
    // The curated fallback must include "auto" so it's selectable even
    // when the dynamic fetch hasn't landed yet.
    expect(COPILOT_CAPABILITIES.models).toContain("auto");
  });

  it("listModels() projects SDK ModelInfo via a throwaway client", async () => {
    const sdk = makeMockSdk({
      models: [
        // Plain entry with no metadata — projects to id + tools=true.
        { id: "auto" },
        // Premium tier with vision; the projection should carry both.
        {
          id: "gpt-5",
          name: "GPT-5",
          capabilities: { supports: { vision: true } },
          billing: { multiplier: 3 },
        },
        // Mid tier.
        { id: "claude-opus-4", billing: { multiplier: 2 } },
      ],
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["auto", "gpt-5", "claude-opus-4"]);
    expect(models[0]!.supports).toEqual({ tools: true });
    expect(models[1]!.displayName).toBe("GPT-5");
    expect(models[1]!.supports).toEqual({ tools: true, vision: true });
    expect(models[1]!.costTier).toBe("high");
    expect(models[2]!.costTier).toBe("mid");
    // The throwaway client must have been started and stopped — leaking
    // it would orphan a CLI subprocess.
    expect(sdk.lastClient()!.stopped).toBe(true);
  });

  it("listModels() falls back to bare-id projections of capabilities.models when the SDK errors", async () => {
    const sdk = makeMockSdk({ startError: new Error("ECONNREFUSED") });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => undefined,
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual([...COPILOT_CAPABILITIES.models]);
    // Fallback carries no metadata — only the id.
    expect(models.every((m) => m.displayName === undefined)).toBe(true);
    expect(models.every((m) => m.costTier === undefined)).toBe(true);
  });

  it("caches the live result across calls (no second CLI spawn on success)", async () => {
    const sdk = makeMockSdk({ models: [{ id: "auto" }, { id: "gpt-5" }] });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const a = await provider.listModels();
    const b = await provider.listModels();
    expect(a).toEqual(b);
    // SDK module loader fires once per createClient — on a cache hit no
    // new client is spun up.
    expect(loader.count()).toBe(1);
  });

  it("does NOT cache the curated fallback (retries the SDK next call)", async () => {
    let failOnce = true;
    const sdk = makeMockSdk();
    const loader = {
      count: 0,
      load: () => {
        loader.count++;
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error("ECONNREFUSED"));
        }
        return Promise.resolve(sdk.module);
      },
    };
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const first = await provider.listModels();
    expect(first.map((m) => m.id)).toEqual([...COPILOT_CAPABILITIES.models]);
    // Second call should re-attempt the SDK now that the user may have
    // resolved auth — the fallback isn't sticky.
    const second = await provider.listModels();
    expect(loader.count).toBe(2);
    // Default mock returns the standard trio when no `models` is set —
    // those project to bare-id ModelInfo entries.
    expect(second.map((m) => m.id)).toEqual(["auto", "gpt-5", "claude-sonnet-4.5"]);
  });

  it("copilotCostTier maps the multiplier ranges (regression guard)", async () => {
    // Run through every bucket via a single listModels() call. Keeps the
    // multiplier→tier mapping pinned so we notice if a future tuning
    // shifts the boundaries unexpectedly.
    const sdk = makeMockSdk({
      models: [
        { id: "free-model", billing: { multiplier: 0 } },
        { id: "low-model", billing: { multiplier: 1 } },
        { id: "low-half", billing: { multiplier: 0.5 } },
        { id: "mid-model", billing: { multiplier: 2 } },
        { id: "high-model", billing: { multiplier: 5 } },
        { id: "absent-billing" },
      ],
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "tok",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const m = await provider.listModels();
    expect(m[0]!.costTier).toBe("free");
    expect(m[1]!.costTier).toBe("low");
    expect(m[2]!.costTier).toBe("low");
    expect(m[3]!.costTier).toBe("mid");
    expect(m[4]!.costTier).toBe("high");
    expect(m[5]!.costTier).toBeUndefined();
  });

  it("listModels() projects reasoningEffort capability + tier metadata (F10.6)", async () => {
    const sdk = makeMockSdk({
      models: [
        // Non-reasoning model — no effort surface.
        { id: "gpt-4o", capabilities: { supports: { vision: true } } },
        // Reasoning model — surface supports.reasoningEffort + the per-model
        // tier set + default.
        {
          id: "claude-sonnet-4.5",
          name: "Claude Sonnet 4.5",
          capabilities: { supports: { reasoningEffort: true } },
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "medium",
        },
      ],
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "tok",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const models = await provider.listModels();
    expect(models[0]!.supports?.reasoningEffort).toBeUndefined();
    expect(models[0]!.supportedReasoningEfforts).toBeUndefined();
    expect(models[1]!.supports?.reasoningEffort).toBe(true);
    expect(models[1]!.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(models[1]!.defaultReasoningEffort).toBe("medium");
  });
});

describe("CopilotProvider — reasoning effort (F10.6)", () => {
  it("threads SendQueryOptions.reasoningEffort into SessionConfig", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        model: "claude-sonnet-4.5",
        reasoningEffort: "high",
      }),
    );
    const config = sdk.lastSessionConfig()!;
    expect(config.reasoningEffort).toBe("high");
    expect(config.model).toBe("claude-sonnet-4.5");
  });

  it("omits reasoningEffort from SessionConfig when not supplied", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/tmp"));
    const config = sdk.lastSessionConfig()!;
    expect("reasoningEffort" in config).toBe(false);
  });

  it("translates assistant.reasoning_delta events into thinking chunks", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("assistant.reasoning_delta", { deltaContent: "Let me " });
        session.emit("assistant.reasoning_delta", { deltaContent: "think" });
        session.emit("assistant.message_delta", { deltaContent: "answer" });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    const thinking = chunks.filter((c) => c.type === "thinking");
    const text = chunks.filter((c) => c.type === "text");
    expect(thinking.map((c) => (c as { content: string }).content).join("")).toBe("Let me think");
    expect(text.map((c) => (c as { content: string }).content).join("")).toBe("answer");
  });

  it("falls back to assistant.reasoning when streaming was missed", async () => {
    // Simulate a reasoning model that emits only the final reasoning event —
    // no deltas. Mirrors the assistant.message fallback so the UI never
    // silently drops reasoning text when the SDK skips streaming.
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("assistant.reasoning", {
          content: "the full reasoning",
        });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    const thinking = chunks.filter((c) => c.type === "thinking");
    expect(thinking).toHaveLength(1);
    expect((thinking[0] as { content: string }).content).toBe("the full reasoning");
  });

  it("emits only the unstreamed tail when assistant.reasoning follows deltas", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("assistant.reasoning_delta", { deltaContent: "Let me " });
        session.emit("assistant.reasoning_delta", { deltaContent: "think" });
        // Final event repeats the streamed prefix and adds a tail.
        session.emit("assistant.reasoning", {
          content: "Let me think harder",
        });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    const thinking = chunks
      .filter((c) => c.type === "thinking")
      .map((c) => (c as { content: string }).content);
    // First two from deltas, third is the remainder " harder" from the final.
    expect(thinking).toEqual(["Let me ", "think", " harder"]);
  });

  it("ignores assistant.reasoning when its content equals the streamed deltas (no double-emit)", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("assistant.reasoning_delta", { deltaContent: "hello" });
        session.emit("assistant.reasoning_delta", { deltaContent: " world" });
        // Final repeats the streamed text exactly — no remainder.
        session.emit("assistant.reasoning", { content: "hello world" });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    const thinking = chunks.filter((c) => c.type === "thinking");
    expect(thinking).toHaveLength(2);
    expect(thinking.map((c) => (c as { content: string }).content).join("")).toBe("hello world");
  });

  it("ignores empty reasoning deltaContent", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("assistant.reasoning_delta", { deltaContent: "" });
        session.emit("assistant.reasoning_delta", {}); // no deltaContent at all
        session.emit("assistant.reasoning_delta", { deltaContent: "hi" });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    expect(chunks.filter((c) => c.type === "thinking")).toHaveLength(1);
    expect((chunks.find((c) => c.type === "thinking") as { content: string }).content).toBe("hi");
  });

  it("calls session.setModel on resume when reasoningEffort + model are supplied", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", "prior-session-id", {
        model: "claude-sonnet-4.5",
        reasoningEffort: "xhigh",
      }),
    );
    const calls = sdk.lastSession()!.setModelCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("claude-sonnet-4.5");
    expect(calls[0]!.options?.reasoningEffort).toBe("xhigh");
  });

  it("does NOT call setModel on the create-session path", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(
      provider.sendQuery("hi", "/tmp", undefined, {
        model: "claude-sonnet-4.5",
        reasoningEffort: "high",
      }),
    );
    expect(sdk.lastSession()!.setModelCalls).toHaveLength(0);
  });
});

describe("CopilotProvider — Phase 3 S2 tool wiring", () => {
  // Stub ToolDefinition for the projection tests. Tests assert what reaches
  // the SDK's SessionConfig.tools — they do not invoke the handler.
  const fakeTool = {
    name: "cluster",
    description: "Cluster status collector",
    inputSchema: {
      _output: {},
      safeParse: () => ({ success: true, data: {} }),
    } as unknown as import("@keelson/shared").ToolDefinition["inputSchema"],
    execute: async () => {},
  } as unknown as import("@keelson/shared").ToolDefinition;

  it("projects SendQueryOptions.tools into SessionConfig.tools with executor closures", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/tmp", undefined, { tools: [fakeTool] }));
    const cfg = sdk.lastSessionConfig()!;
    expect(cfg.tools).toBeDefined();
    const tools = cfg.tools as Array<{
      name: string;
      description: string;
      handler: unknown;
      skipPermission?: boolean;
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("cluster");
    expect(tools[0]!.description).toBe("Cluster status collector");
    expect(typeof tools[0]!.handler).toBe("function");
    // skipPermission keeps first-party tools out of the SDK approval gate.
    expect(tools[0]!.skipPermission).toBe(true);
  });

  // Optional-only schemas must surface as JSON Schema with per-field types,
  // not as zero-arg tools (the old safeParse({}) heuristic dropped them).
  it("projects optional-only Zod schemas as JSON Schema with field types + descriptions", async () => {
    const optionalSchema = z
      .object({
        user: z.string().optional().describe("GitLab handle for involvement."),
        state: z
          .enum(["opened", "merged", "closed", "all"])
          .optional()
          .describe("Filter by MR state."),
        pipelines: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many recent pipelines per project."),
        allProviders: z.boolean().optional().describe("Include every provider."),
      })
      .strict();
    const filterTool = {
      name: "filtered",
      description: "Tool with optional filters",
      inputSchema: optionalSchema,
      execute: async () => {},
    } as unknown as import("@keelson/shared").ToolDefinition;

    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/tmp", undefined, { tools: [filterTool] }));

    const cfg = sdk.lastSessionConfig()!;
    const tools = cfg.tools as Array<{
      name: string;
      parameters?: Record<string, unknown>;
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.parameters).toBeDefined();
    const params = tools[0]!.parameters as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(params.type).toBe("object");
    expect(params.additionalProperties).toBe(false);
    // Optional-only → no `required` array.
    expect(params.required).toBeUndefined();

    expect(params.properties.user).toEqual({
      type: "string",
      description: "GitLab handle for involvement.",
    });
    expect(params.properties.state).toEqual({
      type: "string",
      enum: ["opened", "merged", "closed", "all"],
      description: "Filter by MR state.",
    });
    expect(params.properties.pipelines).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "How many recent pipelines per project.",
    });
    expect(params.properties.allProviders).toEqual({
      type: "boolean",
      description: "Include every provider.",
    });
  });

  it("projects a required field into the JSON Schema required array", async () => {
    const requiredSchema = z
      .object({
        path: z.string().describe("Where to look."),
        recursive: z.boolean().optional(),
      })
      .strict();
    const tool = {
      name: "needs-arg",
      description: "Tool with a required field",
      inputSchema: requiredSchema,
      execute: async () => {},
    } as unknown as import("@keelson/shared").ToolDefinition;

    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/tmp", undefined, { tools: [tool] }));

    const cfg = sdk.lastSessionConfig()!;
    const tools = cfg.tools as Array<{
      parameters?: { properties: Record<string, unknown>; required?: string[] };
    }>;
    const params = tools[0]!.parameters!;
    expect(params.required).toEqual(["path"]);
    expect(params.properties.recursive).toBeDefined();
  });

  it("omits the parameters block for a truly zero-arg z.object({}).strict()", async () => {
    const emptySchema = z.object({}).strict();
    const tool = {
      name: "noargs",
      description: "Truly zero-arg tool",
      inputSchema: emptySchema,
      execute: async () => {},
    } as unknown as import("@keelson/shared").ToolDefinition;

    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/tmp", undefined, { tools: [tool] }));

    const cfg = sdk.lastSessionConfig()!;
    const tools = cfg.tools as Array<{ parameters?: unknown }>;
    expect(tools[0]!.parameters).toBeUndefined();
  });

  it("omits SessionConfig.tools when no tools are passed", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => session.emit("session.idle"),
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    await drain(provider.sendQuery("hi", "/tmp"));
    const cfg = sdk.lastSessionConfig()!;
    expect("tools" in cfg).toBe(false);
  });

  it("forwards toolCallId from tool.execution_start as the tool_use chunk id", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("tool.execution_start", {
          toolCallId: "call_abc123",
          toolName: "cluster",
          arguments: { persona: "shipper" },
        });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("tool_use");
    const tu = chunks[0] as Extract<MessageChunk, { type: "tool_use" }>;
    expect(tu.id).toBe("call_abc123");
    expect(tu.toolName).toBe("cluster");
  });

  it("synthesizes a tool_use chunk id when the SDK omits toolCallId", async () => {
    const sdk = makeMockSdk({
      scenario: (session) => {
        session.emit("tool.execution_start", {
          toolName: "cluster",
        });
        session.emit("session.idle");
      },
    });
    const loader = loaderFor(sdk);
    const provider = new CopilotProvider({
      getCredential: async () => "real-token",
      clientFactory: new CopilotClientFactory({ sdkLoader: loader.load }),
    });
    const chunks = await drain(provider.sendQuery("hi", "/tmp"));
    expect(chunks).toHaveLength(1);
    const tu = chunks[0] as Extract<MessageChunk, { type: "tool_use" }>;
    expect(typeof tu.id).toBe("string");
    expect(tu.id!.length).toBeGreaterThan(0);
  });
});
