// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  CombinedAutocompleteProvider,
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  type SlashCommand,
  Spacer,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import type { ReasoningEffortLevel } from "@keelson/shared";
import { EXIT_FAIL, EXIT_NO_SERVER, EXIT_OK } from "../exit.ts";
import {
  chatViaServer,
  createConversation,
  getConversation,
  listProviders,
  pickDefaultHttpProvider,
} from "../http/chat-client.ts";
import { createProject, listProjects } from "../http/projects-client.ts";
import { isServerDownError } from "../http/workflow-client.ts";
import { emit } from "../output.ts";
import { detectGitRoot, type ProjectBinding, resolveProjectBinding } from "./project.ts";
import { brass, dim, editorTheme, navy, red } from "./theme.ts";
import { AssistantTurnView, userLine } from "./transcript.ts";

export interface InteractiveChatOptions {
  baseUrl: string;
  provider?: string;
  model?: string;
  conversationId?: string;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffortLevel;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "new", description: "start a new conversation" },
  { name: "exit", description: "leave interactive chat" },
];

interface SessionSetup {
  providerId: string;
  model?: string;
  conversationId?: string;
  binding: ProjectBinding;
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
  if (model === undefined) {
    const def = providers.find((p) => p.id === providerId)?.capabilities.defaultModel;
    if (def && def.length > 0) model = def;
  }
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
  return {
    providerId,
    ...(model !== undefined ? { model } : {}),
    ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
    binding,
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
  let conversationId = setup.conversationId;
  let busy = false;
  let currentAbort: AbortController | null = null;
  const queue: string[] = [];

  const exit = (code: number): never => {
    tui.stop();
    process.exit(code);
  };

  const modelSuffix = setup.model !== undefined ? ` · ${setup.model}` : "";
  tui.addChild(
    new Text(
      `${brass("keelson chat")} ${dim(`· ${setup.providerId}${modelSuffix} · project ${setup.binding.name}`)}`,
      1,
      0,
    ),
  );
  if (setup.binding.note !== undefined) {
    tui.addChild(new Text(dim(setup.binding.note), 1, 0));
  }
  tui.addChild(new Spacer(1));

  const editor = new Editor(tui, editorTheme);
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd()));

  let loader: Loader | null = null;
  const dropLoader = (): void => {
    if (loader !== null) {
      loader.stop();
      tui.removeChild(loader);
      loader = null;
    }
  };

  const pump = (): void => {
    if (busy) return;
    const message = queue.shift();
    if (message === undefined) return;
    busy = true;
    void (async () => {
      try {
        if (conversationId === undefined) {
          const conv = await createConversation(opts.baseUrl, {
            providerId: setup.providerId,
            ...(setup.model !== undefined ? { model: setup.model } : {}),
            ...(setup.binding.projectId !== undefined
              ? { projectId: setup.binding.projectId }
              : {}),
          });
          conversationId = conv.id;
        }
        tui.addChild(userLine(message));
        loader = new Loader(tui, navy, dim, "thinking");
        tui.addChild(loader);
        const view = new AssistantTurnView(tui, {
          ...(opts.thinking !== undefined ? { showThinking: opts.thinking } : {}),
        });
        const abort = new AbortController();
        currentAbort = abort;
        const result = await chatViaServer({
          baseUrl: opts.baseUrl,
          conversationId,
          providerId: setup.providerId,
          message,
          ...(setup.model !== undefined ? { model: setup.model } : {}),
          ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
          ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
          onChunk: (chunk) => {
            dropLoader();
            view.handleChunk(chunk);
          },
          signal: abort.signal,
        });
        dropLoader();
        if (abort.signal.aborted) {
          tui.addChild(new Text(dim("✗ interrupted"), 1, 0));
        } else if (result.errored) {
          view.fail(result.errorMessage ?? "chat stream errored");
        }
      } catch (err) {
        dropLoader();
        const message = err instanceof Error ? err.message : String(err);
        tui.addChild(new Text(red(`✗ ${message}`), 1, 0));
      } finally {
        currentAbort = null;
        busy = false;
        tui.requestRender();
        pump();
      }
    })();
  };

  editor.onSubmit = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0) return;
    if (text === "/exit") exit(EXIT_OK);
    if (text === "/new") {
      conversationId = undefined;
      tui.addChild(new Text(dim("── new conversation ──"), 1, 0));
      tui.requestRender();
      return;
    }
    queue.push(text);
    pump();
  };

  tui.addChild(editor);
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
