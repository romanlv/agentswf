import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CONFIG_FILE,
  REVIEW_FIELDS,
  WORKSPACE_KIND,
  type WorkspaceConfig,
  WorkspaceSchema,
} from "./config";
import { checkSchema, describeProblems } from "./validate";

/**
 * `--config`, or the nearest `awf-lab.json` from `cwd` up, as git finds its repository: in a
 * folder, or in its `evals/`, where a project keeps its cases.
 */
export function findConfigFile(cwd: string, explicit?: string): string | undefined {
  if (explicit) return resolve(cwd, explicit);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_FILE))) return join(dir, CONFIG_FILE);
    if (existsSync(join(dir, "evals", CONFIG_FILE))) return join(dir, "evals", CONFIG_FILE);
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The file, checked. A `/0` workspace or one holding the review kind's fields is refused by name:
 * neither is converted.
 */
export function readConfigFile(file: string): WorkspaceConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} is not a JSON object`);
  }
  const fields = REVIEW_FIELDS.filter((name) => name in raw);
  if (fields.length > 0) {
    throw new Error(
      `${file} is the review kind's (${fields.join(", ")}), which is retired: a workspace of cases holds kind, judgeAgent, store, records and hide`,
    );
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (kind !== WORKSPACE_KIND) {
    throw new Error(
      kind === "awf.lab-workspace/0"
        ? `${file}: awf.lab-workspace/0 is retired; make it "kind": "${WORKSPACE_KIND}"`
        : `${file} needs "kind": "${WORKSPACE_KIND}"`,
    );
  }
  const checked = checkSchema(WorkspaceSchema, raw);
  if (!checked.ok) throw new Error(describeProblems(file, checked.problems));
  return checked.value;
}
