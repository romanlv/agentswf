/**
 * A model's provider, read from its id: a judge of one family may favour the answers of its own.
 * Unknown ids are "family unknown". Kept small and by prefix; add a family when a model of it is
 * judged or judges.
 */
const FAMILIES: [RegExp, string][] = [
  [/^(anthropic\/)?claude/i, "anthropic"],
  [/^(openai\/)?(gpt|o[0-9]|codex|chatgpt)/i, "openai"],
  [/^(google\/)?(gemini|gemma)/i, "google"],
  [/^(x-?ai\/)?grok/i, "xai"],
  [/^(meta(-llama)?\/)?llama/i, "meta"],
  [/^(mistral(ai)?\/)?(mistral|codestral|devstral|magistral)/i, "mistral"],
  [/^(deepseek\/)?deepseek/i, "deepseek"],
  [/^(qwen\/)?qwen/i, "qwen"],
  [/^(moonshot(ai)?\/)?kimi/i, "moonshot"],
  [/^(z-?ai\/)?glm/i, "zhipu"],
];

/** The harnesses that run one provider's models alone, for an alias such as claude's `sonnet`. */
const HARNESS_FAMILIES: Record<string, string> = { claude: "anthropic", codex: "openai" };

/**
 * The provider family of a model id, the part after a harness's provider prefix included; with
 * the harness, an alias it alone runs (`sonnet` on claude) too.
 */
export function familyOf(model: string, harness?: string): string | undefined {
  const id = model.split("/").length > 2 ? model.split("/").slice(-2).join("/") : model;
  const found = FAMILIES.find(
    ([pattern]) => pattern.test(id) || pattern.test(id.split("/").at(-1)!),
  )?.[1];
  return found ?? (harness ? HARNESS_FAMILIES[harness] : undefined);
}
