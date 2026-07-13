// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  type ReasoningEffortLevel,
  reasoningEffortLevelSchema,
  SCHEMA_VERSION,
} from "@keelson/shared";
import { keelsonPaths } from "@keelson/shared/paths";
import { installForgeOnPath, seedStarterAssets } from "@keelson/workflows";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { runApprovalList, runApprovalResolve } from "./commands/approval.ts";
import { runChatEntry } from "./commands/chat.ts";
import { runConnect, runConnectStatus, runDisconnect } from "./commands/connect.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runGatewayAdd, runGatewayList, runGatewayRemove } from "./commands/gateway.ts";
import { runMcpBridge } from "./commands/mcp.ts";
import { runProjectAdd, runProjectList, runProjectRemove } from "./commands/project.ts";
import { runRibAdd, runRibList, runRibRemove, runRibShow } from "./commands/rib.ts";
import {
  runServe,
  runServeRestart,
  runServeStart,
  runServeStatus,
  runServeStop,
} from "./commands/serve.ts";
import { runUpdate } from "./commands/update.ts";
import { runWorkflowList } from "./commands/workflow-list.ts";
import { runWorkflowRespond } from "./commands/workflow-respond.ts";
import { runWorkflowResume } from "./commands/workflow-resume.ts";
import { runWorkflowRun } from "./commands/workflow-run.ts";
import { runWorkflowStatus } from "./commands/workflow-status.ts";
import { runWorkflowValidate } from "./commands/workflow-validate.ts";
import { runWorkspaceList } from "./commands/workspace.ts";
import { runWorktreePrune } from "./commands/worktree.ts";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_OK } from "./exit.ts";
import { listedRibs } from "./home.ts";
import { emit } from "./output.ts";

interface GlobalOptions {
  json: boolean;
}

function globalOpts(cmd: Command): GlobalOptions {
  return cmd.optsWithGlobals() as GlobalOptions;
}

