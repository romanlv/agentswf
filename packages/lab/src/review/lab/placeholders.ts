/**
 * Fills `{name}` anywhere in each argument, as in `--range {base}...HEAD`; `{{` and `}}` are
 * literal braces. A name not given is a usage error, never passed through.
 */
export function fill(argv: readonly string[], values: Readonly<Record<string, string>>): string[] {
  return argv.map((argument) =>
    argument.replace(/\{\{|\}\}|\{([^{}]*)\}|[{}]/g, (match, name: string | undefined) => {
      if (match === "{{") return "{";
      if (match === "}}") return "}";
      if (name !== undefined && Object.hasOwn(values, name)) return values[name]!;
      throw new Error(
        `${argument}: ${match} is not a placeholder; use ${Object.keys(values)
          .map((key) => `{${key}}`)
          .join(", ")}, or {{ and }} for a brace`,
      );
    }),
  );
}
