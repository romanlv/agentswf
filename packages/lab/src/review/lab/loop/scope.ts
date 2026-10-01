import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** What a candidate may import: the author surface `awf run` serves to a workflow in any folder. */
export const ALLOWED_IMPORTS = ["agentswf/workflow", "typebox", "typebox/value"] as const;

/** Reaches past the agents it opens: a candidate reviews only through them. */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/\bBun\./, "Bun's API"],
  [/\bprocess\./, "the process"],
  [/\bfetch\s*\(/, "the network"],
  [/\brequire\s*\(/, "require"],
  [/\bimport\s*\(/, "a dynamic import"],
  [/\beval\s*\(/, "eval"],
  [/\bnew\s+Function\b/, "new Function"],
  [/\bglobalThis\b/, "globalThis"],
];

const MAX_BYTES = 100_000;

/**
 * Why a proposer's candidate folder is out of scope, or nothing when it is in: one file,
 * `workflow.ts`, importing only the author surface, reaching nothing but its agents, and naming no
 * path from the tuning cases' keys, so it cannot be fitted to them by copying. The container is
 * the boundary; this keeps a try to the change it claims.
 */
export function outOfScope(
  dir: string,
  tuningPaths: Iterable<string>,
  tuningText: Iterable<string> = [],
): string[] {
  const entries = readdirSync(dir);
  const problems = entries
    .filter((entry) => entry !== "workflow.ts")
    .map((entry) => `${entry}: a candidate is workflow.ts alone`);
  if (!entries.includes("workflow.ts")) return [...problems, "no workflow.ts"];
  const file = join(dir, "workflow.ts");
  if (statSync(file).size > MAX_BYTES)
    return [...problems, `workflow.ts is over ${MAX_BYTES} bytes`];
  const source = readFileSync(file, "utf8");
  const imports =
    /\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(imports)) {
    const name = match[1] ?? match[2]!;
    if (!(ALLOWED_IMPORTS as readonly string[]).includes(name)) {
      problems.push(`imports ${name}: only ${ALLOWED_IMPORTS.join(", ")}`);
    }
  }
  // Code, not the prompts it sends: a reviewer may well be told to "check the process."
  const code = withoutText(source);
  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(code)) problems.push(`uses ${what}`);
  }
  for (const path of new Set(tuningPaths)) {
    // A bare name such as README.md is any repository's; a path with a folder is the case's.
    if (path.includes("/") && source.includes(path))
      problems.push(`names ${path}, from a tuning case`);
  }
  const flat = source.replace(/\s+/g, " ").toLowerCase();
  for (const text of new Set(tuningText)) {
    const words = text.replace(/\s+/g, " ").toLowerCase();
    for (let at = 0; at + PASTE <= words.length; at += PASTE / 4) {
      if (flat.includes(words.slice(at, at + PASTE))) {
        problems.push(`copies a tuning key's words: "${words.slice(at, at + PASTE)}"`);
        break;
      }
    }
  }
  return problems;
}

/** A run of a key's text this long in a candidate is copied, not written. */
const PASTE = 40;

/** The source with its comments and string and template literals blanked. */
function withoutText(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g,
    '""',
  );
}