// Reject an option that was supplied but resolved to an empty/whitespace
// string (e.g. `--provider "$PROVIDER"` with `PROVIDER` unset). Returns
// `undefined` when the option wasn't supplied at all, the trimmed value
// otherwise. Empty strings exit BAD_ARGS — silently dropping them would
// route the call to the default provider / fresh conversation, a silent
// mis-target.
function requireNonEmpty(
  json: boolean,
  name: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    emit({ error: `${name} must not be empty`, code: "BAD_INPUTS" }, { json });
    process.exit(EXIT_BAD_ARGS);
  }
  return trimmed;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("keelson")
    .description("Operator CLI for the Keelson agent harness")
    .version(pkg.version, "-v, --version", "print version and exit")
    .option("--json", "emit machine-readable JSON envelope to stdout", false)
    .option(
      "-p, --prompt <message>",
      "one-shot chat turn; alias for `chat [message]` (same options apply; no message on a TTY opens interactive chat)",
    )
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true });

  // `-p` before a subcommand is rewritten to `chat` pre-parse (see
  // rewritePromptAlias); one that survives to an action was placed after a
  // subcommand, where silently dropping the operator's message is a mis-target.
  program.hook("preAction", function promptGuard(thisCommand: Command) {
    const { prompt, json } = thisCommand.opts<{ prompt?: string; json: boolean }>();
    if (prompt !== undefined) {
      emit(
        {
          error: "-p/--prompt is an alias for `keelson chat` and must come before any subcommand",
          code: "BAD_INPUTS",
        },
        { json },
      );
      process.exit(EXIT_BAD_ARGS);
    }
  });

  program
    .command("version")
    .description(
      "print CLI version, Bun runtime version, contract schema version, and installed rib versions",
    )
    .action(function versionAction(this: Command) {
      const { json } = globalOpts(this);
      emit(
        {
          data: {
            name: pkg.name,
            version: pkg.version,
            bunVersion: Bun.version,
            schemaVersion: SCHEMA_VERSION,
            ribs: listedRibs(),
          },
        },
        { json },
      );
    });

  program
    .command("start")
    .description("start the Keelson server in the background and report its URL")
    .option("-f, --foreground", "run attached in the foreground instead of detaching", false)
    .option("--db <path>", "override KEELSON_DB for this run")
    .action(async function startAction(this: Command) {
      const { json } = globalOpts(this);
      const { foreground, db } = this.opts<{ foreground: boolean; db?: string }>();
      if (foreground) await runServe({ db, json });
      else await runServeStart({ db, json });
    });

  program
    .command("stop")
    .description("stop the background server (graceful shutdown, kill fallback)")
    .action(async function stopAction(this: Command) {
      const { json } = globalOpts(this);
      await runServeStop({ json });
    });

  program
    .command("restart")
    .description("stop the background server (if running) and start it again")
    .option("--db <path>", "override KEELSON_DB for this run")
    .action(async function restartAction(this: Command) {
      const { json } = globalOpts(this);
      const { db } = this.opts<{ db?: string }>();
      await runServeRestart({ db, json });
    });

  program
    .command("status")
    .description("report whether the server is running and its URL (exit 0 up, 3 down)")
    .action(async function statusAction(this: Command) {
      const { json } = globalOpts(this);
      await runServeStatus({ json });
    });

  // Deprecated `service`/`serve` group, hidden from help and kept one release
  // so existing scripts and muscle memory keep working. Bare `service` ran the
  // server in the foreground — now `start --foreground`.
  const service = program
    .command("service", { hidden: true })
    .alias("serve")
    .description("deprecated: use `keelson start` (foreground: `keelson start --foreground`)")
    .option("--db <path>", "override KEELSON_DB for this run")
    .action(async function serviceAction(this: Command) {
      const { json } = globalOpts(this);
      const { db } = this.opts<{ db?: string }>();
      await runServe({ db, json });
    });

  service
    .command("start")
    .description("deprecated: use `keelson start`")
    .option("--db <path>", "override KEELSON_DB for the background server")
    .action(async function serviceStartAction(this: Command) {
      const { json } = globalOpts(this);
      const { db } = this.opts<{ db?: string }>();
      await runServeStart({ db, json });
    });

  service
    .command("stop")
    .description("deprecated: use `keelson stop`")
    .action(async function serviceStopAction(this: Command) {
      const { json } = globalOpts(this);
      await runServeStop({ json });
    });

  service
    .command("status")
    .description("deprecated: use `keelson status`")
    .action(async function serviceStatusAction(this: Command) {
      const { json } = globalOpts(this);
      await runServeStatus({ json });
    });

  program
    .command("mcp")
    .description("bridge a stdio MCP client to the running server's HTTP MCP endpoint")
    .option("--base-url <url>", "server base URL (default: http://127.0.0.1:7878)")
    .action(async function mcpAction(this: Command, mcpOpts: { baseUrl?: string }) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", mcpOpts.baseUrl);
      await runMcpBridge({ ...(baseUrl ? { baseUrl } : {}) });
    });

  program
    .command("connect [targets...]")
    .description(
      "wire an external agent (claude, copilot, codex, or 'all') to keelson's MCP endpoint and drop a portable skill",
    )
    .option("--url <url>", "MCP endpoint URL to write (default: http://127.0.0.1:7878/api/mcp)")
    .option("--no-skill", "wire the MCP connection only; skip the SKILL.md drop")
    .option(
      "--local",
      "write repo-scoped config/skill into the current directory instead of your machine-global agent config",
    )
    .option("--undo", "reverse a previous connect for the named agents")
    .option("--list", "show current connections instead of connecting")
    .action(function connectAction(
      this: Command,
      targets: string[],
      connectOpts: {
        url?: string;
        skill: boolean;
        local?: boolean;
        undo?: boolean;
        list?: boolean;
      },
    ) {
      const { json } = globalOpts(this);
      if (connectOpts.list) {
        runConnectStatus({ json });
        return;
      }
      if (connectOpts.undo) {
        runDisconnect(targets, { json });
        return;
      }
      const url = requireNonEmpty(json, "--url", connectOpts.url);
      runConnect(targets, {
        json,
        skill: connectOpts.skill,
        ...(connectOpts.local ? { local: true } : {}),
        ...(url ? { url } : {}),
      });
    });

  program
    .command("disconnect [targets...]")
    .description(
      "reverse `keelson connect` for the named agents (claude, copilot, codex, or 'all')",
    )
    .action(function disconnectAction(this: Command, targets: string[]) {
      const { json } = globalOpts(this);
      runDisconnect(targets, { json });
    });

  const workflow = program
    .command("workflow")
    .description("workflow operations (list, validate, run, status)");

  workflow
    .command("list")
    .description("list workflows from the server catalog or local discovery")
    .option("--dir <path>", "workflows directory to read (default: the keelson home catalog)")
    .action(async function listAction(this: Command, listOpts: { dir?: string }) {
      const { json } = globalOpts(this);
      const dir = requireNonEmpty(json, "--dir", listOpts.dir);
      await runWorkflowList({ json, ...(dir ? { dir } : {}) });
    });

  workflow
    .command("validate [name]")
    .description("validate one or all workflow YAML files")
    .option("--dir <path>", "workflows directory to read (default: the keelson home catalog)")
    .action(async function validateAction(
      this: Command,
      name: string | undefined,
      validateOpts: { dir?: string },
    ) {
      const { json } = globalOpts(this);
      const dir = requireNonEmpty(json, "--dir", validateOpts.dir);
      await runWorkflowValidate(name, { json, ...(dir ? { dir } : {}) });
    });

  workflow
    .command("run <name>")
    .description("run a workflow (server-up: HTTP; server-down: in-process)")
    .option(
      "--inputs <k=v>",
      "workflow input as key=value; repeat to set multiple",
      (value: string, prev: string[]) => (prev ? [...prev, value] : [value]),
      [] as string[],
    )
    .option("--arguments <text>", "free-form workflow ARGUMENTS value")
    .option("--watch", "stream node events (default when stdout is a TTY)")
    .option("--no-watch", "skip streaming; emit a single envelope at completion")
    .option("--provider <id>", "provider id for in-process runs (default: stub)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .option("--project <name>", "named project (server resolves to its rootPath)")
    .option("--working-dir <path>", "override cwd directly (defaults to current shell cwd)")
    .option("--worktree", "force a git-worktree isolated run (overrides workflow default)")
    .option("--no-worktree", "force an in-place run (overrides workflow default)")
    .action(async function runAction(
      this: Command,
      name: string,
      runOpts: {
        inputs: string[];
        arguments?: string;
        watch?: boolean;
        provider?: string;
        baseUrl?: string;
        project?: string;
        workingDir?: string;
        worktree?: boolean;
      },
    ) {
      const { json } = globalOpts(this);
      await runWorkflowRun(name, {
        json,
        inputs: runOpts.inputs,
        arguments: runOpts.arguments,
        watch: runOpts.watch,
        provider: runOpts.provider,
        baseUrl: runOpts.baseUrl,
        ...(runOpts.project ? { project: runOpts.project } : {}),
        ...(runOpts.workingDir ? { workingDir: runOpts.workingDir } : {}),
        ...(runOpts.worktree !== undefined ? { worktree: runOpts.worktree } : {}),
      });
    });

  workflow
    .command("respond <runId> <nodeId> <text>")
    .description(
      "resume a paused workflow run by sending text to the paused node (server-required)",
    )
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .option(
      "--pause-id <id>",
      "per-pause token from the approval_awaiting frame; required to disambiguate retries against interactive loops",
    )
    .action(async function respondAction(
      this: Command,
      runId: string,
      nodeId: string,
      text: string,
      respondOpts: { baseUrl?: string; pauseId?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", respondOpts.baseUrl);
      const pauseId = requireNonEmpty(json, "--pause-id", respondOpts.pauseId);
      await runWorkflowRespond(runId, nodeId, text, {
        json,
        ...(baseUrl ? { baseUrl } : {}),
        ...(pauseId ? { pauseId } : {}),
      });
    });

  workflow
    .command("resume <runId>")
    .description(
      "resume an interrupted (cancelled/failed) run from the last completed node (server-required)",
    )
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function resumeAction(
      this: Command,
      runId: string,
      resumeOpts: { baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", resumeOpts.baseUrl);
      await runWorkflowResume(runId, {
        json,
        ...(baseUrl ? { baseUrl } : {}),
      });
    });

  workflow
    .command("status [runId]")
    .description("show recent runs or a single run's status (server-required)")
    .option("--workflow <name>", "list runs for a specific workflow name")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function statusAction(
      this: Command,
      runId: string | undefined,
      statusOpts: { workflow?: string; baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      await runWorkflowStatus(runId, {
        json,
        baseUrl: statusOpts.baseUrl,
        workflow: statusOpts.workflow,
      });
    });

  const project = program
    .command("project")
    .description("project operations (list, add, remove) — named pointers workflows run against");

  project
    .command("list")
    .description("list registered projects (server-required)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function projectListAction(this: Command, listOpts: { baseUrl?: string }) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", listOpts.baseUrl);
      await runProjectList({ json, ...(baseUrl ? { baseUrl } : {}) });
    });

  project
    .command("add <name> <rootPath>")
    .description("register a project pointing at a local directory (server-required)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function projectAddAction(
      this: Command,
      name: string,
      rootPath: string,
      addOpts: { baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", addOpts.baseUrl);
      await runProjectAdd(name, rootPath, {
        json,
        ...(baseUrl ? { baseUrl } : {}),
      });
    });

  project
    .command("remove <nameOrId>")
    .description("remove a project by name or id (server-required)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function projectRemoveAction(
      this: Command,
      nameOrId: string,
      removeOpts: { baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", removeOpts.baseUrl);
      await runProjectRemove(nameOrId, { json, ...(baseUrl ? { baseUrl } : {}) });
    });

  const rib = program
    .command("rib")
    .description("rib operations (add, remove, list, show) — manage and inspect extensions");

  rib
    .command("list")
    .description("list discovered ribs with their tools, surfaces, and auth (server-required)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .option("--installed", "list ribs installed in the keelson home (no server needed)")
    .action(async function ribListAction(
      this: Command,
      listOpts: { baseUrl?: string; installed?: boolean },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", listOpts.baseUrl);
      await runRibList({
        json,
        ...(baseUrl ? { baseUrl } : {}),
        ...(listOpts.installed ? { installed: true } : {}),
      });
    });

  rib
    .command("add <source>")
    .description(
      "install a rib into the keelson home from any bun-installable source (a github URL, github:owner/repo, a git URL, an npm name, or a local path)",
    )
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function ribAddAction(
      this: Command,
      source: string,
      addOpts: { baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", addOpts.baseUrl);
      await runRibAdd(source, { json, ...(baseUrl ? { baseUrl } : {}) });
    });

  rib
    .command("remove <id>")
    .description("uninstall a rib from the keelson home")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function ribRemoveAction(
      this: Command,
      id: string,
      removeOpts: { baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", removeOpts.baseUrl);
      await runRibRemove(id, { json, ...(baseUrl ? { baseUrl } : {}) });
    });

  rib
    .command("show <id>")
    .description("show one rib's tools, views, surfaces, and auth (server-required)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function ribShowAction(
      this: Command,
      id: string,
      showOpts: { baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", showOpts.baseUrl);
      await runRibShow(id, { json, ...(baseUrl ? { baseUrl } : {}) });
    });

  const gateway = program
    .command("gateway")
    .description(
      "gateway operations (list, add, remove) — OpenAI-compatible endpoints (OpenRouter, Ollama, vLLM, Azure)",
    );

  gateway
    .command("list")
    .description("list configured gateways and whether each has a stored key (server-required)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function gatewayListAction(this: Command, listOpts: { baseUrl?: string }) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", listOpts.baseUrl);
      await runGatewayList({ json, ...(baseUrl ? { baseUrl } : {}) });
    });

  gateway
    .command("add <name> <url>")
    .description(
      "add or update a gateway (url is the OpenAI base, e.g. http://localhost:11434/v1) (server-required)",
    )
    .option("--model <model>", "default model id served by this gateway")
    .option("--key <apiKey>", "API key (or set KEELSON_GATEWAY_KEY); omit for keyless gateways")
    .option("--protocol <protocol>", "wire protocol (openai)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function gatewayAddAction(
      this: Command,
      name: string,
      url: string,
      addOpts: { model?: string; key?: string; protocol?: string; baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", addOpts.baseUrl);
      await runGatewayAdd(name, url, {
        json,
        ...(addOpts.model ? { model: addOpts.model } : {}),
        ...(addOpts.key ? { key: addOpts.key } : {}),
        ...(addOpts.protocol ? { protocol: addOpts.protocol } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      });
    });

  gateway
    .command("remove <name>")
    .description("remove a gateway and delete its stored key (server-required)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function gatewayRemoveAction(
      this: Command,
      name: string,
      removeOpts: { baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", removeOpts.baseUrl);
      await runGatewayRemove(name, { json, ...(baseUrl ? { baseUrl } : {}) });
    });

  const approval = program
    .command("approval")
    .description(
      "approval operations (list, resolve) — resolve a policy ASK gate (server-required)",
    );

  approval
    .command("list")
    .description("list pending approvals awaiting a decision (server-required)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function approvalListAction(this: Command, listOpts: { baseUrl?: string }) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", listOpts.baseUrl);
      await runApprovalList({ json, ...(baseUrl ? { baseUrl } : {}) });
    });

  approval
    .command("resolve <id> <decision>")
    .description("resolve a pending approval; decision is 'accept' or 'reject' (server-required)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function approvalResolveAction(
      this: Command,
      id: string,
      decision: string,
      resolveOpts: { baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", resolveOpts.baseUrl);
      await runApprovalResolve(id, decision, { json, ...(baseUrl ? { baseUrl } : {}) });
    });

  const worktree = program
    .command("worktree")
    .description("worktree maintenance (prune leftover isolated run directories)");

  worktree
    .command("prune")
    .description("remove leftover worktrees under ~/.keelson/worktrees/")
    .option("--dry-run", "list candidates without removing anything", false)
    .option("--force", "also remove directories with uncommitted changes", false)
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function pruneAction(
      this: Command,
      pruneOpts: { dryRun: boolean; force: boolean; baseUrl?: string },
    ) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", pruneOpts.baseUrl);
      await runWorktreePrune({
        json,
        dryRun: pruneOpts.dryRun,
        force: pruneOpts.force,
        ...(baseUrl ? { baseUrl } : {}),
      });
    });

  program
    .command("chat [message]")
    .description(
      "one-shot chat turn (server-up: HTTP+SPA-visible; server-down: in-process to stdout); no message on a TTY opens interactive chat",
    )
    .option("--provider <id>", "provider id (default: mirror server / pick first non-stub)")
    .option("--model <id>", "model id passed to the provider (default: provider default)")
    .option("--conversation <id>", "continue an existing conversation (server-up only)")
    .option(
      "--project <name>",
      "bind the new conversation to a named project (server-required; default: the server's default project)",
    )
    .option("--thinking", "enable Claude extended thinking for this turn")
    .option(
      "--reasoning-effort <level>",
      `Copilot reasoning tier (${reasoningEffortLevelSchema.options.join("|")})`,
    )
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function chatAction(
      this: Command,
      message: string | undefined,
      chatOpts: {
        provider?: string;
        model?: string;
        conversation?: string;
        project?: string;
        thinking?: boolean;
        reasoningEffort?: string;
        baseUrl?: string;
      },
    ) {
      const { json } = globalOpts(this);
      // Validate non-empty string options BEFORE any server round-trip so
      // an unset env-var expansion (`--provider "$PROVIDER"` with PROVIDER
      // unset → `""`) exits with a clean BAD_INPUTS envelope instead of
      // silently routing the prompt to the default provider / fresh
      // conversation.
      const provider = requireNonEmpty(json, "--provider", chatOpts.provider);
      const model = requireNonEmpty(json, "--model", chatOpts.model);
      const conversationId = requireNonEmpty(json, "--conversation", chatOpts.conversation);
      const project = requireNonEmpty(json, "--project", chatOpts.project);
      const baseUrl = requireNonEmpty(json, "--base-url", chatOpts.baseUrl);
      // Validate --reasoning-effort against the locked Zod enum so an
      // invalid tier exits 2 cleanly instead of creating an orphan
      // conversation row that the WS parser then rejects mid-stream.
      // `!== undefined` rather than truthiness so `--reasoning-effort ''`
      // trips the enum validator instead of silently dropping to the
      // provider default.
      let reasoningEffort: ReasoningEffortLevel | undefined;
      if (chatOpts.reasoningEffort !== undefined) {
        const parsed = reasoningEffortLevelSchema.safeParse(chatOpts.reasoningEffort);
        if (!parsed.success) {
          emit(
            {
              error: `invalid --reasoning-effort '${chatOpts.reasoningEffort}'; expected one of ${reasoningEffortLevelSchema.options.join("|")}`,
              code: "BAD_INPUTS",
            },
            { json },
          );
          process.exit(EXIT_BAD_ARGS);
        }
        reasoningEffort = parsed.data;
      }
      await runChatEntry(message, {
        json,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(project ? { project } : {}),
        ...(chatOpts.thinking !== undefined ? { thinking: chatOpts.thinking } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      });
    });

  program
    .command("update")
    .description(
      "update keelson (and github-sourced ribs) in the managed home to the latest release",
    )
    .option("--check", "report the available version without applying", false)
    .option("--force", "re-apply even when already on the latest version", false)
    .option("--no-ribs", "skip advancing github-sourced ribs")
    .option("--no-notes", "skip fetching and showing release notes")
    .action(async function updateAction(this: Command) {
      const { json } = globalOpts(this);
      const { check, force, ribs, notes } = this.opts<{
        check: boolean;
        force: boolean;
        ribs: boolean;
        notes: boolean;
      }>();
      await runUpdate({ json, check, force, ribs, notes });
    });

  program
    .command("doctor")
    .description("probe toolchain, server, DB, auth, and workflows")
    .option("--strict", "exit non-zero on warnings as well as failures", false)
    .action(async function doctorAction(this: Command) {
      const { json } = globalOpts(this);
      const { strict } = this.opts<{ strict: boolean }>();
      await runDoctor({ json, strict });
    });

  const workspace = program
    .command("workspace")
    .description("workspace operations (list active workspace leases)");

  workspace
    .command("list")
    .description("list active workspace leases (server-required)")
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function workspaceListAction(this: Command, listOpts: { baseUrl?: string }) {
      const { json } = globalOpts(this);
      const baseUrl = requireNonEmpty(json, "--base-url", listOpts.baseUrl);
      await runWorkspaceList({ json, ...(baseUrl ? { baseUrl } : {}) });
    });

  return program;
}

