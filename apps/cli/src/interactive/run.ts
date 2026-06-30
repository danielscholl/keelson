// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  type SlashCommand,
  Spacer,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import type {
  CommandCompletion,
  CommandRef,
  Project,
  ReasoningEffortLevel,
  TokenUsage,
  WorkflowFrame,
} from "@keelson/shared";
import pkg from "../../package.json" with { type: "json" };
import { EXIT_FAIL, EXIT_NO_SERVER, EXIT_OK } from "../exit.ts";
import {
  chatViaServer,
  createConversation,
  getConversation,
  listConversations,
  listProviderModels,
  listProviders,
  type ProviderInfoRow,
  pickDefaultHttpProvider,
  resolveAgent,
} from "../http/chat-client.ts";
import { completeRibCommand, invokeRibCommand, listRibCommands } from "../http/commands-client.ts";
import { createProject, listProjects } from "../http/projects-client.ts";
import { listRibs } from "../http/ribs-client.ts";
import {
  attachRun,
  isServerDownError,
  listWorkflows,
  startRun,
  type WorkflowSummary,
} from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { StatusFooter } from "./footer.ts";
import {
  firstClause,
  formatUsageMeter,
  parseRunArg,
  parseSlashCommand,
  relativeAge,
} from "./format.ts";
import { createModelLoader, toModelCompletions } from "./models.ts";
import {
  detectGitBranch,
  detectGitRoot,
  type ProjectBinding,
  resolveProjectBinding,
} from "./project.ts";
import { brass, dim, editorTheme, navy, red } from "./theme.ts";
import { AssistantTurnView, userLine } from "./transcript.ts";
import { buildWelcomeLines, type WelcomeData } from "./welcome.ts";

export interface InteractiveChatOptions {
  baseUrl: string;
  provider?: string;
  model?: string;
  conversationId?: string;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffortLevel;
}

interface SessionSetup {
  providers: ProviderInfoRow[];
  providerId: string;
  model?: string;
  conversationId?: string;
  binding: ProjectBinding;
  welcome: WelcomeData;
  ribCommands: CommandRef[];
}

function defaultModelFor(providers: readonly ProviderInfoRow[], id: string): string | undefined {
  const def = providers.find((p) => p.id === id)?.capabilities.defaultModel;
  return def && def.length > 0 ? def : undefined;
}

async function prepareSession(opts: InteractiveChatOptions): Promise<SessionSetup> {
  const providers = await listProviders(opts.baseUrl);
  let providerId: string;
  let model = opts.model;
  if (opts.conversationId) {
    const conv = await getConversation(opts.baseUrl, opts.conversationId);
    providerId = conv.providerId;
    model = model ?? conv.model;
  } else {
    providerId = opts.provider ?? pickDefaultHttpProvider(providers);
  }
  model = model ?? defaultModelFor(providers, providerId);
  // A resumed conversation keeps its server-side project binding; only fresh
  // sessions resolve one from cwd.
  const binding: ProjectBinding = opts.conversationId
    ? { name: "(conversation)", autoRegistered: false }
    : await resolveProjectBinding({
        cwd: process.cwd(),
        detectGitRoot,
        listProjects: () => listProjects(opts.baseUrl),
        createProject: (input) => createProject(opts.baseUrl, input),
      });

  // Welcome-card data is decorative; a failing endpoint degrades to an empty
  // section rather than blocking the session.
  const [ribsRes, convsRes, commandsRes] = await Promise.allSettled([
    listRibs(opts.baseUrl),
    listConversations(opts.baseUrl),
    listRibCommands(opts.baseUrl),
  ]);
  const ribs = ribsRes.status === "fulfilled" ? ribsRes.value : [];
  const conversations = convsRes.status === "fulfilled" ? convsRes.value : [];
  const ribCommands = commandsRes.status === "fulfilled" ? commandsRes.value : [];
  const recent = conversations
    .filter((c) => c.updatedAt !== undefined)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 3)
    .map((c) => ({
      name: c.name && c.name.length > 0 ? c.name : c.id.slice(0, 8),
      ago: relativeAge(c.updatedAt ?? ""),
    }));

  const welcome: WelcomeData = {
    version: pkg.version,
    providerId,
    ...(model !== undefined ? { model } : {}),
    projectName: binding.name,
    ...(binding.note !== undefined ? { projectNote: binding.note } : {}),
    branch: detectGitBranch(process.cwd()),
    ribs: ribs.map((r) => ({ displayName: r.displayName, tools: r.registered.length })),
    recent,
  };

  return {
    providers,
    providerId,
    ...(model !== undefined ? { model } : {}),
    ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
    binding,
    welcome,
    ribCommands,
  };
}

