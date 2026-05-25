import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent } from "react";
import {
  type ChatFrame,
  type Conversation,
  type ModelInfo,
  type ProviderInfo,
  type ReasoningEffortLevel,
  type RegisteredToolInfo,
  WIRE_PROTOCOL_VERSION,
} from "@keelson/shared";
import {
  createConversation,
  fetchProviderModels,
  fetchProviders,
  fetchTools,
  getConversation,
} from "../api.ts";
import { useConversation } from "../hooks/useConversation.ts";
import { useConversations } from "../hooks/useConversations.ts";
import {
  createReconnectingChatWs,
  type ReconnectingChatWsHandle,
  type ReconnectingWsState,
} from "../ws.ts";
import { AuthWarning } from "../components/Chat/AuthWarning.tsx";
import { Sidebar } from "../components/Chat/Sidebar.tsx";

// Sentinel used to hide a seeded-conversation kickoff turn that the SPA
// auto-sends. v0 has no seed flows yet — this stays as an exact-match
// sentinel for the legacy `seeded` check; a real value would override it
// once seed flows ship.
const OPENING_PROMPT = "__keelson_seeded_opening_prompt__";
import { ModelChip } from "../components/Chat/ModelChip.tsx";
import { ModelPickerPopover } from "../components/Chat/ModelPickerPopover.tsx";
import { MarkdownContent } from "../components/Chat/MarkdownContent.tsx";
import {
  ToolCallsBlock,
  toolCallsFromContentParts,
  type LiveToolCall,
} from "../components/Chat/ToolCallsBlock.tsx";
import { ThinkingBlock } from "../components/Chat/ThinkingBlock.tsx";
import { ThinkingChip } from "../components/Chat/ThinkingChip.tsx";
import { ReasoningEffortChip } from "../components/Chat/ReasoningEffortChip.tsx";
import { ReasoningEffortPopover } from "../components/Chat/ReasoningEffortPopover.tsx";
import { ToolsChip } from "../components/Chat/ToolsChip.tsx";
import { ToolsPopover } from "../components/Chat/ToolsPopover.tsx";
import { SkeletonStack } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { useSettings, type ModelRef } from "../hooks/useSettings.ts";

type Role = "user" | "assistant" | "system";

interface LocalMessage {
  id: string;
  role: Role;
  content: string;
  streaming?: boolean;
  toolCalls?: LiveToolCall[];
  // Live-only Claude extended-thinking deltas; not persisted.
  thinking?: string;
  // Ended without a clean `done` (user abort or provider error).
  truncated?: boolean;
  // Auto-sent kickoff for lane-seeded chats. Persisted server-side
  // (the model needs a user turn to reply), but filtered from the
  // visible transcript so the chat reads as if the report just arrived.
  hidden?: boolean;
}

const MODEL_PICKER_POPOVER_ID = "chat-model-picker-popover";
const REASONING_EFFORT_POPOVER_ID = "chat-reasoning-effort-popover";
const TOOLS_POPOVER_ID = "chat-tools-popover";

const DEFAULT_REASONING_EFFORT: ReasoningEffortLevel = "medium";

// Lowest-to-highest order for fallback when a model narrows its accepted set.
const CANONICAL_REASONING_LEVELS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

// Never leave an unsupported tier selected: `doSend` forwards whatever is in
// state, so we honor the SDK's per-model default, falling back to the lowest
// supported tier and finally "medium".
function pickEffortSeed(info: {
  defaultReasoningEffort?: ReasoningEffortLevel;
  supportedReasoningEfforts?: readonly ReasoningEffortLevel[];
} | null | undefined): ReasoningEffortLevel {
  const allowed = info?.supportedReasoningEfforts;
  const def = info?.defaultReasoningEffort;
  const isAllowed = (level: ReasoningEffortLevel): boolean =>
    !allowed?.length || allowed.includes(level);
  if (def && isAllowed(def)) return def;
  if (allowed?.length) {
    const lowestSupported = CANONICAL_REASONING_LEVELS.find((l) =>
      allowed.includes(l),
    );
    if (lowestSupported) return lowestSupported;
  }
  return DEFAULT_REASONING_EFFORT;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Order of preference: lastUsed → first registered favorite → Copilot → stub →
// first provider's default. Returns null when no providers are registered.
function pickInitialRef(
  providers: ProviderInfo[],
  modelsByProvider: Record<string, ModelInfo[]>,
  lastUsed: ModelRef | null,
  favorites: ModelRef[],
): ModelRef | null {
  const providerIds = new Set(providers.map((p) => p.id));
  if (lastUsed && providerIds.has(lastUsed.providerId)) return lastUsed;
  for (const fav of favorites) {
    if (providerIds.has(fav.providerId)) return fav;
  }
  const refFor = (providerId: string): ModelRef | null => {
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return null;
    const def = provider.capabilities.defaultModel;
    if (def) return { providerId, modelId: def };
    const [first] = modelsByProvider[providerId] ?? [];
    return first ? { providerId, modelId: first.id } : null;
  };
  return refFor("copilot") ?? refFor("stub") ?? refFor(providers[0]?.id ?? "");
}

const ROLE_LABEL: Record<Role, string> = {
  user: "You",
  assistant: "Assistant",
  system: "System",
};

// Auth/sign-in errors get a sticky toast; everything else gets a normal one.
function isAuthError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("auth") ||
    m.includes("sign in") ||
    m.includes("sign-in") ||
    m.includes("api key") ||
    m.includes("anthropic_api_key") ||
    m.includes("token")
  );
}

