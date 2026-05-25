/**
 * Conformance: no surviving references to upstream/cimpl-derived names in
 * the working tree outside the allow-list.
 *
 * If this test fails, the failure message lists every offending `file:line`.
 * Either rename the reference, or — if it's a wire-stable identifier or an
 * intentional attribution — add the file to ALLOW_LIST below with a one-line
 * rationale.
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun provides this at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import { execSync } from "node:child_process";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

// packages/shared/test/foo.ts → repo root is three levels up.
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

// Files whose flagged references are intentional and won't be swept.
const ALLOW_LIST: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [
	// Vendor-attribution surfaces — required by the workflow schema's MIT chain.
	{ file: "NOTICE", reason: "Archon MIT attribution (required by license)" },
	{ file: "README.md", reason: "References the Archon GitHub URL in the license footer" },
	// Self-reference — this file greps for the patterns.
	{ file: "packages/shared/test/rename-completeness.test.ts", reason: "self-reference" },
	// Lockfile churn — bun.lock includes transitive package names that may
	// match patterns; regenerated on `bun install`.
	{ file: "bun.lock", reason: "regenerated on `bun install`; allow stragglers" },
];

const ALLOW_LIST_PATHS = new Set(ALLOW_LIST.map((e) => e.file));

const PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
	{ label: "cimpl-agent", re: /cimpl-agent/ },
	{ label: "archon (lowercase)", re: /\barchon\b/ },
	{ label: "ARCHON_VERSION", re: /\bARCHON_VERSION\b/ },
	{ label: "pi-chamber", re: /\bpi-chamber\b/i },
	{ label: "CIMPL_NODE_*", re: /\bCIMPL_NODE_/ },
	{ label: "CIMPL_INPUTS_*", re: /\bCIMPL_INPUTS_/ },
	{ label: "CIMPL_ARTIFACTS_DIR", re: /\bCIMPL_ARTIFACTS_DIR\b/ },
	{ label: "CIMPL_ARGUMENTS", re: /\bCIMPL_ARGUMENTS\b/ },
	{ label: "KEELSON_EXTENSIONS", re: /\bKEELSON_EXTENSIONS\b/ },
];

function listTrackedFiles(): readonly string[] {
	// Untracked-aware so a freshly-scaffolded repo (no git history yet) still
	// sees its files. Falls back to a direct readdir when git isn't available.
	try {
		const out = execSync("git ls-files --cached --others --exclude-standard", {
			cwd: REPO_ROOT,
			encoding: "utf-8",
		});
		return out.split("\n").filter((s) => s.length > 0);
	} catch {
		return walkRepo(REPO_ROOT, "");
	}
}

function walkRepo(root: string, prefix: string): string[] {
	const out: string[] = [];
	const entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
	for (const entry of entries) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		if (entry.isDirectory()) {
			out.push(...walkRepo(root, rel));
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
	return out;
}

interface Offender {
	readonly file: string;
	readonly line: number;
	readonly label: string;
	readonly snippet: string;
}

function scanFile(rel: string): readonly Offender[] {
	const abs = path.join(REPO_ROOT, rel);
	let content: string;
	try {
		content = fs.readFileSync(abs, "utf-8");
	} catch {
		return [];
	}
	const out: Offender[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		for (const { label, re } of PATTERNS) {
			if (re.test(line)) {
				out.push({ file: rel, line: i + 1, label, snippet: line.trim().slice(0, 160) });
				break;
			}
		}
	}
	return out;
}

describe("rename-completeness", () => {
	test("no banned references survive outside the allow-list", () => {
		const files = listTrackedFiles();
		const offenders: Offender[] = [];
		for (const file of files) {
			if (ALLOW_LIST_PATHS.has(file)) continue;
			offenders.push(...scanFile(file));
		}
		if (offenders.length > 0) {
			const grouped = offenders.map(
				(o) => `  ${o.file}:${o.line}  [${o.label}]  ${o.snippet}`,
			);
			throw new Error(
				`rename-completeness: ${offenders.length} surviving reference(s):\n` +
					`${grouped.join("\n")}\n\n` +
					`Either rename the reference, or add the file to ALLOW_LIST with a rationale.`,
			);
		}
		expect(offenders.length).toBe(0);
	}, 30_000);

	test("allow-list entries point at real files", () => {
		for (const { file } of ALLOW_LIST) {
			const abs = path.join(REPO_ROOT, file);
			expect(fs.existsSync(abs)).toBe(true);
		}
	});
});
