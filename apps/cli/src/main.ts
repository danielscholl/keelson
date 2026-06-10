// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import {
  type ReasoningEffortLevel,
  reasoningEffortLevelSchema,
  SCHEMA_VERSION,
} from "@keelson/shared";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };

import { runChat } from "./commands/chat.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runProjectAdd, runProjectList, runProjectRemove } from "./commands/project.ts";
import { runRibAdd, runRibList, runRibRemove, runRibShow } from "./commands/rib.ts";
import { runServe, runServeStart, runServeStatus, runServeStop } from "./commands/serve.ts";
import { runUpdate } from "./commands/update.ts";
import { runWorkflowList } from "./commands/workflow-list.ts";
import { runWorkflowRespond } from "./commands/workflow-respond.ts";
import { runWorkflowRun } from "./commands/workflow-run.ts";
import { runWorkflowStatus } from "./commands/workflow-status.ts";
import { runWorkflowValidate } from "./commands/workflow-validate.ts";
import { runWorktreePrune } from "./commands/worktree.ts";
import { EXIT_BAD_ARGS, EXIT_FAIL, EXIT_OK } from "./exit.ts";
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
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true });

  program
    .command("version")
    .description("print CLI version, Bun runtime version, and contract schema version")
    .action(function versionAction(this: Command) {
      const { json } = globalOpts(this);
      emit(
        {
          data: {
            name: pkg.name,
            version: pkg.version,
            bunVersion: Bun.version,
            schemaVersion: SCHEMA_VERSION,
          },
        },
        { json },
      );
    });

  const serve = program
    .command("serve")
    .description("run the Keelson server in the foreground (use `serve start` for background)")
    .option("--db <path>", "override KEELSON_DB for this run")
    .action(async function serveAction(this: Command) {
      const { json } = globalOpts(this);
      const { db } = this.opts<{ db?: string }>();
      await runServe({ db, json });
    });

  serve
    .command("start")
    .description("start the server in the background and report its URL")
    .option("--db <path>", "override KEELSON_DB for the background server")
    .action(async function serveStartAction(this: Command) {
      const { json } = globalOpts(this);
      const { db } = this.opts<{ db?: string }>();
      await runServeStart({ db, json });
    });

  serve
    .command("stop")
    .description("stop the background server (graceful shutdown, kill fallback)")
    .action(async function serveStopAction(this: Command) {
      const { json } = globalOpts(this);
      await runServeStop({ json });
    });

  serve
    .command("status")
    .description("report whether the server is running and its URL (exit 0 up, 3 down)")
    .action(async function serveStatusAction(this: Command) {
      const { json } = globalOpts(this);
      await runServeStatus({ json });
    });

  const workflow = program
    .command("workflow")
    .description("workflow operations (list, validate, run, status)");

  workflow
    .command("list")
    .description("list workflows discovered under .keelson/workflows/")
    .action(async function listAction(this: Command) {
      const { json } = globalOpts(this);
      await runWorkflowList({ json });
    });

  workflow
    .command("validate [name]")
    .description("validate one or all workflow YAML files")
    .action(async function validateAction(this: Command, name?: string) {
      const { json } = globalOpts(this);
      await runWorkflowValidate(name, { json });
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
    .command("chat <message>")
    .description(
      "one-shot chat turn (server-up: HTTP+SPA-visible; server-down: in-process to stdout)",
    )
    .option("--provider <id>", "provider id (default: mirror server / pick first non-stub)")
    .option("--model <id>", "model id passed to the provider (default: provider default)")
    .option("--conversation <id>", "continue an existing conversation (server-up only)")
    .option("--thinking", "enable Claude extended thinking for this turn")
    .option(
      "--reasoning-effort <level>",
      `Copilot reasoning tier (${reasoningEffortLevelSchema.options.join("|")})`,
    )
    .option("--base-url <url>", "explicit server base URL (skips the probe)")
    .action(async function chatAction(
      this: Command,
      message: string,
      chatOpts: {
        provider?: string;
        model?: string;
        conversation?: string;
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
      await runChat(message, {
        json,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(conversationId ? { conversationId } : {}),
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
  return cmd.commands.map((c) => {
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
    const sub = current.commands.find((c) => c.name() === name);
    if (!sub) break;
    current = sub;
  }
  return current;
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

export async function run(argv: readonly string[]): Promise<void> {
  const wantsJson = argv.includes("--json");

  const program = buildProgram();
  applyExitOverride(program);
  if (wantsJson) {
    silenceOutput(program);
  }

  try {
    await program.parseAsync(argv as string[]);
  } catch (err) {
    if (!isCommanderError(err)) throw err;
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
