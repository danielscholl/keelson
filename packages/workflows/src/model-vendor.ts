const MODEL_VENDOR_PATTERNS: readonly [RegExp, string][] = [
  [/(?:^|[/:-])claude(?:$|[/:-])/, "anthropic"],
  [/(?:^|[/:-])(?:gpt|codex|o[1-9])(?:$|[/:-])/, "openai"],
  [/(?:^|[/:-])grok(?:$|[/:-])/, "xai"],
  [/(?:^|[/:-])gemini(?:$|[/:-])/, "google"],
  [/(?:^|[/:-])(?:mistral|codestral)(?:$|[/:-])/, "mistral"],
  [/(?:^|[/:-])qwen(?:$|[/:-])/, "alibaba"],
  [/(?:^|[/:-])llama(?:$|[/:-])/, "meta"],
  [/(?:^|[/:-])deepseek(?:$|[/:-])/, "deepseek"],
];

export function classifyModelVendor(
  provider: string | undefined,
  model: string | undefined,
): string | undefined {
  const normalizedModel = model?.trim().toLowerCase();
  if (normalizedModel) {
    for (const [pattern, vendor] of MODEL_VENDOR_PATTERNS) {
      if (pattern.test(normalizedModel)) return vendor;
    }
  }

  const normalizedProvider = provider?.trim().toLowerCase();
  if (normalizedProvider === "claude") return "anthropic";
  if (normalizedProvider === "codex") return "openai";
  return undefined;
}
