import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../fixtures/set";
import type { Identity } from "../format/scoring";

/**
 * What the identity hash covers, version 1: the variant or scorer file's contents, its workflow's
 * contents, its argv and timeout, and the contents of every file either imports by a relative
 * path, followed recursively; packages imported by name, the package itself through a tsconfig
 * alias included, are recorded by name, not contents. No path is covered: an import's specifier is
 * in the importing file's contents, so the graph's shape is, but not where it sits. Provenance
 * only: results belong to the version the file declares, and records with several hashes under one
 * version show an edit that kept it. Not covered: a skill directory named only at run time, and the
 * engine itself, its model aliases included.
 */
export const IDENTITY_SCHEME = "v1";

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".jsx": "jsx",
};

/** Every file `roots` import by path, with its contents, and every package they import by name. */
async function importGraph(roots: readonly string[]) {
  const files = new Map<string, string>();
  const packages = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    const source = await Bun.file(file).text();
    files.set(file, source);
    const loader = LOADERS[extname(file)];
    if (!loader) continue;
    for (const { path } of new Bun.Transpiler({ loader }).scanImports(source)) {
      if (path.startsWith(".") || path.startsWith("/")) {
        queue.push(Bun.resolveSync(path, dirname(file)));
      } else packages.add(path);
    }
  }
  return { files, packages };
}

export type Hashed = Omit<Identity, "name"> & { files: string[] };

/** A variant's or scorer's identity: the hash, and whether the files it covers are committed. */
export async function identityOf(
  file: string,
  run: { workflow: URL; argv: readonly string[]; timeout: string },
): Promise<Hashed> {
  const root = realpathSync(file);
  const workflow = realpathSync(fileURLToPath(run.workflow));
  const { files, packages } = await importGraph([root, workflow]);
  const digest = (source: string) => createHash("sha256").update(source).digest("hex");
  const content = canonicalJson({
    scheme: IDENTITY_SCHEME,
    self: digest(files.get(root)!),
    workflow: digest(files.get(workflow)!),
    argv: run.argv,
    timeout: run.timeout,
    files: [...files.values()].map(digest).sort(),
    packages: [...packages].sort(),
  });
  const hash = `${IDENTITY_SCHEME}-${digest(content).slice(0, 16)}`;
  return { hash, ...repository(root, [...files.keys()]), files: [...files.keys()] };
}

function git(cwd: string, args: string[]): string | null {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return run.exitCode === 0 ? run.stdout.toString().trim() : null;
}

/**
 * The file's repository at HEAD, and whether any covered file differs from it. Only the variant or
 * scorer file's repository has its commit kept; a workflow in another is covered by its contents.
 */
function repository(file: string, covered: readonly string[]) {
  const commit = git(dirname(file), ["rev-parse", "HEAD"]);
  const dirty = covered.some((path) => {
    const status = git(dirname(path), ["status", "--porcelain", "--", path]);
    return status !== null && status !== "";
  });
  return { commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null, dirty };
}

/** The seeded order's key for a case id. */
export function rankOf(seed: string): (id: string) => string {
  return (id) => createHash("sha256").update(`${seed}\n${id}`).digest("hex");
}

/** SHA-256 of a value as canonical JSON, as a key's digest is recorded. */
export function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
