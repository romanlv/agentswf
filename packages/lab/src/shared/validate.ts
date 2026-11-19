import type Type from "typebox";
import { Check, Errors } from "typebox/value";

export type Problem = {
  path: string;
  message: string;
  /** What the schema check said, for `explain` to put in words; absent from a hand-made problem. */
  raw?: { keyword: string; schemaPath: string; params: Record<string, unknown> };
};

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };

/** Checks a value against a schema, each problem once. */
export function checkSchema<S extends Type.TSchema>(
  schema: S,
  value: unknown,
): Checked<Type.Static<S>> {
  if (Check(schema, value)) return { ok: true, value };
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const error of Errors(schema, value)) {
    const problem = {
      path: error.instancePath || "/",
      message: error.message,
      raw: {
        keyword: error.keyword,
        schemaPath: error.schemaPath,
        params: error.params as Record<string, unknown>,
      },
    };
    const key = `${problem.path} ${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(problem);
  }
  return { ok: false, problems };
}

/** How `explainProblems` words a file's problems: what the file is, and phrases for its patterns. */
export type Explain = {
  schema: Type.TSchema;
  value: unknown;
  /** The file's root, as "a key" in "a key's fields". */
  noun: string;
  /** A pattern's meaning, by the pattern: "a number and a unit, such as 30m or 90s". */
  patterns?: Readonly<Record<string, string>>;
  /** What to do about a missing field, by its path without the leading slash. */
  hints?: Readonly<Record<string, string>>;
};

/** A file's problems, one a line; a worded one, with no path, as it is. */
export function describeProblems(file: string, problems: readonly Problem[]): string {
  return [
    `${file} is not valid:`,
    ...problems.map((p) => `  ${p.path ? `${p.path}: ` : ""}${p.message}`),
  ].join("\n");
}

type Node = Record<string, unknown>;

const segments = (pointer: string) =>
  pointer
    .split("/")
    .filter((s) => s !== "" && s !== "#")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

function at(root: unknown, pointer: string): unknown {
  let node = root;
  for (const s of segments(pointer)) node = (node as Node | undefined)?.[s];
  return node;
}

/** A path as said in a line: `sandbox`, `agentReach/network/0`; the root as "". */
const field = (path: string) => segments(path).join("/");

const shown = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** One of a union's members, as an example of it: `"workflow"`, `{ "lab": "srt" }`. */
function sample(member: Node): string {
  if ("const" in member) return JSON.stringify(member.const);
  const properties = member.properties as Record<string, Node> | undefined;
  if (member.type === "object" && properties) {
    const required = (member.required as string[] | undefined) ?? Object.keys(properties);
    const shown = required.map(
      (name) =>
        `"${name}": ${"const" in properties[name]! ? JSON.stringify(properties[name]!.const) : "…"}`,
    );
    return `{ ${shown.join(", ")} }`;
  }
  return typeof member.type === "string" ? `a ${member.type}` : "something else";
}

/** A member's description, to its first stop: "the lab's box". */
function gist(member: Node): string | undefined {
  if (typeof member.description !== "string") return undefined;
  const head = member.description.split(/[:.]/)[0]!.trim();
  return head ? head[0]!.toLowerCase() + head.slice(1) : undefined;
}

/**
 * A schema check's problems in words: an unknown field with the fields there are, a missing one
 * with what to do, a constant, a pattern's meaning, and a union's members in place of each
 * member's own complaint. What it has no words for stays as the check said it.
 */
export function explainProblems(problems: readonly Problem[], explain: Explain): Problem[] {
  const unions = problems
    .filter((p) => p.raw?.keyword === "anyOf")
    .map((p) => `${p.raw!.schemaPath}/anyOf/`);
  const lines: Problem[] = [];
  const say = (message: string) => lines.push({ path: "", message });
  for (const problem of problems) {
    const raw = problem.raw;
    const where = field(problem.path);
    if (!raw) {
      lines.push(problem);
      continue;
    }
    if (unions.some((u) => raw.schemaPath.startsWith(u))) continue;
    if (raw.keyword === "boolean" && raw.schemaPath.endsWith("/additionalProperties")) continue;
    const value = at(explain.value, problem.path);
    switch (raw.keyword) {
      case "anyOf": {
        const members = ((at(explain.schema, raw.schemaPath) as Node | undefined)?.anyOf ??
          []) as Node[];
        const each = members.map((m) => {
          const about = gist(m);
          return `${sample(m)}${about ? ` (${about})` : ""}`;
        });
        const listed =
          each.length > 1 ? `${each.slice(0, -1).join(", ")} or ${each.at(-1)}` : each.join("");
        say(`${where} ${JSON.stringify(value)}: ${listed}`);
        break;
      }
      case "additionalProperties": {
        const names = (raw.params.additionalProperties as string[] | undefined) ?? [];
        const properties = (at(explain.schema, raw.schemaPath) as Node | undefined)?.properties;
        const known = Object.keys((properties as Node | undefined) ?? {}).join(", ");
        const unknown = `unknown field ${names.join(", ")}`;
        say(
          where
            ? `${unknown} in ${where}; its fields: ${known}`
            : `${unknown}; ${explain.noun}'s fields: ${known}`,
        );
        break;
      }
      case "required": {
        for (const name of (raw.params.requiredProperties as string[] | undefined) ?? []) {
          const full = where ? `${where}/${name}` : name;
          const hint = explain.hints?.[full];
          say(`no ${full}${hint ? `: ${hint}` : ""}`);
        }
        break;
      }
      case "const":
        say(`${where} must be ${shown(raw.params.allowedValue)}`);
        break;
      case "pattern": {
        const meaning = explain.patterns?.[raw.params.pattern as string];
        if (meaning) say(`${where} is ${meaning}, not ${JSON.stringify(value)}`);
        else lines.push(problem);
        break;
      }
      default:
        lines.push(problem);
    }
  }
  return lines;
}
