import type { LiveToolCall } from "../components/Chat/ToolCallsBlock.tsx";

// Long answers outgrow the fixed chat column the canvas drawer relieves; shorter
// ones read fine in the bubble, so the affordance only appears past this length.
export const CANVAS_OPEN_THRESHOLD = 2000;

// Only finished assistant answers qualify: user/system/command rows aren't
// markdown-rendered, and a streaming message is still growing.
export function shouldOfferCanvas(role: string, content: string, streaming: boolean): boolean {
  return role === "assistant" && !streaming && content.trim().length > CANVAS_OPEN_THRESHOLD;
}

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
