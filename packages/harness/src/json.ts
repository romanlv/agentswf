/** Reading what a harness wrote as JSON: its stdout, its session files, its status commands. */
export type Row = Record<string, unknown>;

export function record(value: unknown): Row | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A token count: anything missing or malformed counts nothing. */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** A figure the harness reported, where absent stays absent rather than becoming zero. */
export function reported(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseRow(json: string): Row | undefined {
  try {
    return record(JSON.parse(json));
  } catch {
    return undefined;
  }
}

/** One object per line; a line that is not one, such as a half-written last line, is skipped. */
export function jsonLines(output: string): Row[] {
  return output.split("\n").flatMap((line): Row[] => {
    const row = parseRow(line.trim());
    return row ? [row] : [];
  });
}