export async function runInteractiveChat(opts: InteractiveChatOptions): Promise<never> {
  let setup: SessionSetup;
  try {
    setup = await prepareSession(opts);
  } catch (err) {
    if (isServerDownError(err)) {
      emit(
        { error: `server at ${opts.baseUrl} is not reachable`, code: "NO_SERVER" },
        { json: false },
      );
      process.exit(EXIT_NO_SERVER);
    }
    const message = err instanceof Error ? err.message : String(err);
    emit({ error: message, code: "CHAT_FAILED" }, { json: false });
    process.exit(EXIT_FAIL);
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const session = {
    providerId: setup.providerId,
    model: setup.model,
    conversationId: setup.conversationId,
    binding: setup.binding,
    // One-shot seed for the next conversation the pump creates (the `/mind` path),
    // cleared once applied so later turns in the same chat don't re-seed.
    seedSystemPrompt: undefined as string | undefined,
    conversationName: undefined as string | undefined,
  };
  let busy = false;
  let activeRuns = 0;
  let currentAbort: AbortController | null = null;
  const queue: string[] = [];
  const usageTotals = { input: 0, output: 0 };
  let latestUsage: TokenUsage | undefined;

  const exit = (code: number): never => {
    tui.stop();
    process.exit(code);
  };

  for (const line of buildWelcomeLines(setup.welcome)) {
    tui.addChild(new Text(line, 1, 0));
  }

  // Turn output appends into this container so it stays above the editor.
  const transcript = new Container();
  tui.addChild(transcript);
  tui.addChild(new Spacer(1));

  const surface = {
    addChild(component: Component) {
      transcript.addChild(component);
    },
    requestRender() {
      tui.requestRender();
    },
  };
  const info = (line: string): void => {
    surface.addChild(new Text(dim(line), 1, 0));
    tui.requestRender();
  };
  const warn = (line: string): void => {
    surface.addChild(new Text(red(line), 1, 0));
    tui.requestRender();
  };

  const footer = new StatusFooter({
    providerId: session.providerId,
    ...(session.model !== undefined ? { model: session.model } : {}),
    projectName: session.binding.name,
    branch: setup.welcome.branch,
    meter: formatUsageMeter(undefined, usageTotals),
    activity: "idle",
  });
  const refreshActivity = (): void => {
    footer.set({ activity: busy ? "working" : activeRuns > 0 ? "workflow" : "idle" });
    tui.requestRender();
  };

  const resetConversation = (reason: string): void => {
    session.conversationId = undefined;
    info(`── ${reason} ──`);
  };

  // Lazy caches behind the slash-argument completions.
  let projectsCache: Project[] | null = null;
  const loadProjectsCached = async (): Promise<Project[]> => {
    projectsCache ??= await listProjects(opts.baseUrl);
    return projectsCache;
  };
  let workflowsCache: WorkflowSummary[] | null = null;
  const loadWorkflowsCached = async (): Promise<WorkflowSummary[]> => {
    workflowsCache ??= (await listWorkflows(opts.baseUrl)).workflows;
    return workflowsCache;
  };
  // Per-command completion cache: fetch the full list once (empty prefix) and
  // filter locally, like the project/workflow caches above and the SPA — avoids
  // a server round-trip (and the rib's disk reads) on every keystroke. Relies on
  // the completeCommand contract that an empty prefix returns the full candidate
  // set (packages/shared/src/rib.ts); the local filter then narrows by prefix.
  const ribCompletionsCache = new Map<string, CommandCompletion[]>();
  const loadRibCompletionsCached = async (cmd: CommandRef): Promise<CommandCompletion[]> => {
    let all = ribCompletionsCache.get(cmd.name);
    if (all === undefined) {
      all = await completeRibCommand(opts.baseUrl, cmd.ribId, cmd.name, "");
      ribCompletionsCache.set(cmd.name, all);
    }
    return all;
  };
  const chatProviders = setup.providers.filter((p) => p.id !== "workflow");

  // Live per-provider model lists for the `/model` picker, coalesced and cached
  // for the session. Falls back to the static capabilities list the server
  // already carries when the live probe can't run.
  const loadModels = createModelLoader({
    fetch: (id) => listProviderModels(opts.baseUrl, id),
    fallback: (id) => setup.providers.find((p) => p.id === id)?.capabilities.models ?? [],
  });
  // Warm the current provider in the background so the first `/model` is instant;
  // startup never blocks on the probe (Copilot spawns its CLI, ~1s).
  void loadModels(session.providerId);

  // Start a workflow run and stream its node frames into the transcript. Shared by
  // the `/run` command and a rib command's `run-workflow` effect.
  const launchRun = async (name: string, inputs: Record<string, string>): Promise<void> => {
    let runId: string;
    try {
      const body = {
        inputs,
        ...(session.binding.projectId !== undefined
          ? { projectId: session.binding.projectId }
          : { workingDir: process.cwd() }),
      };
      ({ runId } = await startRun(opts.baseUrl, name, body));
    } catch (err) {
      warn(`✗ ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    surface.addChild(new Text(`${brass("▶")} ${name} ${dim(`run ${runId}`)}`, 1, 0));
    activeRuns += 1;
    refreshActivity();
    const onFrame = (frame: WorkflowFrame): void => {
      switch (frame.type) {
        case "node_started":
          info(`  ▸ ${frame.nodeId}`);
          break;
        case "node_done":
          if (frame.error !== null) warn(`  ✗ ${frame.nodeId}: ${frame.error}`);
          else info(`  ✓ ${frame.nodeId}`);
          break;
        case "run_warning":
          warn(`  ⚠ ${frame.message}`);
          break;
        case "approval_awaiting":
          surface.addChild(
            new Text(
              `${brass("⏸")} ${frame.nodeId} awaits approval — respond in the SPA or \`keelson workflow respond\``,
              1,
              0,
            ),
          );
          break;
        case "run_done":
          surface.addChild(
            new Text(
              frame.status === "succeeded"
                ? `${brass("▶")} ${name} ${dim("succeeded")}`
                : red(`▶ ${name} ${frame.status}`),
              1,
              0,
            ),
          );
          break;
        default:
          break;
      }
      tui.requestRender();
    };
    void attachRun({ baseUrl: opts.baseUrl, runId, onFrame })
      .catch((err) => {
        warn(`✗ run stream: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        activeRuns -= 1;
        refreshActivity();
      });
  };

  const runWorkflowCommand = async (arg: string): Promise<void> => {
    const parsed = parseRunArg(arg);
    if (parsed === null) {
      warn("usage: /run <workflow> [key=value …]");
      return;
    }
    await launchRun(parsed.name, parsed.inputs);
  };

  const slashHandlers: { command: SlashCommand; run: (arg: string) => void | Promise<void> }[] = [
    {
      command: { name: "new", description: "start a new conversation" },
      run: () => resetConversation("new conversation"),
    },
    {
      command: {
        name: "provider",
        description: "switch provider (starts a new conversation)",
        argumentHint: "<id>",
        getArgumentCompletions: (prefix) =>
          chatProviders
            .filter((p) => p.id.startsWith(prefix))
            .map((p) => ({ value: p.id, label: p.id, description: p.displayName })),
      },
      run: (arg) => {
        if (arg.length === 0) {
          info(
            `provider: ${session.providerId} (available: ${chatProviders.map((p) => p.id).join(", ")})`,
          );
          return;
        }
        if (!chatProviders.some((p) => p.id === arg)) {
          warn(
            `unknown provider '${arg}'; available: ${chatProviders.map((p) => p.id).join(", ")}`,
          );
          return;
        }
        session.providerId = arg;
        session.model = defaultModelFor(setup.providers, arg);
        void loadModels(arg);
        footer.set({
          providerId: arg,
          ...(session.model !== undefined ? { model: session.model } : { model: undefined }),
        });
        resetConversation(`provider ${arg}`);
      },
    },
    {
      command: {
        name: "model",
        description: "switch model for the next turn",
        argumentHint: "<id>",
        getArgumentCompletions: async (prefix) =>
          toModelCompletions(
            await loadModels(session.providerId),
            prefix,
            defaultModelFor(setup.providers, session.providerId),
          ),
      },
      run: (arg) => {
        if (arg.length === 0) {
          info(`model: ${session.model ?? "(provider default)"}`);
          return;
        }
        session.model = arg;
        footer.set({ model: arg });
        info(`model → ${arg}`);
      },
    },
    {
      command: {
        name: "project",
        description: "rebind the session's project (starts a new conversation)",
        argumentHint: "<name>",
        getArgumentCompletions: async (prefix) =>
          (await loadProjectsCached())
            .filter((p) => p.name.startsWith(prefix))
            .map((p) => ({ value: p.name, label: p.name, description: p.rootPath })),
      },
      run: async (arg) => {
        if (arg.length === 0) {
          info(
            `project: ${session.binding.name}${session.binding.rootPath !== undefined ? ` (${session.binding.rootPath})` : ""}`,
          );
          return;
        }
        const match = (await loadProjectsCached()).find((p) => p.name === arg);
        if (match === undefined) {
          warn(`no project named '${arg}' (see \`keelson project list\`)`);
          return;
        }
        session.binding = {
          projectId: match.id,
          name: match.name,
          rootPath: match.rootPath,
          autoRegistered: false,
        };
        footer.set({ projectName: match.name });
        resetConversation(`project ${match.name}`);
      },
    },
    {
      command: { name: "workflows", description: "list runnable workflows" },
      run: async () => {
        const workflows = await loadWorkflowsCached();
        if (workflows.length === 0) {
          info("no workflows in the catalog");
          return;
        }
        for (const wf of workflows) {
          surface.addChild(
            new Text(`${brass("·")} ${wf.name} ${dim(`— ${firstClause(wf.description)}`)}`, 1, 0),
          );
        }
        tui.requestRender();
      },
    },
    {
      command: {
        name: "run",
        description: "run a workflow",
        argumentHint: "<workflow> [key=value …]",
        getArgumentCompletions: async (prefix) =>
          (await loadWorkflowsCached())
            .filter((w) => w.name.startsWith(prefix))
            .map((w) => ({
              value: w.name,
              label: w.name,
              description: firstClause(w.description),
            })),
      },
      run: runWorkflowCommand,
    },
    {
      command: { name: "exit", description: "leave interactive chat" },
      run: () => exit(EXIT_OK),
    },
  ];

  // Rib-contributed commands (GET /api/commands) merge into the same slash menu as
  // the base commands above. The harness performs the closed effect a command's
  // invoke returns — open one of the rib's agents, run a workflow, or print a
  // message — so the surface carries no per-rib command logic.
  const performRibCommand = async (cmd: CommandRef, arg: string): Promise<void> => {
    let result: Awaited<ReturnType<typeof invokeRibCommand>>;
    try {
      result = await invokeRibCommand(opts.baseUrl, cmd.ribId, cmd.name, arg);
    } catch (e) {
      warn(`✗ ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!result.ok) {
      warn(result.error);
      return;
    }
    const effect = result.effect;
    if (effect.effect === "message") {
      for (const line of effect.text.split("\n")) surface.addChild(new Text(line, 1, 0));
      tui.requestRender();
      return;
    }
    if (effect.effect === "run-workflow") {
      await launchRun(effect.workflow, effect.args ? { ARGUMENTS: effect.args } : {});
      return;
    }
    // open-agent enters a fresh seeded chat, which resets the conversation — gate
    // it while a turn is streaming. The invoke above is a side-effect-free resolver
    // (rib contract), so running it before this check mutates nothing; only this
    // conversation-resetting action is busy-incompatible — a message or run-workflow
    // effect, like base /run, is fine mid-turn.
    if (busy) {
      warn("finish the current turn before entering an agent");
      return;
    }
    try {
      const seed = await resolveAgent(opts.baseUrl, effect.ribId, effect.slug);
      // A turn can start during the await above; re-check before resetting so we
      // never reset/seed the conversation mid-stream.
      if (busy) {
        warn("finish the current turn before entering an agent");
        return;
      }
      session.seedSystemPrompt = seed.systemPrompt;
      session.conversationName = seed.name;
      // Apply the agent's model reference coherently: pin its provider when it
      // names one, then its model — or reset to the (resulting) provider's
      // default when the agent pins no model, so a prior agent's model can't leak
      // into this conversation.
      if (seed.providerId !== undefined && seed.providerId !== session.providerId) {
        session.providerId = seed.providerId;
      }
      session.model = seed.model ?? defaultModelFor(setup.providers, session.providerId);
      footer.set({
        providerId: session.providerId,
        ...(session.model !== undefined ? { model: session.model } : { model: undefined }),
      });
      resetConversation(`entering ${seed.name}`);
      queue.push(seed.openingPrompt ?? "Introduce yourself briefly, in character.");
      pump();
    } catch (e) {
      warn(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  for (const cmd of setup.ribCommands) {
    // Base commands are authoritative — skip a rib command that collides with one.
    if (slashHandlers.some((h) => h.command.name === cmd.name)) continue;
    const command: SlashCommand = {
      name: cmd.name,
      description: cmd.description,
      ...(cmd.argument ? { argumentHint: cmd.argument.hint } : {}),
      ...(cmd.argument?.completes
        ? {
            getArgumentCompletions: async (prefix: string) => {
              try {
                return (await loadRibCompletionsCached(cmd))
                  .filter((c) => c.value.startsWith(prefix))
                  .map((c) => ({
                    value: c.value,
                    label: c.value,
                    ...(c.description !== undefined ? { description: c.description } : {}),
                  }));
              } catch {
                return [];
              }
            },
          }
        : {}),
    };
    slashHandlers.push({ command, run: (arg) => performRibCommand(cmd, arg) });
  }
  const handlerByName = new Map(slashHandlers.map((h) => [h.command.name, h]));

  const editor = new Editor(tui, editorTheme);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      slashHandlers.map((h) => h.command),
      process.cwd(),
    ),
  );

  let loader: Loader | null = null;
  const dropLoader = (): void => {
    if (loader !== null) {
      loader.stop();
      transcript.removeChild(loader);
      loader = null;
    }
  };

  const pump = (): void => {
    if (busy) return;
    const message = queue.shift();
    if (message === undefined) return;
    busy = true;
    refreshActivity();
    void (async () => {
      try {
        if (session.conversationId === undefined) {
          const conv = await createConversation(opts.baseUrl, {
            providerId: session.providerId,
            ...(session.model !== undefined ? { model: session.model } : {}),
            ...(session.binding.projectId !== undefined
              ? { projectId: session.binding.projectId }
              : {}),
            ...(session.seedSystemPrompt !== undefined
              ? { seedSystemPrompt: session.seedSystemPrompt }
              : {}),
            ...(session.conversationName !== undefined ? { name: session.conversationName } : {}),
          });
          session.conversationId = conv.id;
          // One-shot: the seed belongs to this conversation only.
          session.seedSystemPrompt = undefined;
          session.conversationName = undefined;
        }
        surface.addChild(userLine(message));
        loader = new Loader(tui, navy, dim, "thinking");
        transcript.addChild(loader);
        const view = new AssistantTurnView(surface, {
          ...(opts.thinking !== undefined ? { showThinking: opts.thinking } : {}),
        });
        const abort = new AbortController();
        currentAbort = abort;
        const result = await chatViaServer({
          baseUrl: opts.baseUrl,
          conversationId: session.conversationId,
          providerId: session.providerId,
          message,
          ...(session.model !== undefined ? { model: session.model } : {}),
          ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
          ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
          onChunk: (chunk) => {
            dropLoader();
            if (chunk.type === "usage") {
              latestUsage = chunk.usage;
              usageTotals.input += chunk.usage.inputTokens;
              usageTotals.output += chunk.usage.outputTokens;
              footer.set({ meter: formatUsageMeter(latestUsage, usageTotals) });
            }
            // Display-only: the session keeps requesting the provider default;
            // pinning session.model here would freeze a provider-side pick.
            if (chunk.type === "model") {
              footer.set({ model: chunk.model });
            }
            view.handleChunk(chunk);
          },
          signal: abort.signal,
        });
        dropLoader();
        if (abort.signal.aborted) {
          info("✗ interrupted");
        } else if (result.errored) {
          view.fail(result.errorMessage ?? "chat stream errored");
        }
      } catch (err) {
        dropLoader();
        warn(`✗ ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        currentAbort = null;
        busy = false;
        refreshActivity();
        pump();
      }
    })();
  };

  editor.onSubmit = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0) return;
    if (text.startsWith("/")) {
      const parsed = parseSlashCommand(text);
      const handler = parsed === null ? undefined : handlerByName.get(parsed.name);
      if (parsed === null || handler === undefined) {
        warn(`unknown command '${text}' (type / to see commands)`);
        return;
      }
      // Async handlers hit the server; surface a rejection instead of
      // letting the command silently no-op.
      void Promise.resolve(handler.run(parsed.arg)).catch((err) => {
        warn(`✗ ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }
    queue.push(text);
    pump();
  };

  tui.addChild(editor);
  tui.addChild(footer);
  tui.setFocus(editor);
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) exit(EXIT_OK);
    if (matchesKey(data, "escape") && currentAbort !== null) {
      currentAbort.abort();
    }
  });

  tui.start();
  // The TUI owns the process from here; exits flow through exit() above.
  return new Promise<never>(() => {});
}
