import { isMap, isScalar, parseDocument } from "yaml";
import { type Checked, checkSchema, explainProblems, type Problem } from "../../shared/validate";
import { type Key, KeySchema, SETTINGS_PATTERNS } from "./settings";

/** A `key.md`: its frontmatter, checked, and the note below it. */
export type ReadKey = { key: Key; note: string };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** Fact names a key may not give: `error` is checked on every trial, and `_` names are reserved. */
const RESERVED = (name: string) => name === "error" || name.startsWith("_");

/**
 * Reads a key strictly: YAML 1.2's core schema, where only `true` and `false` are booleans, so an
 * unquoted `no` is refused rather than read as a string or false; an unknown field is refused.
 */
export function parseKey(text: string): Checked<ReadKey> {
  const match = FRONTMATTER.exec(text);
  if (!match) return fail("/", "a key starts with frontmatter between --- lines");
  const document = parseDocument(match[1]!, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  const yamlProblems = [...document.errors, ...document.warnings];
  if (yamlProblems.length > 0) {
    // The frontmatter starts on the file's second line.
    const lineOf = (offset: number) => {
      const before = match[1]!.slice(0, offset);
      return `line ${before.split("\n").length + 1}:${offset - before.lastIndexOf("\n")}`;
    };
    return {
      ok: false,
      problems: yamlProblems.map((e) => ({
        path: "",
        message: `${lineOf(e.pos[0])}: ${e.message}`,
      })),
    };
  }
  const raw: unknown = document.toJS();
  const checked = checkSchema(KeySchema, raw);
  if (!checked.ok) {
    return {
      ok: false,
      problems: explainProblems(checked.problems, {
        schema: KeySchema,
        value: raw,
        noun: "a key",
        patterns: SETTINGS_PATTERNS,
        hints: { marker: "case new writes one; copy one from another key, or remake the case" },
      }),
    };
  }
  const key = checked.value;
  const problems: Problem[] = [];
  for (const name of Object.keys(key.expect ?? {})) {
    if (RESERVED(name)) problems.push({ path: `/expect/${name}`, message: "is reserved" });
  }
  // Core schema reads `no` as a string; written unquoted it was almost surely meant as something
  // else, so every string in `expect` is quoted, and an unquoted one is refused.
  const expect = document.get("expect", true);
  if (isMap(expect)) {
    for (const item of expect.items) {
      if (
        isScalar(item.value) &&
        typeof item.value.value === "string" &&
        item.value.type === "PLAIN"
      ) {
        problems.push({
          path: `/expect/${String((item.key as { value?: unknown })?.value)}`,
          message: `quote "${item.value.value}": a string in expect is quoted`,
        });
      }
    }
  }
  for (const field of ["must", "must-not"] as const) {
    const list = key[field] ?? [];
    const seen = new Set<string>();
    list.forEach((criterion, index) => {
      if (seen.has(criterion)) {
        problems.push({ path: `/${field}/${index}`, message: "is given twice" });
      }
      seen.add(criterion);
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { key, note: match[2]!.trim() } };
}

/** The criteria in the report's numbering: `must 1`, `must-not 2`. */
export function criteriaOf(key: Key): { name: string; field: "must" | "must-not"; text: string }[] {
  return (["must", "must-not"] as const).flatMap((field) =>
    (key[field] ?? []).map((text, index) => ({ name: `${field} ${index + 1}`, field, text })),
  );
}

function fail(path: string, message: string): Checked<never> {
  return { ok: false, problems: [{ path, message }] };
}
