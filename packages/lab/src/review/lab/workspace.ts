import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkSchema, describeProblems } from "../format/validate";
import {
  RENAMED_CONFIG_KEYS,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
} from "../format/workspace";

const CONFIG_FILE = "awf-lab.json";
const PANEL_FILE = join(import.meta.dir, "panel.scorer.ts");

/** The config with its paths resolved, and the variants and scorers it finds, by name. */
export type Workspace = {
  file: string;
  config: WorkspaceConfig;
  clone: string;
  datasets: string;
  results: string;
  runs: string;
  variants: Map<string, string>;
  scorers: Map<string, string>;
};

/** A config in the first form's keys: the operator's to fix, as a usage error is. */
export class RenamedConfigKeys extends Error {}

/** `--config`, or the nearest `awf-lab.json` from `cwd` up, as git finds its repository. */
export function findConfig(cwd: string, explicit?: string): string {
  if (explicit) return resolve(cwd, explicit);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_FILE))) return join(dir, CONFIG_FILE);
    if (dirname(dir) === dir) {
      throw new Error(`no ${CONFIG_FILE} here or above ${cwd}; give one with --config`);
    }
  }
}

export async function openWorkspace(file: string): Promise<Workspace> {
  let raw: unknown;
  try {
    raw = await Bun.file(file).json();
  } catch (error) {
    throw new Error(`${file}: ${String(error)}`);
  }
  const renamed = Object.keys(typeof raw === "object" && raw !== null ? raw : {}).filter((key) =>
    Object.hasOwn(RENAMED_CONFIG_KEYS, key),
  );
  if (renamed.length > 0) {
    throw new RenamedConfigKeys(
      `${file}: ${renamed.map((key) => `"${key}" is now "${RENAMED_CONFIG_KEYS[key]}"`).join(", ")}`,
    );
  }
  const checked = checkSchema(WorkspaceConfigSchema, raw);
  if (!checked.ok) throw new Error(describeProblems(file, checked.problems));
  const config = checked.value;
  const root = dirname(file);
  const scorers = await discover(root, config.scorers, ".scorer.ts");
  if (scorers.has("panel")) throw new Error(`a scorer named panel shadows the package's own`);
  scorers.set("panel", PANEL_FILE);
  return {
    file,
    config,
    clone: resolve(root, config.clone),
    datasets: resolve(root, config.datasets),
    results: resolve(root, config.results),
    runs: resolve(root, config.runs),
    variants: await discover(root, config.variants, ".variant.ts"),
    scorers,
  };
}

/** Files the globs match, named by their stem; two files with one name are an error, not a guess. */
async function discover(root: string, globs: readonly string[], suffix: string) {
  const found = new Map<string, string>();
  for (const pattern of globs) {
    for await (const match of new Bun.Glob(pattern).scan({ cwd: root, absolute: true })) {
      if (!match.endsWith(suffix)) continue;
      const name = basename(match, suffix);
      const earlier = found.get(name);
      if (earlier && earlier !== match) {
        throw new Error(`two files are named ${name}: ${earlier} and ${match}`);
      }
      found.set(name, match);
    }
  }
  return new Map([...found].toSorted(([a], [b]) => a.localeCompare(b)));
}

/** A name the workspace knows, or a path to a file anywhere, as an idea outside the globs is. */
export function resolveFile(
  known: ReadonlyMap<string, string>,
  nameOrPath: string,
  cwd: string,
  kind: "variant" | "scorer",
): { name: string; file: string } {
  if (nameOrPath.includes("/") || nameOrPath.endsWith(".ts")) {
    const file = resolve(cwd, nameOrPath);
    if (!existsSync(file)) throw new Error(`no ${kind} file ${file}`);
    const name = basename(file).replace(/\.(variant|scorer)\.ts$|\.ts$/, "");
    // Results are kept by name and version, so two files under one name would mix theirs.
    const same = known.get(name);
    if (same && realpathSync(same) !== realpathSync(file)) {
      throw new Error(`${file} is named ${name}, as ${same} is; rename one, or their results mix`);
    }
    return { name, file };
  }
  const file = known.get(nameOrPath);
  if (!file) {
    throw new Error(
      `no ${kind} named ${nameOrPath}; known: ${[...known.keys()].join(", ") || "none"}`,
    );
  }
  return { name: nameOrPath, file };
}
