/**
 * Dollars for a claude turn that reported none.
 *
 * A pane records tokens in its session log but no price, so E3 would have no dollar figure for
 * the shape it most needs one for. The rate card below is not looked up: it is solved from
 * claude's own `total_cost_usd` on a headless turn that reported both, and it reproduces that
 * turn to the cent it was given —
 *
 *   in 2, cache-write(1h) 13167, cache-read 19342, out 4  ->  $0.141451 reported
 *   2*5 + 13167*10 + 19342*0.5 + 4*25, per million                 = $0.141451
 *
 * Both backends run `claude-opus-5` with 1-hour ephemeral cache writes, checked in the pane's
 * session log and in headless `modelUsage`, so the same card covers both. It covers nothing
 * else: codex and cursor publish no cost, and pi prices its own turns.
 */
export type ClaudeTokens = {
  inputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
};

/** Dollars per million tokens for `claude-opus-5`, 1-hour cache writes. */
export const OPUS_5_PER_MILLION = {
  input: 5,
  cacheWrite: 10,
  cacheRead: 0.5,
  output: 25,
} as const;

export function priceClaudeOpus5(tokens: ClaudeTokens): number {
  const { input, cacheWrite, cacheRead, output } = OPUS_5_PER_MILLION;
  return (
    ((tokens.inputTokens ?? 0) * input +
      (tokens.cacheWriteTokens ?? 0) * cacheWrite +
      (tokens.cacheReadTokens ?? 0) * cacheRead +
      (tokens.outputTokens ?? 0) * output) /
    1_000_000
  );
}