const BAD_ARGS_CODES = new Set([
  "commander.missingArgument",
  "commander.missingMandatoryOptionValue",
  "commander.unknownCommand",
  "commander.unknownOption",
  "commander.invalidArgument",
  "commander.excessArguments",
  "commander.optionMissingArgument",
  "commander.conflictingOption",
]);

interface CommanderLikeError {
  code?: string;
  message?: string;
}

function isCommanderError(err: unknown): err is CommanderLikeError {
  // Match only commander's prefixed codes — fetch errors, Node sys errors,
  // and other things-with-a-code-property would otherwise be misclassified
  // and get a synthetic bad-args envelope.
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("commander.");
}

function commandSummary(
  cmd: Command,
): Array<{ name: string; description: string; commands?: ReturnType<typeof commandSummary> }> {
  return cmd.commands
    .filter((c) => !(c as Command & { _hidden?: boolean })._hidden)
    .map((c) => {
      const entry: {
        name: string;
        description: string;
        commands?: ReturnType<typeof commandSummary>;
      } = {
        name: c.name(),
        description: c.description(),
      };
      if (c.commands.length > 0) entry.commands = commandSummary(c);
      return entry;
    });
}

function helpEnvelope(cmd: Command, program: Command): { data: unknown } {
  return {
    data: {
      name: pkg.name,
      version: pkg.version,
      command: cmd === program ? null : cmd.name(),
      description: cmd.description(),
      usage: cmd.usage(),
      options: cmd.options.map((o) => ({ flags: o.flags, description: o.description })),
      commands: commandSummary(cmd),
    },
  };
}

