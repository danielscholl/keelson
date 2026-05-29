import type { Project } from "@keelson/shared";
import {
  type ChatFrame,
  type Conversation,
  DEFAULT_PROJECT_NAME,
  type ModelInfo,
  type ProviderInfo,
  type ReasoningEffortLevel,
  type RegisteredToolInfo,
  WIRE_PROTOCOL_VERSION,
} from "@keelson/shared";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cloneProject,
  createConversation,
  createProject,
  deleteProject,
  fetchProviderModels,
  fetchProviders,
  fetchTools,
  getConversation,
  listProjects,
  listWorkflows,
  rememberChatMessage,
  startWorkflowRun,
} from "../api.ts";
import { AuthWarning } from "../components/Chat/AuthWarning.tsx";
import { Sidebar } from "../components/Chat/Sidebar.tsx";
import { SaveToMemoryModal } from "../components/Memory/SaveToMemoryModal.tsx";
import { useConversation } from "../hooks/useConversation.ts";
import { useConversations } from "../hooks/useConversations.ts";
import {
  createReconnectingChatWs,
  type ReconnectingChatWsHandle,
  type ReconnectingWsState,
} from "../ws.ts";

// Sentinel used to hide a seeded-conversation kickoff turn that the SPA
// auto-sends. No seed flows ship yet — this stays as an exact-match sentinel
// for the legacy `seeded` check; a real value would override it once seed
// flows ship.
const OPENING_PROMPT = "__keelson_seeded_opening_prompt__";

import { CommandCallBlock } from "../components/Chat/CommandCallBlock.tsx";
import { MarkdownContent } from "../components/Chat/MarkdownContent.tsx";
import { ModelChip } from "../components/Chat/ModelChip.tsx";
import { ModelPickerPopover } from "../components/Chat/ModelPickerPopover.tsx";
import { ProjectChip } from "../components/Chat/ProjectChip.tsx";
import { ProjectPickerPopover } from "../components/Chat/ProjectPickerPopover.tsx";
import { ReasoningEffortChip } from "../components/Chat/ReasoningEffortChip.tsx";
import { ReasoningEffortPopover } from "../components/Chat/ReasoningEffortPopover.tsx";
import { SlashCommandPopover } from "../components/Chat/SlashCommandPopover.tsx";
import { ThinkingBlock } from "../components/Chat/ThinkingBlock.tsx";
import { ThinkingChip } from "../components/Chat/ThinkingChip.tsx";
import {
  type LiveToolCall,
  ToolCallsBlock,
  toolCallsFromContentParts,
} from "../components/Chat/ToolCallsBlock.tsx";
import { ToolsChip } from "../components/Chat/ToolsChip.tsx";
import { ToolsPopover } from "../components/Chat/ToolsPopover.tsx";
import { SkeletonStack } from "../components/Skeleton.tsx";
import { useToast } from "../components/Toast.tsx";
import { useActiveProject } from "../hooks/useActiveProject.ts";
import { type ModelRef, useSettings } from "../hooks/useSettings.ts";
import { parseWorkflowDescription } from "../lib/parseWorkflowDescription.ts";
import {
  filterSlashCommands,
  isCommittedToCommand,
  matchSlashCommand,
  parseWorkflowCommand,
  type SlashCommand,
  type SlashCommandFamily,
} from "../lib/slashCommands.ts";

type Role = "user" | "assistant" | "system" | "command";

// runId/workflowName populate only for a started `/workflow run`, so the
// result block can offer a link into the Workflows view.
interface CommandResult {
  ok: boolean;
  message: string;
  runId?: string;
  workflowName?: string;
}

interface CommandCall {
  command: string;
  args: string;
  family: SlashCommandFamily;
  // Undefined while the dispatcher is in flight; populated on resolution.
  result?: CommandResult;
}

