import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkSchema, describeProblems } from "../format/validate";
import {
  RENAMED_CONFIG_KEYS,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
} from "../format/workspace";

const CONFIG_FILE = "awf-lab.json";
const MATCH_FILE = join(import.meta.dir, "match-first.scorer.ts");
const DEFAULT_COMPARISON_FILE = join(import.meta.dir, "default.compare.ts");

/** The config with its paths resolved, and the variants and scorers it finds, by name. */
export type Workspace = {
  file: string;
  /** With the scorer defaulted: the package's own, `match-first`. */
  config: WorkspaceConfig & { scorer: string };
  clone: string;
  datasets: string;
  results: string;
  runs: string;
  /** The provider of every trial's sandbox, as a sandbox spec names it. */
  sandbox: NonNullable<WorkspaceConfig["sandbox"]>;
  variants: Map<string, string>;
  scorers: Map<string, string>;
  comparisons: Map<string, string>;
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
  if (scorers.has("match-first")) {
    throw new Error(`a scorer named match-first shadows the package's own`);
  }
  scorers.set("match-first", MATCH_FILE);
  const comparisons = await discover(root, config.comparisons ?? [], ".compare.ts");
  if (comparisons.has("default")) {
    throw new Error(`a comparison named default shadows the package's own`);
  }
  comparisons.set("default", DEFAULT_COMPARISON_FILE);
  return {
    file,
    config: { ...config, scorer: config.scorer ?? "match-first" },
    clone: resolve(root, config.clone),
    datasets: resolve(root, config.datasets),
    results: resolve(root, config.results),
    runs: resolve(root, config.runs),
    sandbox: config.sandbox ?? { srt: {} },
    variants: await discover(root, config.variants, ".variant.ts"),
    scorers,
    comparisons,
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
  kind: "variant" | "scorer" | "comparison",
): { name: string; file: string } {
  if (nameOrPath.includes("/") || nameOrPath.endsWith(".ts")) {
    const file = resolve(cwd, nameOrPath);
    if (!existsSync(file)) throw new Error(`no ${kind} file ${file}`);
    const name = basename(file).replace(/\.(variant|scorer|compare)\.ts$|\.ts$/, "");
    // Results are kept by name and version, so two files under one name would mix theirs; a
    // report names the comparison that decided by its name, so two would read alike.
    const same = known.get(name);
    if (same && realpathSync(same) !== realpathSync(file)) {
      const harm =
        kind === "comparison" ? "a report couldn't tell them apart" : "their results mix";
      throw new Error(`${file} is named ${name}, as ${same} is; rename one, or ${harm}`);
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