function findHelpTarget(program: Command, argv: readonly string[]): Command {
  // Strip node + script entries, then walk positional args to find the
  // deepest command the operator was asking about. Handles every help shape:
  // `keelson help X`, `keelson X help`, `keelson X help Y`, `keelson X --help`,
  // `keelson X Y --help`. The `help` keyword is skipped wherever it appears
  // so the prefix path before it is preserved.
  const args = argv.slice(2);
  const helpFlagIdx = args.findIndex((a) => a === "--help" || a === "-h");
  const upToFlag = helpFlagIdx === -1 ? args : args.slice(0, helpFlagIdx);
  const positionals = upToFlag.filter((a) => !a.startsWith("-") && a !== "help");
  let current = program;
  for (const name of positionals) {
    const sub = current.commands.find((c) => c.name() === name || c.aliases().includes(name));
    if (!sub) break;
    current = sub;
  }
  return current;
}

// Flags that consume the following token as their value, drawn from the live
// root + chat option tables so the alias scan below can't drift from them.
export function valueTakingFlags(program: Command): ReadonlySet<string> {
  const chat = program.commands.find((c) => c.name() === "chat");
  const flags = new Set<string>();
  for (const opt of [...program.options, ...(chat?.options ?? [])]) {
    if (!opt.required && !opt.optional) continue;
    if (opt.short) flags.add(opt.short);
    if (opt.long) flags.add(opt.long);
  }
  return flags;
}