interface LocalMessage {
  id: string;
  role: Role;
  content: string;
  streaming?: boolean;
  toolCalls?: LiveToolCall[];
  commandCall?: CommandCall;
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
const PROJECT_PICKER_POPOVER_ID = "chat-project-picker-popover";
const REASONING_EFFORT_POPOVER_ID = "chat-reasoning-effort-popover";
const SLASH_PICKER_POPOVER_ID = "chat-slash-picker-popover";
const TOOLS_POPOVER_ID = "chat-tools-popover";

const DEFAULT_REASONING_EFFORT: ReasoningEffortLevel = "medium";

// Seed-preference order when a model narrows its accepted set. "none" (skip
// reasoning) is last so the fallback prefers the lowest real reasoning tier;
// we only auto-seed "none" when it's the sole tier a model offers.
const CANONICAL_REASONING_LEVELS: readonly ReasoningEffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "none",
] as const;

// Never leave an unsupported tier selected: `doSend` forwards whatever is in
// state, so we honor the SDK's per-model default, falling back to the lowest
// supported tier and finally "medium".
function pickEffortSeed(
  info:
    | {
        defaultReasoningEffort?: ReasoningEffortLevel;
        supportedReasoningEfforts?: readonly ReasoningEffortLevel[];
      }
    | null
    | undefined,
): ReasoningEffortLevel {
  const allowed = info?.supportedReasoningEfforts;
  const def = info?.defaultReasoningEffort;
  const isAllowed = (level: ReasoningEffortLevel): boolean =>
    !allowed?.length || allowed.includes(level);
  if (def && isAllowed(def)) return def;
  if (allowed?.length) {
    const lowestSupported = CANONICAL_REASONING_LEVELS.find((l) => allowed.includes(l));
    if (lowestSupported) return lowestSupported;
  }
  return DEFAULT_REASONING_EFFORT;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Server-side message IDs are `crypto.randomUUID()` (36 chars, dashed) —
// `newId()` is the local placeholder during a live turn. Id-driven endpoints
// like `/api/chat/:cid/messages/:mid/remember` only resolve the UUID form;
// the done-frame reconcile below swaps client IDs for the persisted ones
// after a turn completes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isPersistedMessageId(id: string): boolean {
  return UUID_RE.test(id);
}

// Snapshot of a just-completed turn's client-side ids + their index in the
// non-system local sequence. Captured at `done` time BEFORE flushing any
// queued follow-up. The server's `messages` array is append-only, so the
// indices remain valid as later turns get persisted.
interface TurnReconcileSnapshot {
  assistantClientId: string | null;
  userClientId: string | null;
  // Count of non-system local messages at done-time. The just-completed
  // assistant lives at server[nonSystemCount - 1], its user at [nonSystemCount - 2].
  nonSystemCount: number;
}

// Reconcile only the specific client ids of a just-completed turn, located
// by their stable server-side index. A role-only tail walk would corrupt
// freshly-minted local ids when a follow-up turn was queued during
// streaming — the new local rows append before the reconcile fetch
// resolves, so a tail walk would rewrite their ids to the just-completed
// turn's persisted ids and chunk dispatch for the follow-up would break.
function reconcileTurnIds<T extends { id: string; role: string }>(
  local: T[],
  server: readonly { id: string; role: string }[],
  snap: TurnReconcileSnapshot,
): T[] {
  if (server.length < snap.nonSystemCount) return local;
  const aIdx = snap.nonSystemCount - 1;
  const uIdx = snap.nonSystemCount - 2;
  const serverAssistant = aIdx >= 0 ? server[aIdx] : null;
  const serverUser = uIdx >= 0 ? server[uIdx] : null;

  let updated: T[] | null = null;
  if (
    snap.assistantClientId &&
    serverAssistant?.role === "assistant" &&
    !isPersistedMessageId(snap.assistantClientId)
  ) {
    const idx = local.findIndex((m) => m.id === snap.assistantClientId);
    const row = idx >= 0 ? local[idx] : undefined;
    if (idx >= 0 && row) {
      if (updated === null) updated = local.slice();
      updated[idx] = { ...row, id: serverAssistant.id };
    }
  }
  if (
    snap.userClientId &&
    serverUser?.role === "user" &&
    !isPersistedMessageId(snap.userClientId)
  ) {
    const base = updated ?? local;
    const idx = base.findIndex((m) => m.id === snap.userClientId);
    const row = idx >= 0 ? base[idx] : undefined;
    if (idx >= 0 && row) {
      if (updated === null) updated = local.slice();
      updated[idx] = { ...row, id: serverUser.id };
    }
  }
  return updated ?? local;
}

