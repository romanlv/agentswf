import { describe, expect, test } from "bun:test";
import { priceClaudeOpus5 } from "./price";

describe("priceClaudeOpus5", () => {
  test("reproduces the cost claude reported for the turn the card was solved from", () => {
    // The calibration turn: `claude -p --output-format json` answered $0.141451 for these.
    const dollars = priceClaudeOpus5({
      inputTokens: 2,
      cacheWriteTokens: 13167,
      cacheReadTokens: 19342,
      outputTokens: 4,
    });
    expect(dollars).toBeCloseTo(0.141451, 6);
  });

  test("a missing token kind is zero, not a throw", () => {
    expect(priceClaudeOpus5({})).toBe(0);
    expect(priceClaudeOpus5({ outputTokens: 1_000_000 })).toBe(25);
  });

  test("cache reads are twenty times cheaper than cache writes", () => {
    expect(priceClaudeOpus5({ cacheWriteTokens: 1_000_000 })).toBe(10);
    expect(priceClaudeOpus5({ cacheReadTokens: 1_000_000 })).toBe(0.5);
  });
});