export interface ChatProps {
  // Lane → Chat handoff. App passes a primer when the user clicked the
  // sparkle on a lane; Chat consumes it once on mount (when no convo is
  // hydrated) and forwards systemPrompt + name to createConversation on
  // first send. The openingPrompt is auto-fired and hidden from the
  // transcript so the kickoff doesn't clutter the chat.
  pendingSeed?: {
    systemPrompt: string;
    openingPrompt: string;
    name: string;
  } | null;
  onSeedConsumed?: () => void;
}

export function Chat({
  pendingSeed,
  onSeedConsumed,
}: ChatProps = {}) {
  const { conversationId, setConversationId } = useConversation();
  const conversationIdRef = useRef<string | null>(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const conversationsList = useConversations();
  const toast = useToast();
  const { settings, toggleFavorite, setLastUsed, setSidebarCollapsed } =
    useSettings();

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [providerError, setProviderError] = useState<string | null>(null);
  // Snapshot of tools registered at server boot; chip just hides on fetch failure.
  const [tools, setTools] = useState<RegisteredToolInfo[]>([]);
  // Falls back to a bare-id projection of provider.capabilities.models when
  // the live fetch hasn't resolved yet (or failed).
  const [dynamicModels, setDynamicModels] = useState<
    Record<string, ModelInfo[]>
  >({});

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  );

  // The popover walks this directly; falls back to each provider's curated
  // baseline until the live fetch resolves.
  const modelsByProvider = useMemo(() => {
    const out: Record<string, ModelInfo[]> = {};
    for (const p of providers) {
      const live = dynamicModels[p.id];
      if (live) {
        out[p.id] = live;
      } else {
        out[p.id] = (p.capabilities.models ?? []).map((id) => ({ id }));
      }
    }
    return out;
  }, [providers, dynamicModels]);

  // Lets the chip show displayName instead of raw id; falls back to id.
  const selectedModelInfo = useMemo<ModelInfo | null>(() => {
    if (!selectedProviderId || !selectedModel) return null;
    const list = modelsByProvider[selectedProviderId] ?? [];
    return list.find((m) => m.id === selectedModel) ?? null;
  }, [modelsByProvider, selectedModel, selectedProviderId]);

  const providerLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of providers) m.set(p.id, p.displayName);
    return m;
  }, [providers]);

  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-turn opt-in for Claude extended thinking. Resets to true after each
  // send. Hidden chip omits the field so the SDK default fires.
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  // Sticky per-conversation: four valid tiers with no neutral default, so
  // resetting after each send would surprise the user.
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffortLevel>(
    DEFAULT_REASONING_EFFORT,
  );
  // Sending during transcript hydration would reuse the stored conversationId
  // with the fallback providerId, mixing providers in one conversation.
  const [hydrating, setHydrating] = useState<boolean>(
    () => conversationIdRef.current !== null,
  );
  // Single-slot queue for follow-ups typed during a live turn. Ref is the
  // canonical value; state drives pill re-render. Cleared on Stop/Esc/switch;
  // flushed only on a clean `done` frame.
  const queuedPromptRef = useRef<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);

  // Seed + name from a lane Ask handoff. Captured on mount when no convo
  // is hydrated; doSend reads + clears them on the createConversation call
  // so subsequent sends in the same conversation don't re-seed.
  const pendingSeedRef = useRef<string | null>(null);
  const pendingNameRef = useRef<string | null>(null);
  // Opening prompt to auto-fire once providers + model settle. Held until
  // the watcher below can call doSend; cleared if the user edits the
  // prefill before we get there (so we don't ship something they're typing).
  const autoSendPromptRef = useRef<string | null>(null);

  const wsRef = useRef<ReconnectingChatWsHandle | null>(null);
  const wsStateRef = useRef<ReconnectingWsState>("connecting");
  const activeAssistantIdRef = useRef<string | null>(null);
  const pendingSendRef = useRef<{
    prompt: string;
    userId: string;
    assistantId: string;
    // Lane-handoff metadata captured at send time so an
    // UNKNOWN_CONVERSATION retry can recreate the conversation with the
    // same seed/name + keep the user message hidden. Without these, a
    // server-lost-conversation race would degrade a lane-seeded chat
    // into an ordinary unseeded one with the kickoff text visible.
    hideUserMessage: boolean;
    seedForCreate: string | undefined;
    nameForCreate: string | undefined;
  } | null>(null);
  const lastRetriedUserIdRef = useRef<string | null>(null);
  const doSendRef = useRef<
    ((prompt: string, opts?: { hideUserMessage?: boolean }) => Promise<void>) | null
  >(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Don't pin a default here; hydration may have already pinned the stored
  // conversation's provider, and clobbering would mix providers in one chat.
  useEffect(() => {
    let cancelled = false;
    fetchProviders()
      .then((list) => {
        if (cancelled) return;
        setProviders(list);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setProviderError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchTools()
      .then((list) => {
        if (cancelled) return;
        setTools(list);
      })
      .catch(() => {
        // non-fatal — chip just won't render
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Consume a lane Ask handoff exactly once. App clears conversationId
  // before flipping the tab, so by the time Chat mounts there's no
  // hydrating convo to conflict with. We prefill the composer and arm
  // an auto-send; the seed itself rides on the upcoming createConversation.
  useEffect(() => {
    if (!pendingSeed) return;
    if (conversationIdRef.current) return;
    pendingSeedRef.current = pendingSeed.systemPrompt;
    pendingNameRef.current = pendingSeed.name;
    autoSendPromptRef.current = pendingSeed.openingPrompt;
    setInput(pendingSeed.openingPrompt);
    onSeedConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSeed]);

  // Fan-out fetch so the popover renders the full set immediately; curated
  // baseline keeps it usable when a per-provider fetch fails.
  useEffect(() => {
    if (providers.length === 0) return;
    const cancelled = { current: false };
    void Promise.all(
      providers.map(async (p) => {
        try {
          const models = await fetchProviderModels(p.id);
          if (cancelled.current) return;
          setDynamicModels((prev) => ({ ...prev, [p.id]: models }));
        } catch {
          // non-fatal — modelsByProvider falls back to capabilities.models
        }
      }),
    );
    return () => {
      cancelled.current = true;
    };
  }, [providers]);

  // Listens on conversationId so a stale-id 404 (clears conversationId
  // without ever filling selectedProviderId) re-triggers a fresh seed.
  // The `current` guard keeps this idempotent for select/new/delete paths.
  useEffect(() => {
    if (providers.length === 0) return;
    if (conversationIdRef.current !== null) return;
    setSelectedProviderId((current) => {
      if (current) return current;
      const ref = pickInitialRef(
        providers,
        modelsByProvider,
        settings.lastUsed,
        settings.favorites,
      );
      if (!ref) return current;
      setSelectedModel(ref.modelId);
      return ref.providerId;
    });
    // settings reads intentionally only at provider-load time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, conversationId]);

  // Replay a stored conversation's messages on mount. Stale-resolution guard:
  // a sidebar click during this load bumps conversationIdRef, so compare on
  // every callback boundary to prevent an old transcript from overwriting
  // the user's later selection.
  useEffect(() => {
    const storedId = conversationIdRef.current;
    if (!storedId) {
      setHydrating(false);
      return;
    }
    let cancelled = false;
    getConversation(storedId)
      .then((conv) => {
        if (cancelled || conversationIdRef.current !== storedId) return;
        if (!conv) {
          // Null the ref AFTER releasing the hydration spinner — the .finally
          // guard short-circuits when the ref no longer matches storedId.
          setHydrating(false);
          conversationIdRef.current = null;
          setConversationId(null);
          return;
        }
        // Workflow conversations are surfaced only through the Workflows tab.
        // A stored id from before the cut-over (or a manual sessionStorage
        // poke) lands here — drop it and start a blank chat instead of
        // crashing the standard composer path on the synthetic workflow
        // provider.
        if (conv.providerId === "workflow") {
          setHydrating(false);
          conversationIdRef.current = null;
          setConversationId(null);
          return;
        }
        // Pin so the next send doesn't pair a stored conversationId with a
        // different providerId.
        setSelectedProviderId(conv.providerId);
        setSelectedModel(conv.model ?? "");
        // Lane-seeded chats hide the auto-sent first user turn — but ONLY
        // when its content exactly matches the kickoff string. If the user
        // edited the prefilled prompt before auto-send fired, their actual
        // question is the first message and must stay visible.
        const seeded = Boolean(conv.seedSystemPrompt);
        let firstUserSeen = false;
        setMessages(
          conv.messages.map((m) => {
            const isFirstUser = m.role === "user" && !firstUserSeen;
            const hide = isFirstUser && seeded && m.content === OPENING_PROMPT;
            if (isFirstUser) firstUserSeen = true;
            return {
              id: m.id,
              role: m.role,
              content: m.content,
              ...(m.contentParts
                ? { toolCalls: toolCallsFromContentParts(m.contentParts) }
                : {}),
              ...(m.truncated ? { truncated: true } : {}),
              ...(hide ? { hidden: true } : {}),
            };
          }),
        );
      })
      .catch((e: unknown) => {
        if (cancelled || conversationIdRef.current !== storedId) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled || conversationIdRef.current !== storedId) return;
        setHydrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setConversationId]);

  // Close WS on unmount.
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  // Reseed when the active model changes. Skipped for non-reasoning models
  // so a hot-swap doesn't clobber a user-picked tier.
  useEffect(() => {
    if (selectedModelInfo?.supports?.reasoningEffort !== true) return;
    setReasoningEffort(pickEffortSeed(selectedModelInfo));
  }, [selectedModelInfo]);

  // New-chat / sidebar-switch onto the same model doesn't trigger the watch
  // above (selectedModelInfo identity unchanged), so the prior conversation's
  // tier would leak. Caller invokes this explicitly after setting the model.
  const resetEffortForModel = useCallback(
    (providerId: string, modelId: string) => {
      const info = (modelsByProvider[providerId] ?? []).find(
        (m) => m.id === modelId,
      );
      setReasoningEffort(pickEffortSeed(info));
    },
    [modelsByProvider],
  );

  // Auto-scroll on new message content.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const handleFrame = useCallback(
    (frame: ChatFrame) => {
      // Drop frames for non-active conversations, except UNKNOWN_CONVERSATION
      // errors — those are how we detect the stale id and trigger retry.
      const isUnknownConvError =
        frame.event.type === "error" &&
        frame.event.code === "UNKNOWN_CONVERSATION";
      if (
        !isUnknownConvError &&
        frame.conversationId !== conversationIdRef.current
      ) {
        return;
      }
      if (frame.event.type === "chunk") {
        const payload = frame.event.payload;
        if (payload.type === "text") {
          const assistantId = activeAssistantIdRef.current;
          if (!assistantId) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + payload.content }
                : m,
            ),
          );
        } else if (payload.type === "system") {
          const assistantId = activeAssistantIdRef.current;
          const systemMsg: LocalMessage = {
            id: newId(),
            role: "system",
            content: payload.content,
          };
          setMessages((prev) => {
            if (!assistantId) return [...prev, systemMsg];
            const idx = prev.findIndex((m) => m.id === assistantId);
            if (idx === -1) return [...prev, systemMsg];
            return [...prev.slice(0, idx), systemMsg, ...prev.slice(idx)];
          });
        } else if (payload.type === "error") {
          setError(payload.message);
          if (isAuthError(payload.message)) {
            toast.push({ kind: "error", message: payload.message, ttlMs: 0 });
          } else {
            toast.push({ kind: "error", message: payload.message });
          }
        } else if (payload.type === "tool_use") {
          const assistantId = activeAssistantIdRef.current;
          if (!assistantId) return;
          // Emitter id pairs with a later tool_result.toolUseId; the local
          // fallback only serves as a React key (no result will arrive).
          const call: LiveToolCall = {
            id: payload.id ?? newId(),
            toolName: payload.toolName,
            toolInput: payload.toolInput,
          };
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, toolCalls: [...(m.toolCalls ?? []), call] }
                : m,
            ),
          );
        } else if (payload.type === "tool_result") {
          // No-op if the originating tool_use isn't in our list (defensive
          // against stale frames from a previous turn).
          const assistantId = activeAssistantIdRef.current;
          if (!assistantId) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    toolCalls: (m.toolCalls ?? []).map((tc) =>
                      tc.id === payload.toolUseId
                        ? {
                            ...tc,
                            result: payload.content,
                            ...(payload.isError !== undefined
                              ? { isError: payload.isError }
                              : {}),
                          }
                        : tc,
                    ),
                  }
                : m,
            ),
          );
        } else if (payload.type === "thinking") {
          const assistantId = activeAssistantIdRef.current;
          if (!assistantId) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, thinking: (m.thinking ?? "") + payload.content }
                : m,
            ),
          );
        }
        // `done` chunk payload ignored — top-level `done` ends stream
      } else if (frame.event.type === "error") {
        // Auto-recover from server-lost conversationId: roll back the
        // optimistic pair and re-send once with a fresh conversation.
        if (frame.event.code === "UNKNOWN_CONVERSATION") {
          const pending = pendingSendRef.current;
          if (pending && lastRetriedUserIdRef.current !== pending.userId) {
            lastRetriedUserIdRef.current = pending.userId;
            pendingSendRef.current = null;
            activeAssistantIdRef.current = null;
            // Sync ref + state on the same tick; the retry below reads the
            // ref before the mirror effect runs.
            conversationIdRef.current = null;
            setConversationId(null);
            setMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === pending.userId);
              return idx === -1 ? prev : prev.slice(0, idx);
            });
            setStreaming(false);
            // Re-arm the lane handoff so the replacement createConversation
            // gets the same seed + title and the retried user turn stays
            // hidden when it was a lane auto-send. Without this, a server
            // restart mid-flight would silently degrade a Features chat
            // into an unseeded one with the kickoff text visible.
            if (pending.seedForCreate) {
              pendingSeedRef.current = pending.seedForCreate;
            }
            if (pending.nameForCreate) {
              pendingNameRef.current = pending.nameForCreate;
            }
            void doSendRef.current?.(pending.prompt, {
              hideUserMessage: pending.hideUserMessage,
            });
            return;
          }
          setConversationId(null);
        }
        // Capture before nulling — the setMessages updater runs on the next
        // render, by which time the ref would otherwise read null.
        const assistantId = activeAssistantIdRef.current;
        activeAssistantIdRef.current = null;
        pendingSendRef.current = null;
        setError(frame.event.message);
        setStreaming(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, streaming: false } : m,
          ),
        );
        if (isAuthError(frame.event.message)) {
          toast.push({ kind: "error", message: frame.event.message, ttlMs: 0 });
        } else {
          toast.push({ kind: "error", message: frame.event.message });
        }
      } else if (frame.event.type === "done") {
        const assistantId = activeAssistantIdRef.current;
        activeAssistantIdRef.current = null;
        pendingSendRef.current = null;
        setStreaming(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, streaming: false } : m,
          ),
        );
        // Clean `done` flushes the queue. Provider errors leave it parked so
        // the user can recover the prompt via the pill.
        const nextQueued = queuedPromptRef.current;
        if (nextQueued !== null) {
          queuedPromptRef.current = null;
          setQueued(null);
          void doSendRef.current?.(nextQueued);
        }
        // Pick up the server's auto-name write and bumped updatedAt.
        const cid = conversationIdRef.current;
        if (cid) {
          void getConversation(cid)
            .then((conv) => {
              if (conv) conversationsList.upsertLocal(conv);
            })
            .catch(() => {
              // non-fatal — sidebar will catch up on next refresh
            });
        }
      }
    },
    [conversationsList, setConversationId, toast],
  );

  const ensureWs = useCallback((): ReconnectingChatWsHandle => {
    if (wsRef.current) return wsRef.current;
    const handle = createReconnectingChatWs({
      onFrame: handleFrame,
      onStateChange: (state) => {
        const prior = wsStateRef.current;
        wsStateRef.current = state;
        if (state === "reconnecting" && prior === "open") {
          toast.push({
            kind: "info",
            message: "Connection lost, reconnecting…",
          });
          // Recover input state so the user isn't staring at a stale cursor.
          const assistantId = activeAssistantIdRef.current;
          if (assistantId) {
            activeAssistantIdRef.current = null;
            pendingSendRef.current = null;
            setStreaming(false);
            setError("Connection dropped during response");
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, streaming: false } : m,
              ),
            );
          }
        } else if (state === "open" && prior === "reconnecting") {
          toast.push({ kind: "ok", message: "Reconnected." });
        }
      },
    });
    wsRef.current = handle;
    return handle;
  }, [handleFrame, toast]);

  const doSend = useCallback(
    async (prompt: string, opts?: { hideUserMessage?: boolean }) => {
      if (!selectedProviderId) {
        setError("No provider selected");
        return;
      }
      setError(null);
      // Disable composer immediately so a slow `createConversation` POST
      // can't race a second submit into duplicate conversations.
      setStreaming(true);

      // Captured at outer scope so the pendingSendRef below can carry the
      // lane metadata into an UNKNOWN_CONVERSATION retry — preserves the
      // seed + title when the WS layer recreates the conversation.
      let seedForCreate: string | undefined;
      let nameForCreate: string | undefined;

      let convoId = conversationIdRef.current;
      if (!convoId) {
        seedForCreate = pendingSeedRef.current ?? undefined;
        nameForCreate = pendingNameRef.current ?? undefined;
        try {
          const c = await createConversation(
            selectedProviderId,
            selectedModel || undefined,
            seedForCreate,
            nameForCreate,
          );
          convoId = c.id;
          setConversationId(c.id);
          conversationIdRef.current = c.id;
          // Clear only after the server has persisted — a thrown
          // createConversation leaves seed+name armed for retry.
          pendingSeedRef.current = null;
          pendingNameRef.current = null;
          conversationsList.upsertLocal(c);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          toast.push({ kind: "error", message: msg });
          setStreaming(false);
          return;
        }
      }

      // Empty modelId means "provider default".
      setLastUsed({ providerId: selectedProviderId, modelId: selectedModel });

      const userMsg: LocalMessage = {
        id: newId(),
        role: "user",
        content: prompt,
        ...(opts?.hideUserMessage ? { hidden: true } : {}),
      };
      const assistantId = newId();
      const assistantMsg: LocalMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        streaming: true,
      };
      activeAssistantIdRef.current = assistantId;
      pendingSendRef.current = {
        prompt,
        userId: userMsg.id,
        assistantId,
        hideUserMessage: opts?.hideUserMessage ?? false,
        seedForCreate,
        nameForCreate,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);

      // Avoid shipping a no-op flag when the model doesn't support it.
      const supportsThinking =
        selectedModelInfo?.supports?.thinking === true;
      const supportsEffort =
        selectedModelInfo?.supports?.reasoningEffort === true;

      const ws = ensureWs();
      ws.send({
        version: WIRE_PROTOCOL_VERSION,
        conversationId: convoId,
        message: {
          type: "request",
          providerId: selectedProviderId,
          prompt,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(supportsThinking ? { thinking: thinkingEnabled } : {}),
          ...(supportsEffort ? { reasoningEffort } : {}),
        },
      });

      if (supportsThinking && !thinkingEnabled) {
        setThinkingEnabled(true);
      }
    },
    [
      conversationsList,
      ensureWs,
      reasoningEffort,
      selectedModel,
      selectedModelInfo,
      selectedProviderId,
      setConversationId,
      setLastUsed,
      thinkingEnabled,
      toast,
    ],
  );

  // Ref-shim so handleFrame's retry doesn't need doSend as a dep (would
  // otherwise recreate the WS handler on every render).
  useEffect(() => {
    doSendRef.current = doSend;
  }, [doSend]);

  // Auto-fire a lane-seeded opening prompt once providers + model resolve.
  // Bails if the user has edited the prefill — their text wins. The ref
  // is cleared either way so the watcher fires at most once per handoff.
  // Also bails if a conversation has been selected since arming (e.g. the
  // user clicked a sidebar entry while providers were still loading) —
  // we don't want to dump a hidden kickoff into the wrong chat.
  useEffect(() => {
    const armed = autoSendPromptRef.current;
    if (!armed) return;
    if (conversationId !== null) {
      // A conversation was selected while we were waiting — disarm the
      // seed entirely so subsequent sends in this chat don't accidentally
      // get the lane seed/name attached either. Also clear the textarea:
      // without this, the lane opening prompt would still be sitting in
      // the input and a stray Enter after hydration would dump it into
      // the wrong conversation.
      autoSendPromptRef.current = null;
      pendingSeedRef.current = null;
      pendingNameRef.current = null;
      if (input === armed) {
        // Only clear if the input still matches the prefill — preserves
        // anything the user has already typed if they navigated away
        // mid-edit.
        setInput("");
      }
      return;
    }
    if (!selectedProviderId) return;
    if (hydrating || streaming) return;
    if (input.trim() !== armed.trim()) {
      // User edited the prefill (or it was cleared by clicking New) before
      // auto-send fired. Drop the entire lane handoff — seed + name + auto-
      // send prompt — so a later unrelated send doesn't pick up a stale
      // lane seed and accidentally tag a new chat as "Features" / etc.
      // Tradeoff: a user who tweaks the kickoff loses the lane seed for
      // that send, but the model can still call bridge_* tools to refetch.
      autoSendPromptRef.current = null;
      pendingSeedRef.current = null;
      pendingNameRef.current = null;
      return;
    }
    autoSendPromptRef.current = null;
    setInput("");
    void doSend(armed, { hideUserMessage: true });
  }, [conversationId, selectedProviderId, hydrating, streaming, input, doSend]);

  const onSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || hydrating) return;
    // Mid-turn: stash for auto-flush on clean `done`. Single-slot — a second
    // Enter replaces the queued prompt.
    if (streaming) {
      queuedPromptRef.current = trimmed;
      setQueued(trimmed);
      setInput("");
      return;
    }
    setInput("");
    void doSend(trimmed);
  }, [doSend, hydrating, input, streaming]);

  // Cancels auto-send by returning the prompt to the textarea for editing.
  const onCancelQueue = useCallback(() => {
    const pending = queuedPromptRef.current;
    if (pending !== null) setInput(pending);
    queuedPromptRef.current = null;
    setQueued(null);
  }, []);

  const onInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    },
    [onSubmit],
  );

  // Switching provider via the picker is only reachable on a fresh chat —
  // the popover disables foreign-provider rows once a conversation exists.
  const onModelSelect = useCallback((ref: ModelRef) => {
    setSelectedProviderId(ref.providerId);
    setSelectedModel(ref.modelId);
  }, []);

  // Closes the WS so the server-side AbortController fires; clears local refs
  // so the next send spins up a fresh socket. Without this, the stale-frame
  // filter drops the trailing `done` and `streaming` never returns to false.
  const abortActiveStream = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
      // Reset so the next handle's "connecting" → "open" transition doesn't
      // compare against a stale "open" prior and mis-fire "Reconnected".
      wsStateRef.current = "connecting";
    }
    const assistantId = activeAssistantIdRef.current;
    activeAssistantIdRef.current = null;
    pendingSendRef.current = null;
    setStreaming(false);
    if (assistantId) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, streaming: false } : m,
        ),
      );
    }
    // Interruption drops the queue — auto-firing after Stop would surprise.
    queuedPromptRef.current = null;
    setQueued(null);
  }, []);

  // Window-level so popovers (which stopPropagation Esc) still win when open.
  useEffect(() => {
    if (!streaming) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        abortActiveStream();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [abortActiveStream, streaming]);

  // Sidebar interactions.
  const onSelectConversation = useCallback(
    (id: string) => {
      if (id === conversationIdRef.current) return;
      abortActiveStream();
      setError(null);
      setHydrating(true);
      setConversationId(id);
      conversationIdRef.current = id;
      // Stale-resolution guard: rapid clicks fire overlapping requests; a
      // slow first response can resolve after a faster later one and would
      // otherwise overwrite the active conversation. Compare on every
      // callback boundary so old loads silently drop.
      void getConversation(id)
        .then((conv) => {
          if (conversationIdRef.current !== id) return;
          if (!conv) {
            conversationIdRef.current = null;
            setConversationId(null);
            setMessages([]);
            return;
          }
          setSelectedProviderId(conv.providerId);
          setSelectedModel(conv.model ?? "");
          // Switching onto the same reasoning model wouldn't fire the
          // model-watch effect; reset the tier explicitly so the prior
          // chat's pick doesn't leak.
          if (conv.model) {
            resetEffortForModel(conv.providerId, conv.model);
          }
          const seeded = Boolean(conv.seedSystemPrompt);
          let firstUserSeen = false;
          setMessages(
            conv.messages.map((m) => {
              const isFirstUser = m.role === "user" && !firstUserSeen;
              const hide = isFirstUser && seeded && m.content === OPENING_PROMPT;
              if (isFirstUser) firstUserSeen = true;
              return {
                id: m.id,
                role: m.role,
                content: m.content,
                ...(m.contentParts
                  ? { toolCalls: toolCallsFromContentParts(m.contentParts) }
                  : {}),
                ...(m.truncated ? { truncated: true } : {}),
                ...(hide ? { hidden: true } : {}),
              };
            }),
          );
        })
        .catch((e: unknown) => {
          if (conversationIdRef.current !== id) return;
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          toast.push({ kind: "error", message: msg });
        })
        .finally(() => {
          if (conversationIdRef.current !== id) return;
          setHydrating(false);
        });
    },
    [abortActiveStream, resetEffortForModel, setConversationId, toast],
  );

  const onNewConversation = useCallback(() => {
    abortActiveStream();
    setConversationId(null);
    conversationIdRef.current = null;
    setMessages([]);
    setError(null);
    // Explicit "fresh start" — clear the textarea AND drop any armed lane
    // handoff so a sidebar New click after lane Ask (while providers were
    // still loading) doesn't auto-send the lane kickoff into what the user
    // intends to be a blank chat.
    setInput("");
    autoSendPromptRef.current = null;
    pendingSeedRef.current = null;
    pendingNameRef.current = null;
    // Re-seed from latest settings so a fresh chat picks up changes since
    // this view mounted (starring, sending on a different provider).
    const ref = pickInitialRef(
      providers,
      modelsByProvider,
      settings.lastUsed,
      settings.favorites,
    );
    if (ref) {
      setSelectedProviderId(ref.providerId);
      setSelectedModel(ref.modelId);
      resetEffortForModel(ref.providerId, ref.modelId);
    } else {
      setSelectedProviderId("");
      setSelectedModel("");
      setReasoningEffort(DEFAULT_REASONING_EFFORT);
    }
  }, [
    abortActiveStream,
    modelsByProvider,
    providers,
    resetEffortForModel,
    setConversationId,
    settings.favorites,
    settings.lastUsed,
  ]);

  const onRenameConversation = useCallback(
    async (id: string, name: string) => {
      try {
        await conversationsList.rename(id, name);
        toast.push({ kind: "ok", message: `Renamed to "${name}"` });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.push({ kind: "error", message: msg });
        throw e; // let Sidebar know it failed
      }
    },
    [conversationsList, toast],
  );

  const onDeleteConversation = useCallback(
    async (id: string) => {
      // Abort before DELETE so the provider call bails on its AbortSignal
      // before the conversation row disappears.
      if (id === conversationIdRef.current) {
        abortActiveStream();
      }
      try {
        await conversationsList.remove(id);
        if (id === conversationIdRef.current) {
          setConversationId(null);
          conversationIdRef.current = null;
          setMessages([]);
        }
        toast.push({ kind: "ok", message: "Conversation deleted" });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.push({ kind: "error", message: msg });
        throw e;
      }
    },
    [abortActiveStream, conversationsList, setConversationId, toast],
  );

  const activeRef: ModelRef | null = selectedProviderId
    ? { providerId: selectedProviderId, modelId: selectedModel }
    : null;
  // Foreign-provider popover rows disable once a conversation exists.
  const lockedProviderId = conversationId !== null ? selectedProviderId : null;

  const sidebarCollapsed = settings.sidebarCollapsed ?? false;

  return (
    <div
      className={`chat-layout${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
    >
      <Sidebar
        conversations={conversationsList.conversations as Conversation[]}
        loading={conversationsList.loading}
        activeId={conversationId}
        streamingId={streaming ? conversationId : null}
        providerLabels={providerLabels}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        onSelect={onSelectConversation}
        onNew={onNewConversation}
        onRename={onRenameConversation}
        onDelete={onDeleteConversation}
      />

      <div className="chat-wrap">
        <div className="chat-toolbar">
          <AuthWarning providerId={selectedProviderId} />
          {providerError && <span className="chat-error">{providerError}</span>}
        </div>

        <div className="chat-messages">
          {/* Skeleton + empty state key off VISIBLE message count. A lane-
              seeded chat that lost its assistant turn (auth failure, abort)
              persists only the hidden kickoff; without this, the pane would
              render blank with no empty-state hint. */}
          {(() => {
            const visibleMessages = messages.filter((m) => !m.hidden);
            return (
              <>
                {hydrating && visibleMessages.length === 0 && (
                  <div className="chat-skeleton">
                    <SkeletonStack rows={2} height="3.5em" />
                  </div>
                )}
                {!hydrating && visibleMessages.length === 0 && (
                  <div className="empty-state">
                    Send a message to start a conversation.
                  </div>
                )}
                {visibleMessages.map((m) => (
            <div key={m.id} className={`chat-message ${m.role}`}>
              <span className="chat-role">{ROLE_LABEL[m.role]}</span>
              <div className={`chat-bubble${m.streaming ? " streaming" : ""}`}>
                {m.role === "assistant" ? (
                  <>
                    {m.thinking && m.thinking.length > 0 && (
                      <ThinkingBlock
                        content={m.thinking}
                        streaming={m.streaming ?? false}
                      />
                    )}
                    {m.toolCalls && m.toolCalls.length > 0 && (
                      <ToolCallsBlock
                        toolCalls={m.toolCalls}
                        streaming={m.streaming ?? false}
                      />
                    )}
                    <MarkdownContent source={m.content} />
                    {m.truncated && (
                      <div className="chat-truncated-marker">
                        Turn stopped — partial result.
                      </div>
                    )}
                  </>
                ) : (
                  m.content
                )}
              </div>
            </div>
                ))}
              </>
            );
          })()}
          <div ref={messagesEndRef} />
        </div>

        {error && <div className="chat-error">{error}</div>}

        <div className="chat-composer">
          <textarea
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Type a message — Enter to send, Shift+Enter for newline"
            disabled={hydrating || !selectedProviderId}
            rows={2}
          />
          <div className="chat-composer-chips">
            <ModelChip
              providerLabel={
                selectedProvider?.displayName ?? "Loading…"
              }
              modelId={selectedModel}
              modelDisplayName={selectedModelInfo?.displayName}
              popoverId={MODEL_PICKER_POPOVER_ID}
              disabled={streaming || providers.length === 0}
            />
            {selectedModelInfo?.supports?.thinking === true && (
              <ThinkingChip
                enabled={thinkingEnabled}
                onToggle={() => setThinkingEnabled((prev) => !prev)}
                disabled={streaming}
              />
            )}
            {selectedModelInfo?.supports?.reasoningEffort === true && (
              <ReasoningEffortChip
                level={reasoningEffort}
                popoverId={REASONING_EFFORT_POPOVER_ID}
                disabled={streaming}
              />
            )}
            {selectedProvider?.capabilities.tools === true && tools.length > 0 && (
              <ToolsChip
                count={tools.length}
                popoverId={TOOLS_POPOVER_ID}
                disabled={streaming}
              />
            )}
            <span className="chat-composer-spacer" />
            {queued !== null && (
              <button
                type="button"
                className="chat-queued-pill"
                onClick={onCancelQueue}
                title="Click to edit the queued message"
              >
                1 queued · click to edit
              </button>
            )}
            {streaming ? (
              <button
                type="button"
                className="chat-stop"
                onClick={abortActiveStream}
                aria-label="Stop generating"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="chat-send"
                onClick={onSubmit}
                disabled={
                  hydrating ||
                  !selectedProviderId ||
                  input.trim().length === 0
                }
              >
                {hydrating ? "Loading…" : "Send"}
              </button>
            )}
          </div>
        </div>

        <ModelPickerPopover
          popoverId={MODEL_PICKER_POPOVER_ID}
          providers={providers}
          modelsByProvider={modelsByProvider}
          activeRef={activeRef}
          favorites={settings.favorites}
          lockedProviderId={lockedProviderId}
          onSelect={onModelSelect}
          onToggleFavorite={toggleFavorite}
        />

        {selectedModelInfo?.supports?.reasoningEffort === true && (
          <ReasoningEffortPopover
            popoverId={REASONING_EFFORT_POPOVER_ID}
            activeLevel={reasoningEffort}
            supportedLevels={selectedModelInfo.supportedReasoningEfforts}
            onSelect={setReasoningEffort}
          />
        )}

        {selectedProvider?.capabilities.tools === true && tools.length > 0 && (
          <ToolsPopover popoverId={TOOLS_POPOVER_ID} tools={tools} />
        )}
      </div>
    </div>
  );
}
