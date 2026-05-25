// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Shared subprocess runner for `bash` and `script` handlers.
 *
 * Encapsulates the kill-group dance (SIGTERM → SIGKILL grace → orphan reap),
 * the stdout line-streamer (with per-line cap + soft byte cap on captured
 * text), the stderr tail capture, the timeout + abort wiring, and the
 * bounded drain race. Both handlers share the same safety properties — a
 * daemonizing child that escapes the process group can't pin runtime past
 * the documented timeout, and a script that traps SIGTERM can't deadlock
 * the run.
 *
 * The env channel (`KEELSON_INPUTS_*`, `KEELSON_NODE_*_OUTPUT`, `KEELSON_ARGUMENTS`)
 * is the contract documented in `bash.ts` — single source here so future
 * additions (e.g. `KEELSON_RUN_ID`) reach both surfaces.
 */

import type { NodeStreamEvent } from "../executor.ts";
import type { NodeOutput } from "../schema/index.ts";

export const SUBPROCESS_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const STDERR_TAIL_MAX_CHARS = 400;
const STDOUT_CAPTURE_MAX_BYTES = 1_000_000;
const KILL_GRACE_MS = 2_000;
const LINE_BUFFER_MAX_BYTES = 64 * 1024;
const DRAIN_DEADLINE_MS = 500;

export type SubprocessKillReason = "timeout" | "abort" | null;

export interface SubprocessOptions {
	cmd: string;
	args: readonly string[];
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	abortSignal: AbortSignal;
	emit: (event: NodeStreamEvent) => void;
	/** Trim a single trailing newline from captured stdout before returning. */
	trimTrailingNewline?: boolean;
}

export interface SubprocessOutcome {
	stdoutText: string;
	stderrTail: string;
	exitCode: number | null;
	killReason: SubprocessKillReason;
}

export class SubprocessSpawnError extends Error {
	constructor(public readonly cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "SubprocessSpawnError";
	}
}

/**
 * Spawn a subprocess with the shared timeout/abort/drain machinery. Caller
 * decides how to render the result into a `NodeResult` (label/runtime/exit
 * formatting differ between bash and script).
 *
 * Throws `SubprocessSpawnError` synchronously if `Bun.spawn` itself fails
 * (typically ENOENT for a missing executable). Otherwise resolves with the
 * captured stdout, stderr tail, exit code, and kill reason.
 */
export async function runSubprocess(opts: SubprocessOptions): Promise<SubprocessOutcome> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn([opts.cmd, ...opts.args], {
			cwd: opts.cwd,
			env: opts.env,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			// biome-ignore lint/suspicious/noTsIgnore: Bun supports `detached` at runtime; types lag.
			// @ts-ignore
			detached: true,
		});
	} catch (err) {
		throw new SubprocessSpawnError(err);
	}

	let killReason: SubprocessKillReason = null;
	let escalateTimer: ReturnType<typeof setTimeout> | null = null;

	const signalGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
		try {
			process.kill(-proc.pid, signal);
		} catch {
			try {
				proc.kill(signal);
			} catch {
				// already exited
			}
		}
	};

	const killOnce = (reason: "timeout" | "abort"): void => {
		if (killReason !== null) return;
		killReason = reason;
		signalGroup("SIGTERM");
		escalateTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
	};

	const timer = setTimeout(() => killOnce("timeout"), opts.timeoutMs);
	const onAbort = (): void => killOnce("abort");
	opts.abortSignal.addEventListener("abort", onAbort);
	if (opts.abortSignal.aborted) onAbort();

	const stdoutCapture: string[] = [];
	let stdoutBytes = 0;
	const stdoutPromise = streamLines(
		proc.stdout as ReadableStream<Uint8Array> | null,
		(line) => opts.emit({ type: "node_log", line }),
		(chunk) => {
			if (stdoutBytes < STDOUT_CAPTURE_MAX_BYTES) {
				stdoutCapture.push(chunk);
				stdoutBytes += chunk.length;
			}
		},
	);

	const stderrBox = { text: "" };
	const stderrPromise = streamStderr(
		proc.stderr as ReadableStream<Uint8Array> | null,
		stderrBox,
	);

	let exitCode: number | null;
	try {
		exitCode = await proc.exited;
	} finally {
		clearTimeout(timer);
		if (escalateTimer !== null) clearTimeout(escalateTimer);
		opts.abortSignal.removeEventListener("abort", onAbort);
	}
	signalGroup("SIGKILL");
	await Promise.race([
		Promise.allSettled([stdoutPromise, stderrPromise]),
		new Promise<void>((resolve) => setTimeout(resolve, DRAIN_DEADLINE_MS)),
	]);

	const rawStdout = stdoutCapture.join("");
	const stdoutText = opts.trimTrailingNewline ? rawStdout.replace(/\n$/, "") : rawStdout;
	const stderrTail = stderrBox.text.slice(-STDERR_TAIL_MAX_CHARS).trim();

	return { stdoutText, stderrTail, exitCode, killReason };
}

