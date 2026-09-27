import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SANDBOX_ENVIRONMENTS, type SandboxEnvironmentKey } from "@wf/contract/workflow";
import type { Gitdir, ResolvedSandbox, SandboxProviders } from "./seam";

const REACH_KEYS = ["read", "write", "network"] as const;

export type SandboxResolution = {
  /** The environment key the sandbox runs under: the one the spec named, else the default. */
  provider: SandboxEnvironmentKey;
  sandbox: ResolvedSandbox<unknown>;
};

export type ResolveOptions = {
  key: string;
  /** What a relative `cwd` resolves against, and the sandbox's `cwd` when the spec names none. */
  cwd: string;
  /** Every run's directory: no sandbox path may be, contain or lie inside it. */
  runRoot: string;
  providers: SandboxProviders;
  /** An agent's private spec, which may not carry `key` or `cwd`. */
  inline?: boolean;
  /** The operator's home, for `~`. */
  home?: string;
  /** The operator's harness state, where its environment put it: no sandbox path may overlap it. */
  harnessState: readonly string[];
  /**
   * Where the engine keeps every run's doors: `/tmp`, holding an `awf-*` directory per run. No
   * sandbox path may contain it, or lie in one of those directories: an agent could rewrite
   * another agent's launcher, which runs on the host.
   */
  controlRoot?: string;
};

/**
 * Checks an author's spec the way the types would, since a workflow is untyped at run time, and
 * resolves its paths once, at open: a sandbox holds what they named then, whatever moves later.
 */
