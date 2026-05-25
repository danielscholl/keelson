// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import {
	detectCompletionSignal,
	formatSubprocessFailure,
	isInlineScript,
	stripCompletionTags,
} from "./helpers.ts";

describe("isInlineScript", () => {
	test("bare identifier is named (not inline)", () => {
		expect(isInlineScript("echo-args")).toBe(false);
		expect(isInlineScript("my_script")).toBe(false);
		expect(isInlineScript("triage.foo")).toBe(false);
	});

	test("anything with a newline is inline", () => {
		expect(isInlineScript("a\nb")).toBe(true);
	});

	test("shell metacharacters mark a body as inline", () => {
		for (const meta of [";", "(", ")", "{", "}", "&", "|", "<", ">", "$", "`", '"', "'", " "]) {
			expect(isInlineScript(`x${meta}y`)).toBe(true);
		}
	});
});

describe("detectCompletionSignal", () => {
	test("matches XML-wrapped signal with any tag", () => {
		expect(detectCompletionSignal("<promise>DONE</promise>", "DONE")).toBe(true);
		expect(detectCompletionSignal("<done>STOP</done>", "STOP")).toBe(true);
	});

	test("requires matching open/close tag names", () => {
		expect(detectCompletionSignal("<promise>DONE</done>", "DONE")).toBe(false);
	});

	test("matches plain signal at end of output", () => {
		expect(detectCompletionSignal("All clear. DONE", "DONE")).toBe(true);
		expect(detectCompletionSignal("Finished work DONE.", "DONE")).toBe(true);
	});

	test("matches plain signal on its own line", () => {
		expect(detectCompletionSignal("blah blah\nDONE\nstuff", "DONE")).toBe(true);
	});

	test("does not match signal embedded in prose mid-sentence", () => {
		expect(detectCompletionSignal("not DONE yet so keep going", "DONE")).toBe(false);
	});

	test("treats signal with regex specials safely", () => {
		expect(detectCompletionSignal("end: A.B+", "A.B+")).toBe(true);
		expect(detectCompletionSignal("end: A_B", "A.B+")).toBe(false);
	});
});

describe("stripCompletionTags", () => {
	test("strips <promise>…</promise> unconditionally", () => {
		expect(stripCompletionTags("hello <promise>DONE</promise> world")).toBe("hello  world");
	});

	test("strips matching <tag>UNTIL</tag> when until is provided", () => {
		expect(stripCompletionTags("ok <done>STOP</done> more", "STOP")).toBe("ok  more");
	});

	test("leaves mismatched tag names intact", () => {
		expect(stripCompletionTags("note <a>STOP</b> tail", "STOP")).toBe("note <a>STOP</b> tail");
	});

	test("returns trimmed result", () => {
		expect(stripCompletionTags("   trim me   ")).toBe("trim me");
	});
});

describe("formatSubprocessFailure", () => {
	test("includes exit code suffix when provided", () => {
		expect(formatSubprocessFailure("Script node 'x'", { cmd: "bun", exitCode: 1, stderrTail: "oops" })).toBe(
			"Script node 'x' failed [exit 1]: oops",
		);
	});

	test("falls back to 'no diagnostic output' when stderr is empty", () => {
		expect(formatSubprocessFailure("Script node 'x'", { cmd: "bun", exitCode: 2 })).toBe(
			"Script node 'x' failed [exit 2]: no diagnostic output",
		);
	});

	test("emits signal suffix when no exit code but a signal is present", () => {
		expect(
			formatSubprocessFailure("Script node 'x'", {
				cmd: "bun",
				signal: "SIGTERM",
				stderrTail: "killed",
			}),
		).toBe("Script node 'x' failed [signal SIGTERM]: killed");
	});

	test("truncates very long stderr tails", () => {
		const tail = `${"a".repeat(2_500)}TAIL`;
		const msg = formatSubprocessFailure("Bash node 'big'", { cmd: "bash", exitCode: 7, stderrTail: tail });
		expect(msg).toContain("…[truncated]");
		expect(msg).toContain("TAIL");
		expect(msg).not.toContain("a".repeat(2_001));
	});
});