// ---------------------------------------------------------------------------
// Env channel
// ---------------------------------------------------------------------------

// Snapshot of the parent env at module load. Re-copying `process.env` on
// every spawn is wasteful; servers rarely mutate it after boot.
const PARENT_ENV: Readonly<Record<string, string>> = (() => {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") env[k] = v;
	}
	return env;
})();

/**
 * Build the env block for a workflow subprocess. Layers `KEELSON_INPUTS_*`,
 * `KEELSON_NODE_*_OUTPUT`, `KEELSON_ARGUMENTS`, and (when provided) the per-run
 * `KEELSON_ARTIFACTS_DIR` onto a snapshot of the parent env. Non-alphanumeric
 * chars in keys/node ids are normalized to `_` so the resulting names are
 * valid POSIX env-var identifiers.
 */
export function buildSubprocessEnv(
	inputs: Readonly<Record<string, string>>,
	upstream: ReadonlyMap<string, NodeOutput>,
	options?: { artifactsDir?: string },
): Record<string, string> {
	const env: Record<string, string> = { ...PARENT_ENV };
	// PARENT_ENV is captured at module load — if the operator's shell had
	// KEELSON_ARTIFACTS_DIR / ARTIFACTS_DIR set (or a parent process from a
	// prior run set them), they would leak into every subprocess unless we
	// clear them here. Set-back happens below when the caller provides a
	// per-run value.
	delete env.KEELSON_ARTIFACTS_DIR;
	delete env.ARTIFACTS_DIR;
	for (const [k, v] of Object.entries(inputs)) {
		env[`KEELSON_INPUTS_${envSafe(k)}`] = v;
	}
	env.KEELSON_ARGUMENTS = inputs.ARGUMENTS ?? "";
	for (const [id, out] of upstream.entries()) {
		env[`KEELSON_NODE_${envSafe(id)}_OUTPUT`] = out.output ?? "";
	}
	// Two env vars for the same path: `KEELSON_ARTIFACTS_DIR` is the prefixed
	// channel that matches the rest of our env contract (KEELSON_INPUTS_*,
	// KEELSON_NODE_*_OUTPUT). `ARTIFACTS_DIR` is the unprefixed name authors
	// reach for when porting workflows from Archon — and crucially, bash /
	// script nodes execute `ctx.rawBody` (pre-substitution, for command-
	// injection safety), so a body like `cd "$ARTIFACTS_DIR"` reaches the
	// shell literally and depends on env lookup. Without the unprefixed
	// var, that path resolves to empty and the command writes to `/`.
	if (options?.artifactsDir !== undefined) {
		env.KEELSON_ARTIFACTS_DIR = options.artifactsDir;
		env.ARTIFACTS_DIR = options.artifactsDir;
	}
	return env;
}

function envSafe(name: string): string {
	return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ---------------------------------------------------------------------------
// Stream readers
// ---------------------------------------------------------------------------

async function streamLines(
	stream: ReadableStream<Uint8Array> | null,
	onLine: (line: string) => void,
	onChunk: (chunk: string) => void,
): Promise<void> {
	if (!stream) return;
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			onChunk(chunk);
			buf += chunk;
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				onLine(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
			}
			// Defensive cap: a child producing many bytes without ever emitting
			// a newline (e.g. `head -c 100M /dev/zero`) would otherwise grow buf
			// unbounded.
			while (buf.length >= LINE_BUFFER_MAX_BYTES) {
				onLine(buf.slice(0, LINE_BUFFER_MAX_BYTES));
				buf = buf.slice(LINE_BUFFER_MAX_BYTES);
			}
		}
		if (buf.length > 0) onLine(buf);
	} catch {
		// reader closed mid-read; captured prefix is what we have
	}
}

async function streamStderr(
	stream: ReadableStream<Uint8Array> | null,
	out: { text: string },
): Promise<void> {
	if (!stream) return;
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			out.text += decoder.decode(value, { stream: true });
			if (out.text.length > STDERR_TAIL_MAX_CHARS * 4) {
				out.text = out.text.slice(-STDERR_TAIL_MAX_CHARS * 2);
			}
		}
	} catch {
		// reader closed mid-read; whatever we captured is what we report
	}
}