// `keelson -p "msg"` is sugar for `keelson chat "msg"` (parity with
// `copilot -p` / `claude -p`). Rewriting argv before parse gives the alias
// full option parity with `chat` without duplicating its options at the root.
// `chat` is inserted ahead of any flags that preceded `-p` so they reach
// chat's parser (`keelson --provider stub -p hi` works); option values are
// skipped via valueFlags so they don't read as a subcommand. Only a `-p`
// ahead of the first true positional is rewritten; after a subcommand name it
// stays put so the preAction guard can reject it.
export function rewritePromptAlias(
  argv: readonly string[],
  valueFlags: ReadonlySet<string>,
): readonly string[] {
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i] ?? "";
    const toChat = (message?: string): string[] => [
      ...argv.slice(0, 2),
      "chat",
      ...(message === undefined ? [] : [message]),
      ...argv.slice(2, i),
      ...argv.slice(i + 1),
    ];
    if (token === "-p" || token === "--prompt") return toChat();
    if (token.startsWith("--prompt=")) return toChat(token.slice("--prompt=".length));
    if (token.startsWith("-p") && !token.startsWith("--") && token.length > 2) {
      return toChat(token.slice(2));
    }
    if (token === "--" || !token.startsWith("-")) break;
    if (!token.includes("=") && valueFlags.has(token)) i++;
  }
  return argv;
}

