/**
 * The cases `--cases` names: `{n}` takes the first n of a seeded order, the same for every variant,
 * so a small run is a fair sample and a larger one extends it; otherwise ids and globs (`*`, `?`),
 * comma-separated, in the seeded order. `rank` is the seeded order's key for an id.
 */
export function selectCases(
  ids: readonly string[],
  selection: string | undefined,
  rank: (id: string) => string,
): string[] {
  const ordered = ids.toSorted((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  if (selection === undefined) return ordered;
  if (/^[0-9]+$/.test(selection)) {
    const count = Number(selection);
    if (count < 1) throw new Error("--cases takes a positive count, ids or globs");
    return ordered.slice(0, count);
  }
  const chosen = new Set<string>();
  const unknown: string[] = [];
  for (const pattern of new Set(selection.split(",").map((id) => id.trim()))) {
    const matches = /[*?]/.test(pattern)
      ? ids.filter((id) => globOf(pattern).test(id))
      : ids.filter((id) => id === pattern);
    if (matches.length === 0) unknown.push(pattern);
    for (const id of matches) chosen.add(id);
  }
  if (unknown.length > 0) throw new Error(`not in the dataset: ${unknown.join(", ")}`);
  return ordered.filter((id) => chosen.has(id));
}

function globOf(pattern: string): RegExp {
  const body = [...pattern]
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}
