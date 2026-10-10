/** A prompt written inline: the template's indentation and outer blank lines are dropped. */
export function md(strings: TemplateStringsArray, ...values: unknown[]): string {
  const indents = strings
    .join("")
    .split("\n")
    .slice(1)
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const indent = new RegExp(`\n[ \\t]{0,${indents.length === 0 ? 0 : Math.min(...indents)}}`, "g");
  return strings
    .map((part, i) => part.replace(indent, "\n") + (i < values.length ? String(values[i]) : ""))
    .join("")
    .trim();
}

/** A heading and its items as a Markdown list; with no items, an empty line. */
export function list(heading: string, items: readonly string[]): string {
  return items.length === 0 ? "" : [heading, ...items.map((item) => `- ${item}`)].join("\n");
}
