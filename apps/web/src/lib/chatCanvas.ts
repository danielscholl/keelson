// Long answers outgrow the fixed chat column the canvas drawer relieves; shorter
// ones read fine in the bubble, so the affordance only appears past this length.
export const CANVAS_OPEN_THRESHOLD = 2000;

// Only finished assistant answers qualify: user/system/command rows aren't
// markdown-rendered, and a streaming message is still growing.
export function shouldOfferCanvas(role: string, content: string, streaming: boolean): boolean {
  return role === "assistant" && !streaming && content.trim().length > CANVAS_OPEN_THRESHOLD;
}
