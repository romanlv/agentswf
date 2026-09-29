import { realpathSync } from "node:fs";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".jsx": "jsx",
};

/** `roots` and every file they import by path, followed recursively. */
async function importGraph(roots: readonly string[]): Promise<Set<string>> {
  const files = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = await Bun.file(file).text();
    const loader = LOADERS[extname(file)];
    if (!loader) continue;
    for (const { path } of new Bun.Transpiler({ loader }).scanImports(source)) {
      if (path.startsWith(".") || path.startsWith("/")) {
        queue.push(Bun.resolveSync(path, dirname(file)));
      }
    }
  }
  return files;
}

/**
 * Where a variant or scorer came from: its file's repository at HEAD, and whether any file it
 * runs differs from it — the file, its workflow, and every file either imports by a relative path.
 * Provenance only: the version the file declares is its identity.
 */
export async function provenanceOf(file: string, run: { workflow: URL }) {
  const root = realpathSync(file);
  const workflow = realpathSync(fileURLToPath(run.workflow));
  return repository(root, [...(await importGraph([root, workflow]))]);
}

function git(cwd: string, args: string[]): string | null {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return run.exitCode === 0 ? run.stdout.toString().trim() : null;
}

/**
 * The file's repository at HEAD, and whether any covered file differs from it. Only the variant or
 * scorer file's repository has its commit kept; a workflow in another only counts toward dirty.
 */
function repository(file: string, covered: readonly string[]) {
  const commit = git(dirname(file), ["rev-parse", "HEAD"]);
  const dirty = covered.some((path) => {
    const status = git(dirname(path), ["status", "--porcelain", "--", path]);
    return status !== null && status !== "";
  });
  return { commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null, dirty };
}
