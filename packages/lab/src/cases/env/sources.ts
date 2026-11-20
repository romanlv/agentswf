import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";

const SOURCE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_FILES = 5_000;

const inNodeModules = (file: string) => file.split(sep).includes("node_modules");

/**
 * The names found as no string literal in the workflow's source: its module's folder, and what
 * loaded since setup began from outside `node_modules`. Never what loaded before setup (`env.ts`
 * and its imports, which name the stages themselves) or a file of the dataset's folder.
 */
export function missingStageNames(
  names: readonly string[],
  moduleFile: string,
  loadedBefore: ReadonlySet<string>,
  datasetDir?: string,
): string[] {
  if (names.length === 0) return [];
  const own = (file: string) =>
    !loadedBefore.has(file) && !(datasetDir !== undefined && within(datasetDir, file));
  const files = new Set(sourceFiles(dirname(moduleFile)).filter(own));
  for (const file of Object.keys(require.cache)) {
    if (own(file) && !inNodeModules(file) && SOURCE.has(extname(file))) files.add(file);
  }
  const left = new Set(names);
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const name of left) {
      if ([`"${name}"`, `'${name}'`, `\`${name}\``].some((quoted) => text.includes(quoted))) {
        left.delete(name);
      }
    }
    if (left.size === 0) break;
  }
  return [...left];
}

const within = (dir: string, file: string) => {
  const path = relative(dir, file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
};

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      if (found.length >= MAX_FILES) return;
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(at, name);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(path);
      else if (SOURCE.has(extname(name))) found.push(path);
    }
  };
  walk(dir);
  return found;
}

/**
 * A module mocked in the code folder while the workflow loaded the same file from its copy in the
 * scratch folder: the mock misses it. Its path from the code folder; undefined when none.
 */
export function copiedModule(
  mocked: ReadonlySet<string>,
  root: string,
  scratch: string,
): string | undefined {
  if (root === scratch) return undefined;
  for (const file of mocked) {
    const path = relative(root, file);
    if (path.startsWith("..") || file.startsWith(scratch + sep)) continue;
    if (require.cache[join(scratch, path)]) return path;
  }
  return undefined;
}