export async function resolveSandbox(
  spec: unknown,
  options: ResolveOptions,
): Promise<SandboxResolution> {
  if (!isRecord(spec)) throw new Error("a sandbox spec must be an object");
  const allowed = new Set<string>([
    ...REACH_KEYS,
    ...SANDBOX_ENVIRONMENTS,
    ...(options.inline ? [] : ["key", "cwd"]),
  ]);
  for (const key of Object.keys(spec)) {
    if (allowed.has(key)) continue;
    throw new Error(
      options.inline && (key === "key" || key === "cwd" || key === "provider")
        ? `an agent's inline sandbox cannot name ${key}; open a sandbox and pass its ref to share one`
        : `unknown sandbox field ${JSON.stringify(key)}`,
    );
  }
  const named = SANDBOX_ENVIRONMENTS.filter((key) => spec[key] !== undefined);
  if (named.length > 1) {
    throw new Error(`a sandbox has one environment, not ${named.join(" and ")}`);
  }
  const provider = named[0] ?? options.providers.default;
  if (provider === undefined) throw new Error("no sandbox provider is installed");
  const installed = options.providers.installed[provider];
  if (!installed) {
    const why = options.providers.unavailable?.[provider];
    throw new Error(
      `the ${provider} sandbox provider is not ${why ? `usable: ${why}` : "installed"}`,
    );
  }
  const environment = installed.environment(named[0] === undefined ? {} : spec[named[0]]);

  const home = await realpath(options.home ?? homedir());
  const runRoot = await realpath(options.runRoot);
  const controlRoot =
    options.controlRoot === undefined
      ? undefined
      : await realpath(options.controlRoot).catch(() => options.controlRoot);
  const harnessState = await Promise.all(
    options.harnessState.map((path) => realpath(path).catch(() => path)),
  );
  const forbidden = (path: string, field: string) => {
    if (contains(path, home)) throw new Error(`sandbox ${field} ${path} would expose ~`);
    if (contains(path, runRoot) || contains(runRoot, path)) {
      throw new Error(`sandbox ${field} ${path} would expose the run root`);
    }
    // Code the host runs and every past transcript (story 004, "A fresh harness home").
    const state = harnessState.find((root) => contains(path, root) || contains(root, path));
    if (state) throw new Error(`sandbox ${field} ${path} would expose harness state ${state}`);
    const keys = KEY_DIRECTORIES.map((name) => join(home, name)).find(
      (root) => contains(path, root) || contains(root, path),
    );
    if (keys) throw new Error(`sandbox ${field} ${path} would expose keys in ${keys}`);
    if (controlRoot && (contains(path, controlRoot) || insideDoors(controlRoot, path))) {
      throw new Error(`sandbox ${field} ${path} would expose the engine's doors`);
    }
    return path;
  };
  const cwd = forbidden(
    await resolvePath(spec.cwd === undefined ? "." : spec.cwd, options.cwd, home, "cwd"),
    "cwd",
  );
  const paths = (field: "read" | "write") =>
    Promise.all(
      list(spec[field], field).map(async (path) =>
        forbidden(await resolvePath(path, cwd, home, field), field),
      ),
    );
  const write = unique(await paths("write"));
  const read = unique(await paths("read")).filter((path) => !write.includes(path));
  const network = unique(
    list(spec.network, "network").map((domain) => {
      if (!isDomain(domain)) throw new Error(`not a sandbox domain: ${JSON.stringify(domain)}`);
      return domain.toLowerCase();
    }),
  );
  // The most specific path naming a directory decides whether it is writable.
  const writableAt = (path: string) => writableIn({ read, write }, path);
  /** Each gitdir, and whether a writable worktree reaches it as its own or as a linked one's. */
  const gitdirs = new Map<string, { own: boolean; linked: boolean }>();
  const add = (repository: Repository, path: string) => {
    // Writable only when the whole worktree is: `write: ["out"]` must not let an agent move
    // the repository's branches or stage what the operator commits next.
    const writable = writableAt(repository.root);
    repository.gitdirs.forEach((gitdir, index) => {
      forbidden(gitdir, `gitdir of ${path}`);
      const via = gitdirs.get(gitdir) ?? { own: false, linked: false };
      // A linked worktree's common gitdir is its second.
      if (writable && index === 1) via.linked = true;
      else if (writable) via.own = true;
      gitdirs.set(gitdir, via);
    });
  };
  for (const path of [cwd, ...read, ...write]) {
    const repository = await repositoryOf(path, home);
    if (repository) add(repository, path);
  }
  // A clone inside a writable path is as writable as its hooks: its gitdir is guarded too. One
  // whose gitdir lies outside is refused, never added: a pointer an earlier agent wrote would
  // widen the reach to wherever it names. One whose gitdir is gone points nowhere to guard.
  for (const root of write) {
    for (const nested of await nestedRepositories(root)) {
      const repository = await repositoryOf(nested, home).catch(() => undefined);
      if (!repository) continue;
      const outside = repository.gitdirs.find((gitdir) => !write.some((w) => contains(w, gitdir)));
      if (outside) {
        throw new Error(
          `sandbox write ${root} holds ${nested}, whose gitdir ${outside} is outside it: write that too, or remove its .git`,
        );
      }
      add(repository, nested);
    }
  }
  return {
    provider,
    sandbox: {
      key: options.key,
      cwd,
      read,
      write,
      network,
      gitdirs: [...gitdirs].map(([path, { own, linked }]): Gitdir => {
        // A submodule's gitdir is in its superproject's `modules`, which is guarded whole: it is
        // committed in under no provider, whether that superproject is in reach or not.
        const module =
          path.includes("/.git/modules/") ||
          [...gitdirs.keys()].some((other) => contains(join(other, "modules"), path));
        return {
          path,
          writable: (own || linked) && !module,
          ...(linked && !own && !module ? { linked: true as const } : {}),
        };
      }),
      environment,
    },
  };
}

/**
 * Whether `path` is writable in this reach: the most specific of `read` and `write` holding it
 * decides. The working directory is readable, but never more specific than a `write` holding it.
 */
export function writableIn(
  reach: { read: readonly string[]; write: readonly string[] },
  path: string,
): boolean {
  const deepest = [...reach.read, ...reach.write]
    .filter((root) => contains(root, path))
    .sort((a, b) => b.length - a.length)[0];
  return deepest !== undefined && reach.write.includes(deepest);
}

/** Whether `path` lies in one of the engine's run directories under its control root. */
function insideDoors(controlRoot: string, path: string): boolean {
  if (path === controlRoot || !contains(controlRoot, path)) return false;
  const [first = ""] = path.slice(controlRoot.length + 1).split("/");
  return first.startsWith("awf-");
}