function versionEnvelope(): { data: unknown } {
  return {
    data: {
      name: pkg.name,
      version: pkg.version,
      bunVersion: Bun.version,
      schemaVersion: SCHEMA_VERSION,
    },
  };
}

function applyExitOverride(cmd: Command): void {
  // Subcommands don't inherit exitOverride from the parent in commander 12;
  // walk the tree so every command routes through our catch block.
  cmd.exitOverride();
  // Reject extra operands at every level. Default commander accepts them
  // silently, which lets typos slip through (`keelson version foo` would exit
  // 0). The bad-args exit code 2 is a stable contract.
  cmd.allowExcessArguments(false);
  for (const sub of cmd.commands) applyExitOverride(sub);
}

function silenceOutput(cmd: Command): void {
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  for (const sub of cmd.commands) silenceOutput(sub);
}

function cleanCommanderMessage(message: string): string {
  // Commander prefixes parse errors with "error: "; we add our own prefix in
  // human mode and the JSON envelope's `error` field shouldn't double-print it.
  return message.replace(/^error:\s*/i, "");
}

export async function run(rawArgv: readonly string[]): Promise<void> {
  const program = buildProgram();
  const argv = rewritePromptAlias(rawArgv, valueTakingFlags(program));
  const wantsJson = argv.includes("--json");

  // First-run provisioning: a fresh home gets the starter workflows and the
  // command/script files they reference, so `workflow list`, the SPA, and a
  // smoke-test run have something to work with before any rib is installed.
  // No-op once each dir is populated, and a failure must not block the command.
  try {
    const paths = keelsonPaths();
    seedStarterAssets(paths.home, paths.workflowsDir);
  } catch {
    // non-fatal: discovery just sees an empty dir
  }
  // In-process runs (server down) execute bash nodes here; put `forge` on PATH.
  installForgeOnPath();

  applyExitOverride(program);
  if (wantsJson) {
    silenceOutput(program);
  }

  try {
    await program.parseAsync(argv as string[]);
  } catch (err) {
    if (!isCommanderError(err)) {
      // Non-commander errors (e.g. bad KEELSON_SERVER_URL) get a clean message
      // and a non-zero exit rather than an unhandled-rejection stack trace.
      const message = err instanceof Error ? err.message : String(err);
      if (wantsJson) {
        emit({ error: message, code: "FAIL" }, { json: true });
      } else {
        process.stderr.write(`error: ${message}\n`);
      }
      process.exit(EXIT_FAIL);
    }
    const code = err.code ?? "UNKNOWN";
    // Help / version paths: commander suppresses output in JSON mode, so emit
    // a structured envelope instead of exiting silently — the CLI's --json
    // contract is that every entry point produces a parseable payload.
    if (code === "commander.help" || code === "commander.helpDisplayed") {
      if (wantsJson) {
        emit(helpEnvelope(findHelpTarget(program, argv), program), { json: true });
      }
      process.exit(EXIT_OK);
    }
    if (code === "commander.version") {
      if (wantsJson) emit(versionEnvelope(), { json: true });
      process.exit(EXIT_OK);
    }
    const exitCode = BAD_ARGS_CODES.has(code) ? EXIT_BAD_ARGS : EXIT_FAIL;
    const message = cleanCommanderMessage(err.message ?? "argument parse error");
    // Commander already printed the error + usage to stderr in human mode.
    // Skip the duplicate; in JSON mode we suppressed commander's writes, so
    // the envelope is the only thing the operator gets.
    if (wantsJson) {
      emit({ error: message, code }, { json: true });
    }
    process.exit(exitCode);
  }
}
