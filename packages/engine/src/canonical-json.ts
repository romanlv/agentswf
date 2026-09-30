import type { JsonValue } from "@agentswf/contract/workflow";

/** The value with every object's keys sorted, so equal values serialise alike. */
export function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key]!)]),
  );
}
