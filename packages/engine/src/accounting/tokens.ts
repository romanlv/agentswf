import type { ModelSpend, TokenUsage } from "@wf/contract/records";

/** The optional classes stay absent unless one side reports them. */
export function addTokens(left: TokenUsage, right: TokenUsage): TokenUsage {
  const optional = (field: "cacheWrite1h" | "reasoning") =>
    left[field] === undefined && right[field] === undefined
      ? {}
      : { [field]: (left[field] ?? 0) + (right[field] ?? 0) };
  return {
    input: left.input + right.input,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...optional("cacheWrite1h"),
    output: left.output + right.output,
    ...optional("reasoning"),
  };
}

/** One entry per model and per who spent it, the agent or its subagents. */
export function spendOf(
  records: readonly { model: string; delegated: boolean; tokens: TokenUsage }[],
): ModelSpend[] {
  const groups = new Map<string, ModelSpend>();
  for (const record of records) {
    const group = JSON.stringify([record.model, record.delegated]);
    const seen = groups.get(group);
    groups.set(group, {
      model: record.model,
      delegated: record.delegated,
      tokens: seen ? addTokens(seen.tokens, record.tokens) : { ...record.tokens },
    });
  }
  return [...groups.values()];
}
