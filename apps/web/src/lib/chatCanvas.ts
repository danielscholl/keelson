import type { LiveToolCall } from "../components/Chat/ToolCallsBlock.tsx";

function hasPublishedCanvasKey(result: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "key" in parsed &&
    typeof parsed.key === "string" &&
    parsed.key.trim().length > 0
  );
}

export function publishedCanvasResult(
  toolCalls: readonly LiveToolCall[] | undefined,
): string | undefined {
  let selected: string | undefined;
  for (const call of toolCalls ?? []) {
    if (call.toolName !== "canvas_publish" || call.isError === true || call.result === undefined)
      continue;
    if (hasPublishedCanvasKey(call.result)) selected = call.result;
  }
  return selected;
}

// The published artifact's snapshot key + human title, parsed from the
// canvas_publish result JSON (shape: `{ key, title, ... }`). Used to render the
// artifact card; the raw result string still drives the open handler.
export interface PublishedArtifact {
  key: string;
  title?: string;
}

export function parsePublishedArtifact(result: string): PublishedArtifact | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || !("key" in parsed)) return undefined;
  const key = (parsed as { key: unknown }).key;
  if (typeof key !== "string" || key.trim().length === 0) return undefined;
  const rawTitle = (parsed as { title?: unknown }).title;
  const title = typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle : undefined;
  return title !== undefined ? { key, title } : { key };
}