// Build the snapshot from current local state. The completed turn's
// assistant is the last non-system message; its user is the immediately
// preceding non-system row (almost always role === "user"). Returns null
// when there's nothing to reconcile yet.
function snapshotTurnForReconcile<T extends { id: string; role: string }>(
  local: T[],
): TurnReconcileSnapshot | null {
  const nonSystem = local.filter((m) => m.role !== "system" && m.role !== "command");
  if (nonSystem.length === 0) return null;
  const lastAssistant = nonSystem[nonSystem.length - 1];
  const lastUser = nonSystem[nonSystem.length - 2];
  return {
    assistantClientId: lastAssistant?.role === "assistant" ? lastAssistant.id : null,
    userClientId: lastUser?.role === "user" ? lastUser.id : null,
    nonSystemCount: nonSystem.length,
  };
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
  command: "Command",
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
  // Opens a started workflow run in the Workflows view (from a `/workflow run`
  // result block). App lifts this so it can switch tabs and deep-link the run.
  onOpenWorkflowRun?: (workflowName: string, runId: string) => void;
}

export function Chat({ pendingSeed, onSeedConsumed, onOpenWorkflowRun }: ChatProps = {}) {
  const { conversationId, setConversationId } = useConversation();
  const conversationIdRef = useRef<string | null>(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const conversationsList = useConversations();
  const toast = useToast();
  const { settings, toggleFavorite, setLastUsed, setSidebarCollapsed } = useSettings();

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [providerError, setProviderError] = useState<string | null>(null);
  // Snapshot of tools registered at server boot; chip just hides on fetch failure.
  const [tools, setTools] = useState<RegisteredToolInfo[]>([]);
  // Falls back to a bare-id projection of provider.capabilities.models when
  // the live fetch hasn't resolved yet (or failed).
  const [dynamicModels, setDynamicModels] = useState<Record<string, ModelInfo[]>>({});

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
  // Mirror of `messages` for synchronous reads from WS frame handlers — the
  // done handler captures a turn snapshot before flushing a queued follow-up,
  // and `setMessages(updater)` only fires the updater on the next render so
  // we can't snapshot from inside it without racing the queue dispatch.
  const messagesRef = useRef<LocalMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const {
    projects: projectList,
    activeProject,
    activeProjectId,
    setActiveProject,
    refresh: refreshProjects,
  } = useActiveProject();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-turn opt-in for Claude extended thinking. Resets to true after each
  // send. Hidden chip omits the field so the SDK default fires.
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  // Sticky per-conversation: four valid tiers with no neutral default, so
  // resetting after each send would surprise the user.
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffortLevel>(DEFAULT_REASONING_EFFORT);
  // Sending during transcript hydration would reuse the stored conversationId
  // with the fallback providerId, mixing providers in one conversation.
  const [hydrating, setHydrating] = useState<boolean>(() => conversationIdRef.current !== null);
  // Single-slot queue for follow-ups typed during a live turn. Ref is the
  // canonical value; state drives pill re-render. Cleared on Stop/Esc/switch;
  // flushed only on a clean `done` frame.
  const queuedPromptRef = useRef<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);

  const [slashOpen, setSlashOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);

  // Save-to-memory modal state. Open when a target message is set; the
  // submitting flag disables the modal's submit button + the per-message
  // Save buttons so a double-click can't fire twice.
  const [memoryTarget, setMemoryTarget] = useState<{
    id: string;
    role: "user" | "assistant";
    content: string;
  } | null>(null);
  const [savingMemory, setSavingMemory] = useState(false);

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
  // Ref-shim so switchActiveProject can abort a live stream without
  // forward-declaring abortActiveStream (which depends on later state).
  const abortActiveStreamRef = useRef<(() => void) | null>(null);
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
  }, [pendingSeed, onSeedConsumed]);

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
  }, [providers, settings.lastUsed, settings.favorites, modelsByProvider]);

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
              ...(m.contentParts ? { toolCalls: toolCallsFromContentParts(m.contentParts) } : {}),
              ...(m.truncated ? { truncated: true } : {}),
              ...(hide ? { hidden: true } : {}),
            };
          }),
        );
        // Pin the chip to the conversation's project so the picker reflects
        // the cwd handleChatRequest will resolve, not the cross-conversation
        // global active id. Clear it when the conversation's project was
        // deleted (FK NULLed) so the chip falls back to default instead of
        // continuing to show the previously-active project.
        setActiveProject(conv.projectId ?? null);
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
  }, [setActiveProject, setConversationId]);

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
      const info = (modelsByProvider[providerId] ?? []).find((m) => m.id === modelId);
      setReasoningEffort(pickEffortSeed(info));
    },
    [modelsByProvider],
  );

  // Auto-scroll on new message content.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  const handleFrame = useCallback(
    (frame: ChatFrame) => {
      // Drop frames for non-active conversations, except UNKNOWN_CONVERSATION
      // errors — those are how we detect the stale id and trigger retry.
      const isUnknownConvError =
        frame.event.type === "error" && frame.event.code === "UNKNOWN_CONVERSATION";
      if (!isUnknownConvError && frame.conversationId !== conversationIdRef.current) {
        return;
      }
      if (frame.event.type === "chunk") {
        const payload = frame.event.payload;
        if (payload.type === "text") {
          const assistantId = activeAssistantIdRef.current;
          if (!assistantId) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + payload.content } : m,
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
              m.id === assistantId ? { ...m, toolCalls: [...(m.toolCalls ?? []), call] } : m,
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
                            ...(payload.isError !== undefined ? { isError: payload.isError } : {}),
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
              m.id === assistantId ? { ...m, thinking: (m.thinking ?? "") + payload.content } : m,
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
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
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
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
        );

        // Snapshot the just-completed turn's client ids BEFORE the queue
        // flush. The queued follow-up appends new local user/assistant rows
        // synchronously; without this snapshot the reconcile fetch's tail
        // would be those new rows, and matching by role would mistakenly
        // rewrite their client ids to the just-completed turn's persisted
        // UUIDs.
        const reconcileSnapshot = snapshotTurnForReconcile(messagesRef.current);

        // Clean `done` flushes the queue. Provider errors leave it parked so
        // the user can recover the prompt via the pill.
        const nextQueued = queuedPromptRef.current;
        if (nextQueued !== null) {
          queuedPromptRef.current = null;
          setQueued(null);
          void doSendRef.current?.(nextQueued);
        }

        // Pick up the server's auto-name write and bumped updatedAt, plus
        // reconcile this turn's client-side message ids with the server's
        // persisted UUIDs. Without the reconcile, /api/chat/:cid/messages/:mid/remember
        // returns 404 for the just-finished turn because the server minted
        // its own UUIDs in `handleChatRequest` and never echoed them in the
        // wire frames (chat.ts:chatFrameSchema carries only chunk/error/done).
        const cid = conversationIdRef.current;
        if (cid) {
          void getConversation(cid)
            .then((conv) => {
              if (!conv) return;
              conversationsList.upsertLocal(conv);
              if (reconcileSnapshot) {
                setMessages((prev) => reconcileTurnIds(prev, conv.messages, reconcileSnapshot));
              }
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
              prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
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
          const c = await createConversation(selectedProviderId, {
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(seedForCreate ? { seedSystemPrompt: seedForCreate } : {}),
            ...(nameForCreate ? { name: nameForCreate } : {}),
            ...(activeProjectId ? { projectId: activeProjectId } : {}),
          });
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
      const supportsThinking = selectedModelInfo?.supports?.thinking === true;
      const supportsEffort = selectedModelInfo?.supports?.reasoningEffort === true;

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
      activeProjectId,
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
      // that send, but the model can still call rib tools to refetch.
      autoSendPromptRef.current = null;
      pendingSeedRef.current = null;
      pendingNameRef.current = null;
      return;
    }
    autoSendPromptRef.current = null;
    setInput("");
    void doSend(armed, { hideUserMessage: true });
  }, [conversationId, selectedProviderId, hydrating, streaming, input, doSend]);

  // Switching project on an open conversation starts a fresh chat; the
  // existing conversation row stays in the sidebar but next prompts target
  // the new project's cwd. Abort any active stream first so a slash command
  // that resolves mid-stream can't leave the composer stuck.
  //
  // `expectedConvoId` guards delayed callers (e.g. a `/project <url>` clone
  // that resolves after the user has moved into a different conversation):
  // when present and the live conversation has changed since dispatch, the
  // selection updates silently without clearing the newer chat.
  const switchActiveProject = useCallback(
    (id: string | null, expectedConvoId?: string | null) => {
      const liveConvoId = conversationIdRef.current;
      const inExpectedConvo = expectedConvoId === undefined || expectedConvoId === liveConvoId;
      if (liveConvoId && id !== activeProjectId && inExpectedConvo) {
        abortActiveStreamRef.current?.();
        setMessages([]);
        conversationIdRef.current = null;
        setConversationId(null);
      }
      setActiveProject(id);
    },
    [activeProjectId, setActiveProject, setConversationId],
  );

  const dispatchProjectCommand = useCallback(
    async (rest: string): Promise<{ ok: boolean; message: string }> => {
      // Snapshot the conversation at dispatch time so async resolutions
      // don't clobber a chat the user started while the command was in
      // flight (e.g. a slow `/project <url>` clone).
      const startConvoId = conversationIdRef.current;
      const trimmed = rest.trim();
      const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
      const projects = projectList;

      const ok = (message: string) => ({ ok: true, message });
      const fail = (message: string) => ({ ok: false, message });

      const formatList = (list: Project[]): string => {
        if (list.length === 0) return "No projects yet.";
        const rows = list.map((p) => {
          const marker = p.id === activeProjectId ? "*" : " ";
          return `${marker} ${p.name.padEnd(20)} ${p.rootPath}`;
        });
        return ["Projects:", ...rows].join("\n");
      };

      const slugifyName = (raw: string): string =>
        raw
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^[-_]+|[-_]+$/g, "");

      if (trimmed.length === 0) return ok(formatList(projects));

      // URLs use only `tokens[0]` (with `tokens[1]` reserved for an
      // optional explicit name). Paths consume the entire rest-of-input so
      // an absolute path with spaces survives.
      const isUrl = /^(https?:|git@|ssh:)/.test(trimmed);
      const isPath = trimmed.startsWith("/") || trimmed.startsWith("~");

      if (isUrl) {
        const url = tokens[0]!;
        const explicitName = tokens[1];
        const project = await cloneProject({
          url,
          ...(explicitName ? { name: explicitName } : {}),
        });
        await refreshProjects();
        switchActiveProject(project.id, startConvoId);
        return ok(`Cloned ${project.name} → ${project.rootPath}`);
      }

      if (isPath) {
        const rootPath = trimmed;
        const segs = rootPath.replace(/\/$/, "").split("/");
        const derived = slugifyName(segs[segs.length - 1] ?? "");
        if (!derived) return fail("could not derive a project name from the path");
        const project = await createProject({ name: derived, rootPath });
        await refreshProjects();
        switchActiveProject(project.id, startConvoId);
        return ok(`Registered ${project.name} → ${project.rootPath}`);
      }

      const head = tokens[0]!;
      if (head === "remove" && tokens[1]) {
        const target = projects.find((p) => p.name === tokens[1]);
        if (!target) return fail(`unknown project '${tokens[1]}'`);
        await deleteProject(target.id);
        await refreshProjects();
        if (activeProjectId === target.id) switchActiveProject(null, startConvoId);
        return ok(`Removed ${target.name}`);
      }

      if (head === "use" && tokens[1]) {
        const target = projects.find((p) => p.name === tokens[1]);
        if (!target) return fail(`unknown project '${tokens[1]}'`);
        switchActiveProject(target.id, startConvoId);
        return ok(`Active project: ${target.name}`);
      }

      return fail(
        [
          "Usage:",
          "  /project                          list projects",
          "  /project <url> [name]             clone a repo into the workspace",
          "  /project <absolute-path>          register an existing local path",
          "  /project remove <name>            remove a project",
          "  /project use <name>               set active project",
        ].join("\n"),
      );
    },
    [activeProjectId, projectList, refreshProjects, switchActiveProject],
  );

  const dispatchWorkflowCommand = useCallback(
    async (rest: string): Promise<CommandResult> => {
      const ok = (message: string, extra?: Partial<CommandResult>): CommandResult => ({
        ok: true,
        message,
        ...extra,
      });
      const fail = (message: string): CommandResult => ({ ok: false, message });

      const parsed = parseWorkflowCommand(rest);

      if (parsed.kind === "list") {
        const { workflows } = await listWorkflows();
        if (workflows.length === 0) return ok("No workflows discovered.");
        const rows = workflows.map((w) => {
          const desc = parseWorkflowDescription(w.description);
          const summary = (desc.useWhen ?? desc.body ?? "").split(/\r?\n/)[0]?.trim() ?? "";
          return summary ? `  ${w.name} — ${summary}` : `  ${w.name}`;
        });
        return ok(["Workflows:", ...rows].join("\n"));
      }

      if (parsed.kind === "run") {
        const { name, args } = parsed;
        // The start route requires a project; activeProjectId is null until the
        // project catalog loads (or if its fetch failed). Resolve the default
        // the way useActiveProject does so a fresh/slow load still starts a run.
        let projectId = activeProjectId;
        if (!projectId) {
          try {
            const list = projectList.length > 0 ? projectList : await listProjects();
            projectId = (list.find((p) => p.name === DEFAULT_PROJECT_NAME) ?? list[0])?.id ?? null;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return fail(`Couldn't load projects: ${msg}`);
          }
        }
        if (!projectId) {
          return fail("No project available yet — try again once projects finish loading.");
        }
        try {
          const { runId } = await startWorkflowRun(name, {
            projectId,
            ...(args ? { inputs: { ARGUMENTS: args } } : {}),
          });
          return ok(`Started ${name} — run ${runId}`, { runId, workflowName: name });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return fail(`Couldn't start ${name}: ${msg}`);
        }
      }

      return fail(
        [
          "Usage:",
          "  /workflow                      list workflows",
          "  /workflow run <name> [args]    start a run ($ARGUMENTS)",
        ].join("\n"),
      );
    },
    [activeProjectId, projectList],
  );

  const slashFilteredItems = useMemo(() => filterSlashCommands(input), [input]);
  const slashHelpCommand = useMemo(() => matchSlashCommand(input), [input]);
  const slashMode: "list" | "help" = isCommittedToCommand(input) ? "help" : "list";

  // Open the picker when the user starts a slash command; close it as soon as
  // the input stops starting with `/`. Keeping selectedIndex in range as the
  // filter shrinks the candidate set.
  useEffect(() => {
    if (input.startsWith("/")) {
      setSlashOpen(true);
      setSlashSelectedIndex((idx) =>
        slashFilteredItems.length === 0
          ? 0
          : Math.min(Math.max(idx, 0), slashFilteredItems.length - 1),
      );
    } else {
      setSlashOpen(false);
      setSlashSelectedIndex(0);
    }
  }, [input, slashFilteredItems.length]);

  // Bridge React state to the native popover element. `manual` mode means the
  // browser won't toggle it for us; we explicitly call show/hide here and on
  // Escape from the textarea below.
  useEffect(() => {
    const popoverEl = document.getElementById(SLASH_PICKER_POPOVER_ID);
    if (!popoverEl) return;
    if (slashOpen && !popoverEl.matches(":popover-open")) {
      popoverEl.showPopover();
    } else if (!slashOpen && popoverEl.matches(":popover-open")) {
      popoverEl.hidePopover();
    }
  }, [slashOpen]);

  const onSlashSelect = useCallback((cmd: SlashCommand) => {
    setInput(`/${cmd.name} `);
    setSlashSelectedIndex(0);
  }, []);

  const onSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || hydrating) return;
    const matched = matchSlashCommand(trimmed);
    if (matched) {
      // Refuse while a turn is in flight — `switchActiveProject` clears the
      // active conversation, which would orphan a live WS stream.
      if (streaming) {
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: "system",
            content: "slash commands are disabled while a response is streaming",
          },
        ]);
        return;
      }
      setInput("");
      setSlashOpen(false);
      const rest = trimmed.slice(`/${matched.name}`.length).trim();
      const dispatcher =
        matched.name === "project"
          ? dispatchProjectCommand
          : matched.name === "workflow"
            ? dispatchWorkflowCommand
            : null;
      if (dispatcher) {
        const commandMessageId = newId();
        setMessages((prev) => [
          ...prev,
          {
            id: commandMessageId,
            role: "command",
            content: "",
            commandCall: {
              command: matched.name,
              args: rest,
              family: matched.family,
            },
          },
        ]);
        // The functional setMessages is the staleness guard: if the user
        // switched conversations (messages reset) or the command message was
        // otherwise dropped, the id won't be in `prev` and the map is a
        // no-op. A conversation-id check would over-fire — a command issued
        // before any chat existed (submitConvoId=null) and resolved after
        // `doSend` created one would leave the row stuck running.
        const patchResult = (result: CommandResult) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === commandMessageId && m.commandCall
                ? { ...m, commandCall: { ...m.commandCall, result } }
                : m,
            ),
          );
        };
        void dispatcher(rest)
          .then(patchResult)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            patchResult({ ok: false, message });
          });
      }
      return;
    }
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
  }, [dispatchProjectCommand, dispatchWorkflowCommand, doSend, hydrating, input, streaming]);

  // Cancels auto-send by returning the prompt to the textarea for editing.
  const onCancelQueue = useCallback(() => {
    const pending = queuedPromptRef.current;
    if (pending !== null) setInput(pending);
    queuedPromptRef.current = null;
    setQueued(null);
  }, []);

  const onInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashOpen(false);
          return;
        }
        if (slashMode === "list" && slashFilteredItems.length > 0) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSlashSelectedIndex((idx) => Math.min(idx + 1, slashFilteredItems.length - 1));
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setSlashSelectedIndex((idx) => Math.max(idx - 1, 0));
            return;
          }
          if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
            e.preventDefault();
            const cmd = slashFilteredItems[slashSelectedIndex] ?? slashFilteredItems[0];
            if (cmd) onSlashSelect(cmd);
            return;
          }
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    },
    [onSlashSelect, onSubmit, slashFilteredItems, slashMode, slashOpen, slashSelectedIndex],
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
        prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
      );
    }
    // Interruption drops the queue — auto-firing after Stop would surprise.
    queuedPromptRef.current = null;
    setQueued(null);
  }, []);

  useEffect(() => {
    abortActiveStreamRef.current = abortActiveStream;
  }, [abortActiveStream]);

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
                ...(m.contentParts ? { toolCalls: toolCallsFromContentParts(m.contentParts) } : {}),
                ...(m.truncated ? { truncated: true } : {}),
                ...(hide ? { hidden: true } : {}),
              };
            }),
          );
          // Same project-pin as the hydration path: clears to default when
          // conv.projectId is missing (deleted project / FK NULLed).
          setActiveProject(conv.projectId ?? null);
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
    [abortActiveStream, resetEffortForModel, setActiveProject, setConversationId, toast],
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
    const ref = pickInitialRef(providers, modelsByProvider, settings.lastUsed, settings.favorites);
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
    <div className={`chat-layout${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
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
                  <div className="empty-state">Send a message to start a conversation.</div>
                )}
                {visibleMessages.map((m) => (
                  <div key={m.id} className={`chat-message ${m.role}`}>
                    <span className="chat-role">{ROLE_LABEL[m.role]}</span>
                    <div className={`chat-bubble${m.streaming ? " streaming" : ""}`}>
                      {m.role === "assistant" ? (
                        <>
                          {m.thinking && m.thinking.length > 0 && (
                            <ThinkingBlock content={m.thinking} streaming={m.streaming ?? false} />
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
                      ) : m.role === "command" && m.commandCall ? (
                        <CommandCallBlock
                          commandCall={m.commandCall}
                          onOpenRun={onOpenWorkflowRun}
                        />
                      ) : (
                        m.content
                      )}
                    </div>
                    {/* Save-to-memory only on persisted, non-streaming, non-system
                        messages. The server route looks up the id in
                        ConversationStore; until the done-frame reconcile above
                        swaps the client-side `newId()` for the persisted UUID,
                        the lookup would 404. `isPersistedMessageId` is the gate. */}
                    {m.role !== "system" &&
                      m.role !== "command" &&
                      !m.streaming &&
                      m.content.trim().length > 0 &&
                      conversationId !== null &&
                      isPersistedMessageId(m.id) && (
                        <div className="chat-message-actions">
                          <button
                            type="button"
                            className="chat-message-action"
                            title="Save this message to memory for review"
                            disabled={savingMemory}
                            onClick={() =>
                              setMemoryTarget({
                                id: m.id,
                                role: m.role as "user" | "assistant",
                                content: m.content,
                              })
                            }
                          >
                            ★ Save to memory
                          </button>
                        </div>
                      )}
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
              providerLabel={selectedProvider?.displayName ?? "Loading…"}
              modelId={selectedModel}
              modelDisplayName={selectedModelInfo?.displayName}
              popoverId={MODEL_PICKER_POPOVER_ID}
              disabled={streaming || providers.length === 0}
            />
            <ProjectChip
              projectName={activeProject?.name ?? "default"}
              popoverId={PROJECT_PICKER_POPOVER_ID}
              disabled={streaming}
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
              <ToolsChip count={tools.length} popoverId={TOOLS_POPOVER_ID} disabled={streaming} />
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
                disabled={hydrating || !selectedProviderId || input.trim().length === 0}
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

        <ProjectPickerPopover
          popoverId={PROJECT_PICKER_POPOVER_ID}
          projects={projectList}
          activeProjectId={activeProjectId}
          onSelect={switchActiveProject}
          onProjectUpdated={() => {
            void refreshProjects();
          }}
          onProjectDeleted={(deletedId) => {
            void refreshProjects();
            if (activeProjectId === deletedId) switchActiveProject(null);
          }}
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

        <SlashCommandPopover
          popoverId={SLASH_PICKER_POPOVER_ID}
          mode={slashMode}
          items={slashFilteredItems}
          selectedIndex={slashSelectedIndex}
          helpCommand={slashHelpCommand}
          onSelect={onSlashSelect}
        />
      </div>

      {memoryTarget !== null && conversationId !== null && (
        <SaveToMemoryModal
          open={true}
          conversationId={conversationId}
          messageId={memoryTarget.id}
          role={memoryTarget.role}
          initialContent={memoryTarget.content}
          submitting={savingMemory}
          onClose={() => setMemoryTarget(null)}
          onSubmit={async (draft) => {
            setSavingMemory(true);
            try {
              const verdict = await rememberChatMessage(conversationId, memoryTarget.id, draft);
              if (verdict.status === "ok") {
                toast.push({
                  kind: "ok",
                  message: "Saved to memory — review it in the Memory tab.",
                });
                setMemoryTarget(null);
              } else if (verdict.status === "deduped") {
                toast.push({
                  kind: "info",
                  message: "Already saved.",
                });
                setMemoryTarget(null);
              } else {
                toast.push({
                  kind: "error",
                  message: `Blocked: ${verdict.reason}. Try editing the content.`,
                });
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              toast.push({ kind: "error", message: `Save failed: ${msg}` });
            } finally {
              setSavingMemory(false);
            }
          }}
        />
      )}
    </div>
  );
}
