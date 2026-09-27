import type { TokenUsage } from "@wf/contract/records";

/** USD per million tokens, for every class a request can be billed in. */
export type ModelRate = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

export type PriceTable = {
  /** Names the table a figure came from; figures from two bases are never compared. */
  basis: string;
  rate(model: string): ModelRate | undefined;
};

/** Anthropic prices cache writes at 1.25x input for five minutes and 2x for an hour. */
function anthropic(input: number, output: number, read = 0.1): ModelRate {
  return {
    input,
    output,
    cacheRead: input * read,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
  };
}

/** OpenAI lists cached input and, for its newer models, a cache-write rate of 1.25x input. */
function openai(input: number, cached: number, output: number, write = input * 1.25): ModelRate {
  return { input, output, cacheRead: cached, cacheWrite5m: write, cacheWrite1h: write };
}

/**
 * List prices, read on 2026-09-23 from https://platform.claude.com/docs/en/about-claude/pricing
 * and https://developers.openai.com/api/docs/pricing, and on 2026-09-26 from OpenRouter for Jev. A subscription is not charged per token,
 * but its allowance is drawn down roughly in proportion to these, so they price any run the same
 * way whoever pays for it.
 *
 * Not modelled: OpenAI's long-context rates (2x input and 1.5x output, on gpt-5.6 and gpt-6 past
 * a threshold, and on gpt-5.5 past 272K), so a very long codex session is under-estimated.
 */
const RATES: Record<string, ModelRate> = {
  "claude-fable-5-1": anthropic(10, 50, 0.025),
  "claude-fable-5": anthropic(10, 50),
  "claude-opus-5-5": anthropic(4, 20, 0.05),
  "claude-opus-5": anthropic(5, 25),
  "claude-opus-4-8": anthropic(5, 25),
  "claude-opus-4-7": anthropic(5, 25),
  "claude-opus-4-6": anthropic(5, 25),
  "claude-opus-4-5": anthropic(5, 25),
  "claude-sonnet-5": anthropic(2, 10),
  "claude-sonnet-4-6": anthropic(3, 15),
  "claude-sonnet-4-5": anthropic(3, 15),
  "claude-haiku-4-5": anthropic(1, 5),
  "gpt-6-astra": openai(10, 1, 50),
  "gpt-6-sol": openai(2, 0.2, 10),
  "gpt-6-luna": openai(0.1, 0.01, 0.5),
  "gpt-5.6-sol": openai(4, 0.4, 20),
  "gpt-5.6-terra": openai(2, 0.2, 12),
  "gpt-5.6-luna": openai(0.2, 0.02, 1.2),
  // No cache-write charge is listed for these.
  "gpt-5.5": openai(5, 0.5, 30, 5),
  "gpt-5.4": openai(2.5, 0.25, 15, 2.5),
  // OpenRouter's listing, read on 2026-09-26: input only; output is reported and not charged.
  "typesafe/jev-1.13": { input: 0.042, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
};

/**
 * A model is priced only as itself: its family id, the id with a release date after it, or either
 * with a context tag such as `[1m]`. Anything else, even a close sibling such as `claude-opus-5-6`
 * or `gpt-5.5-pro`, is unpriced rather than priced at a rate that is not its own.
 */
function lookup(model: string): ModelRate | undefined {
  const own = (id: string) => (Object.hasOwn(RATES, id) ? RATES[id] : undefined);
  const bare = model.replace(/\[[^\]]*\]$/, "");
  const dated = /^(.+?)-(\d{8}|\d{4}-\d{2}-\d{2})$/.exec(bare);
  return own(bare) ?? (dated ? own(dated[1]!) : undefined);
}

export const PUBLISHED_PRICES: PriceTable = { basis: "list prices 2026-09-26", rate: lookup };

/** `cacheWrite1h` is the part of `cacheWrite` with an hour's lifetime; the rest is five minutes. */
export function costOf(tokens: TokenUsage, rate: ModelRate): number {
  const hour = Math.min(tokens.cacheWrite, tokens.cacheWrite1h ?? 0);
  return (
    (tokens.input * rate.input +
      tokens.cacheRead * rate.cacheRead +
      (tokens.cacheWrite - hour) * rate.cacheWrite5m +
      hour * rate.cacheWrite1h +
      tokens.output * rate.output) /
    1_000_000
  );
}
