import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE, type CommonConfig, CommonConfigSchema } from "./config";
import { checkSchema, describeProblems } from "./validate";

/**
 * `--config`, or the nearest `awf-lab.json` from `cwd` up, as git finds its repository: in a
 * folder, or in its `evals/`, where a project keeps its cases.
 */
export function findConfigFile(cwd: string, explicit?: string): string | undefined {
  return locateConfigFile(cwd, explicit)?.file;
}

/**
 * The file `findConfigFile` finds, and whether it was found in an `evals/` below a folder walked,
 * where only the case kind looks: the review kind reads the nearest `awf-lab.json` of a folder.
 */
export function locateConfigFile(
  cwd: string,
  explicit?: string,
): { file: string; inEvals: boolean } | undefined {
  if (explicit) return { file: resolve(cwd, explicit), inEvals: false };
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_FILE))) return { file: join(dir, CONFIG_FILE), inEvals: false };
    if (existsSync(join(dir, "evals", CONFIG_FILE))) {
      return { file: join(dir, "evals", CONFIG_FILE), inEvals: true };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** The file as JSON, and its common fields, checked. */
export function readConfigFile(file: string): {
  raw: Record<string, unknown>;
  common: CommonConfig;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} is not a JSON object`);
  }
  const checked = checkSchema(CommonConfigSchema, raw);
  if (!checked.ok) throw new Error(describeProblems(file, checked.problems));
  return { raw: raw as Record<string, unknown>, common: checked.value };
}
