// The global `awf`'s first step, before the engine is imported: a project whose installed `agentswf`
// is another version runs on that one (ADR 0015). Imports nothing of the engine, so a hand-over
// costs a Bun start and no more, and the engine's own checks can share how a project's engine is
// found.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The `agentswf` installed in a `node_modules` at or above a directory. */
export type InstalledEngine = {
  /** Its package's folder, its real path: what `AWF_ENGINE` names. */
  dir: string;
  /** The directory whose `node_modules` holds it: where its `awf` is run from. */
  root: string;
  /** Its `package.json`'s `version`, not the range a project declares. */
  version: string;
  /** Its `awf`, as its `package.json`'s `bin` gives it. */
  bin: string;
};

/**
 * A project's engine: installed, declared in the nearest `package.json` at or above it and not
 * installed (or installed broken), or none, which any engine runs.
 */
export type ProjectEngine =
  | ({ kind: "installed" } & InstalledEngine)
  | { kind: "declared"; manifest: string }
  | { kind: "none" };

/**
 * The `agentswf` found by walking up from `from` for `node_modules/agentswf/package.json`. Not
 * Bun's resolver, whose auto-install answers with a cache copy where nothing is installed. One
 * whose manifest gives no version or `awf` is broken, and its `package.json` is returned instead.
 */
export function installedEngine(from: string): InstalledEngine | undefined {
  const found = findEngine(from);
  return found && "version" in found ? found : undefined;
}

function findEngine(from: string): InstalledEngine | { broken: string } | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", "agentswf", "package.json");
    if (existsSync(manifest)) {
      const read = readManifest(manifest);
      const bin = typeof read?.bin === "object" ? read.bin?.awf : read?.bin;
      if (typeof read?.version !== "string" || typeof bin !== "string") return { broken: manifest };
      const root = realpathSync(dirname(manifest));
      return { dir: root, root: dir, version: read.version, bin: resolve(root, bin) };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * `project`'s engine: the one installed above it, else one the nearest `package.json` at or above
 * it declares.
 */
export function projectEngine(project: string): ProjectEngine {
  const found = findEngine(project);
  if (found && "broken" in found) return { kind: "declared", manifest: found.broken };
  if (found) return { kind: "installed", ...found };
  for (let dir = resolve(project); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const read = readManifest(manifest);
      const declared = ["dependencies", "devDependencies", "optionalDependencies"].some((field) => {
        const deps = read?.[field];
        return typeof deps === "object" && deps !== null && "agentswf" in deps;
      });
      return declared ? { kind: "declared", manifest } : { kind: "none" };
    }
    if (dirname(dir) === dir) return { kind: "none" };
  }
}

type Manifest = Record<string, unknown> & {
  version?: unknown;
  bin?: string | { awf?: unknown };
};

function readManifest(file: string): Manifest | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof value === "object" && value !== null ? (value as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

/** Set on an `awf` a hand-over runs: the engine it is, so that one doesn't hand over again. */
export const ENGINE_VARIABLE = "AWF_ENGINE";

/**
 * What the global `awf` does first: when the `agentswf` installed above the shell's directory is
 * another version than its own, it warns, runs that one's `awf` with the same argv, and exits as
 * it does. Returns when this `awf` runs the command itself. `init`, `help`, `--version` and
 * `tick --all` name no project's runs, and are never handed over.
 */
export async function handOver(own: {
  /** This `awf`'s `agentswf` folder. */
  dir: string;
  version: string;
  argv?: readonly string[];
  cwd?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  const argv = own.argv ?? process.argv.slice(2);
  const environment = own.environment ?? process.env;
  const target = handOverTarget(argv, own.cwd ?? process.cwd(), own.version);
  if (!target) return;
  // The child, walking from the same directory, finds itself; the guard is for a loop all the same.
  if (environment[ENGINE_VARIABLE] === realpathSync(own.dir)) return;
  process.stderr.write(
    `awf: awf ${own.version} is not this project's ${target.version}; running the project's. Update one, or run bunx awf here.\n`,
  );
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", target.bin, ...argv],
    env: { ...environment, [ENGINE_VARIABLE]: target.dir },
    stdio: ["inherit", "inherit", "inherit"],
  });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  // Each is forwarded, for a signal sent to this process alone. The terminal's Ctrl-C reaches the
  // child twice, through the process group too, and a run takes a repeat within a second as one;
  // the prompt comes back once the child has ended, not before.
  const listeners: [NodeJS.Signals, () => void][] = [
    ["SIGTERM", forward("SIGTERM")],
    ["SIGHUP", forward("SIGHUP")],
    ["SIGINT", forward("SIGINT")],
  ];
  for (const [signal, listener] of listeners) process.on(signal, listener);
  const code = await child.exited;
  for (const [signal, listener] of listeners) process.off(signal, listener);
  if (child.signalCode) process.kill(process.pid, child.signalCode);
  process.exit(code ?? 1);
}

/** The engine `argv`, typed in `cwd`, is handed over to; undefined when this one runs it. */
export function handOverTarget(
  argv: readonly string[],
  cwd: string,
  version: string,
): InstalledEngine | undefined {
  const [word] = argv;
  if (word === undefined || NOT_HANDED_OVER.has(word)) return undefined;
  if (word === "tick" && argv.includes("--all")) return undefined;
  const installed = installedEngine(cwd);
  return installed && installed.version !== version ? installed : undefined;
}

const NOT_HANDED_OVER = new Set(["init", "help", "-h", "--help", "--version"]);
