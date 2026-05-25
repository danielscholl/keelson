// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Command + script discovery for the `command`, `loop` and `script` handlers.
 *
 * Resolution order (first match wins). Principle: repo-local scope wins over
 * home-level scope — a project-pinned command must never be shadowed by a
 * same-named operator default.
 *
 *   1. `<cwd>/.keelson/<kind>/`  — repo-local
 *   2. `~/.keelson/<kind>/`      — home
 *
 * Each scope is walked 1 subdir deep — matching the workflows/commands
 * convention.
 */

import { homedir } from "node:os";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export { isValidCommandName } from "../schema/command-validation.ts";

const MAX_DISCOVERY_DEPTH = 1;
const HOME = homedir();

export type ScriptRuntime = "bun" | "uv";

const SCRIPT_EXT_RUNTIME: Record<string, ScriptRuntime> = {
	".ts": "bun",
	".js": "bun",
	".py": "uv",
};

export interface ResolvedCommand {
	path: string;
	content: string;
}

export interface ResolvedScript {
	name: string;
	path: string;
	runtime: ScriptRuntime;
}

function searchDirs(cwd: string, kind: "commands" | "scripts"): string[] {
	return [
		join(cwd, ".keelson", kind),
		join(HOME, ".keelson", kind),
	];
}

interface WalkedFile {
	path: string;
	ext: string;
	base: string;
}

async function walkFiles(root: string, depth = 0): Promise<WalkedFile[]> {
	let dirents: Dirent[];
	try {
		dirents = await readdir(root, { withFileTypes: true, encoding: "utf-8" });
	} catch {
		return [];
	}
	const out: WalkedFile[] = [];
	for (const d of dirents) {
		const name = d.name;
		const entryPath = join(root, name);
		if (d.isDirectory()) {
			if (depth >= MAX_DISCOVERY_DEPTH) continue;
			out.push(...(await walkFiles(entryPath, depth + 1)));
			continue;
		}
		if (!d.isFile()) continue;
		const ext = extname(name);
		out.push({ path: entryPath, ext, base: basename(name, ext) });
	}
	return out;
}

export async function resolveCommand(
	name: string,
	cwd: string,
): Promise<ResolvedCommand | null> {
	for (const dir of searchDirs(cwd, "commands")) {
		const files = await walkFiles(dir);
		const match = files.find((f) => f.ext === ".md" && f.base === name);
		if (!match) continue;
		try {
			const content = await readFile(match.path, "utf-8");
			if (!content.trim()) return null;
			return { path: match.path, content };
		} catch {
			// permission / IO error — try the next scope so a readable copy can
			// still satisfy the lookup
		}
	}
	return null;
}

/**
 * The runtime declared on the node is canonical: a `runtime: bun` node only
 * matches `.ts`/`.js`; a `runtime: uv` node only matches `.py`.
 */
export async function resolveScript(
	name: string,
	runtime: ScriptRuntime,
	cwd: string,
): Promise<ResolvedScript | null> {
	for (const dir of searchDirs(cwd, "scripts")) {
		const files = await walkFiles(dir);
		const match = files.find(
			(f) => f.base === name && SCRIPT_EXT_RUNTIME[f.ext] === runtime,
		);
		if (!match) continue;
		return { name, path: match.path, runtime };
	}
	return null;
}
