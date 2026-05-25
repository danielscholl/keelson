/**
 * Condition evaluator for DAG workflow `when:` expressions.
 *
 * Ported from Archon `packages/workflows/src/condition-evaluator.ts`. Pure:
 * depends only on schema types. Logging calls were dropped — fail-closed
 * semantics are expressed by the `parsed` flag in the result.
 *
 * Supported expression syntax:
 *
 *   String equality:  "$nodeId.output == 'VALUE'"  / "$nodeId.output != 'VALUE'"
 *   Dot notation:     "$nodeId.output.field == 'VALUE'"
 *   Numeric ops:      "$nodeId.output > '80'"  / ">=" / "<" / "<="
 *                     (both sides must parse as finite numbers; fail-closed otherwise)
 *   Compound AND/OR:  "$a.output == 'X' && $b.output != 'Y'"
 *                     "$a.output == 'X' || $b.output == 'Y'"
 *                     AND has higher precedence than OR. No parentheses.
 *
 * Returns `result: true` to run the node, `result: false` to skip it.
 * `parsed: false` indicates the expression itself was malformed (fail-closed).
 */

import type { NodeOutput } from "./schema/index.ts";

/**
 * Resolve a `$nodeId.output` or `$nodeId.output.field` reference to a string.
 * Returns empty string for unknown nodes, empty outputs, or failed JSON access.
 */
function resolveOutputRef(
	nodeId: string,
	field: string | undefined,
	nodeOutputs: Map<string, NodeOutput>,
): string {
	const nodeOutput = nodeOutputs.get(nodeId);
	if (!nodeOutput) return "";
	if (!nodeOutput.output) return "";
	if (!field) return nodeOutput.output;

	try {
		const parsed = JSON.parse(nodeOutput.output) as Record<string, unknown>;
		const value = parsed[field];
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		return "";
	} catch {
		return "";
	}
}

/**
 * Split a string on a separator, but only when not inside single-quoted regions.
 * Returns at least one element (the full trimmed string if no split occurs).
 */
function splitOutsideQuotes(expr: string, sep: string): string[] {
	const parts: string[] = [];
	let current = "";
	let inQuote = false;
	let i = 0;
	while (i < expr.length) {
		if (expr[i] === "'") {
			inQuote = !inQuote;
			current += expr[i++];
		} else if (!inQuote && expr.startsWith(sep, i)) {
			parts.push(current.trim());
			current = "";
			i += sep.length;
		} else {
			current += expr[i++];
		}
	}
	parts.push(current.trim());
	return parts;
}

/** Pattern matching a single condition atom: $nodeId.output[.field] OPERATOR 'value' */
const ATOM_PATTERN =
	/^\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\s*(==|!=|<=|>=|<|>)\s*'([^']*)'$/;

function evaluateAtom(
	expr: string,
	nodeOutputs: Map<string, NodeOutput>,
): { result: boolean; parsed: boolean } {
	const trimmed = expr.trim();
	const match = ATOM_PATTERN.exec(trimmed);
	if (!match) return { result: false, parsed: false };

	const [, nodeId, field, operator, expected] = match;
	if (nodeId === undefined || operator === undefined || expected === undefined) {
		return { result: false, parsed: false };
	}

	const actual = resolveOutputRef(nodeId, field, nodeOutputs);

	let result: boolean;
	if (operator === "==" || operator === "!=") {
		result = operator === "==" ? actual === expected : actual !== expected;
	} else {
		const actualNum = parseFloat(actual);
		const expectedNum = parseFloat(expected);
		if (!Number.isFinite(actualNum) || !Number.isFinite(expectedNum)) {
			return { result: false, parsed: false };
		}
		if (operator === "<") result = actualNum < expectedNum;
		else if (operator === ">") result = actualNum > expectedNum;
		else if (operator === "<=") result = actualNum <= expectedNum;
		else result = actualNum >= expectedNum; // '>='
	}

	return { result, parsed: true };
}

/**
 * Evaluate a `when:` expression against the current `nodeOutputs` map.
 *
 * Returns `{ result, parsed }`:
 * - `result: true`  → run the node
 * - `result: false` → skip the node
 * - `parsed: false` → the expression itself was malformed (fail-closed, result also false)
 *
 * Compound expressions: `||` has lower precedence than `&&`. No parentheses.
 * Quoted regions (single quotes) are not split on.
 */
export function evaluateCondition(
	expr: string,
	nodeOutputs: Map<string, NodeOutput>,
): { result: boolean; parsed: boolean } {
	const trimmed = expr.trim();

	const orClauses = splitOutsideQuotes(trimmed, "||");

	for (const orClause of orClauses) {
		const andAtoms = splitOutsideQuotes(orClause, "&&");
		let orClauseResult = true;

		for (const atom of andAtoms) {
			const { result, parsed } = evaluateAtom(atom, nodeOutputs);
			if (!parsed) return { result: false, parsed: false };
			if (!result) {
				orClauseResult = false;
				break; // short-circuit AND
			}
		}

		if (orClauseResult) return { result: true, parsed: true }; // short-circuit OR
	}

	return { result: false, parsed: true };
}