/** Whether `path` is `root` or lies under it. Both are absolute and resolved. */
export function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Whether an agent at `path` sees it inside: under the sandbox's working directory or its reach. */
export function withinReach(sandbox: ResolvedSandbox<unknown>, path: string): boolean {
  return [sandbox.cwd, ...sandbox.read, ...sandbox.write].some((root) => contains(root, path));
}

/**
 * `registry.npmjs.org`, or `*.npmjs.org` for its subdomains. The last label is not a number in any
 * base a resolver reads (`10`, `0x7f000001`), so an address is not a name, and a wildcard needs a
 * name under a top-level domain, not the domain itself. Anything with a scheme, port or path has
 * characters no label has.
 */
export function isDomain(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253) return false;
  const wildcard = value.startsWith("*.");
  const labels = (wildcard ? value.slice(2) : value).split(".");
  return (
    labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
    !/^(\d+|0x[0-9a-f]*)$/i.test(labels.at(-1)!) &&
    (!wildcard || labels.length >= 2)
  );
}

/**
 * Directories under `~` that hold keys, which no sandbox path may include or lie in, under any
 * provider, nor a toolchain: OrbStack keeps its SSH key apart from its `bin/`.
 */
export const KEY_DIRECTORIES = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".docker",
  ".kube",
  ".orbstack/ssh",
] as const;

/** Directories a writable path is scanned through for repositories, beyond which it is refused. */
const SCAN_LIMIT = 100_000;

/**
 * The worktree roots below `root` that hold a `.git`, without entering a `.git`, `node_modules` or
 * a link. Refuses a tree too large to scan, rather than leave a repository in it unguarded.
 */
async function nestedRepositories(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue = [root];
  for (let scanned = 0; queue.length > 0; scanned++) {
    if (scanned === SCAN_LIMIT) {
      throw new Error(
        `sandbox write ${root} holds over ${SCAN_LIMIT} directories to check for repositories; name a narrower one`,
      );
    }
    const directory = queue.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === ".git") {
        if (directory !== root) found.push(directory);
      } else if (entry.isDirectory() && entry.name !== "node_modules") {
        queue.push(join(directory, entry.name));
      }
    }
  }
  return found;
}

type Repository = { root: string; gitdirs: string[] };

/**
 * The repository a path belongs to: its worktree's root, and the git directories git reads there,
 * which may lie outside it: a `.git` directory, or a worktree's own gitdir and its common one.
 * Read from the files git reads, without running git. The walk up stops below `home`, so a
 * dotfiles repository at `~` is never the one a path belongs to.
 */
export async function repositoryOf(path: string, home: string): Promise<Repository | undefined> {
  for (let at = path; !contains(at, home); at = dirname(at)) {
    const dotGit = join(at, ".git");
    const found = await stat(dotGit).catch(() => undefined);
    if (found?.isDirectory()) return { root: at, gitdirs: [await realpath(dotGit)] };
    if (found?.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
      if (!pointer) throw new Error(`${dotGit} names no gitdir`);
      const gitdir = await realpath(resolve(at, pointer)).catch(() => {
        throw new Error(`${dotGit} names ${pointer}, which is gone: git worktree prune`);
      });
      const common = await readFile(join(gitdir, "commondir"), "utf8").catch(() => undefined);
      return {
        root: at,
        gitdirs:
          common === undefined
            ? [gitdir]
            : [gitdir, await realpath(resolve(gitdir, common.trim()))],
      };
    }
    if (dirname(at) === at) break;
  }
  return undefined;
}

async function resolvePath(
  path: unknown,
  base: string,
  home: string,
  field: string,
): Promise<string> {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error(`sandbox ${field} needs a non-empty path, not ${JSON.stringify(path)}`);
  }
  if (path.startsWith("~") && path !== "~" && !path.startsWith("~/")) {
    throw new Error(`sandbox ${field} ${path}: only ~ and ~/ expand, to the operator's home`);
  }
  const expanded = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
  const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded);
  try {
    return await realpath(absolute);
  } catch {
    throw new Error(`sandbox ${field} ${path} does not exist`);
  }
}

function list(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`sandbox ${field} must be a list`);
  return value;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
