import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import manifest from "../package.json" with { type: "json" };
import { messageOf } from "./errors";
import type { Out } from "./run-commands";

export const initUsage = [
  "usage: awf init [dir] [--no-install]",
  "",
  "Sets up the current directory, or dir, for writing workflows: hello/workflow.ts, a workflow",
  "with one agent, and hello/workflow.test.ts, its test; package.json, tsconfig.json, .gitignore",
  "and AGENTS.md. Then runs bun install, unless --no-install, for editor types: awf runs a",
  "workflow against its own copies either way.",
  "",
  "Never overwrites. A file that exists is skipped, except that package.json gains the",
  "devDependencies and scripts it lacks and .gitignore the lines it lacks.",
].join("\n");

export type InitCommand = { dir: string; install: boolean };

/** `awf init`: a folder set up for writing workflows. */
export async function initCommand(
  argv: readonly string[],
  cwd: string,
  io: Out & { install?: (dir: string) => Promise<number> },
): Promise<number> {
  let command: InitCommand | "help";
  try {
    command = parseInitCommand(argv, cwd);
  } catch (error) {
    io.stderr(`awf: ${messageOf(error)}\n\n${initUsage}`);
    return 2;
  }
  if (command === "help") {
    io.stdout(initUsage);
    return 0;
  }
  try {
    return await runInit(command, cwd, io, io.install);
  } catch (error) {
    io.stderr(`awf: ${messageOf(error)}`);
    return 1;
  }
}

export function parseInitCommand(argv: readonly string[], cwd: string): InitCommand | "help" {
  let dir: string | undefined;
  let install = true;
  for (const option of argv) {
    if (option === "-h" || option === "--help") return "help";
    if (option === "--no-install") install = false;
    else if (option.startsWith("-")) throw new Error(`unknown option: ${option}`);
    else if (dir !== undefined) throw new Error(`one directory only, not ${dir} and ${option}`);
    else dir = option;
  }
  const path = resolve(cwd, dir ?? ".");
  if (existsSync(path) && !statSync(path).isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  return { dir: path, install };
}

const TEMPLATES = join(import.meta.dir, "init-template");

/** Copied as they are, each only where nothing is yet. */
const COPIED = ["hello/workflow.ts", "hello/workflow.test.ts", "tsconfig.json", "AGENTS.md"];

const SCRIPTS = { test: "awf test", check: "tsc --noEmit" };

// The versions this repository builds with; the root's catalog holds the same.
export const DEV_DEPENDENCIES = {
  "@types/bun": "^1.3.4",
  // agentswf is released at the engine's version; it can't be imported here, it imports the engine.
  agentswf: `^${manifest.version}`,
  typebox: manifest.dependencies.typebox,
  typescript: "^5.9.3",
};

const IGNORED = ["node_modules/", ".awf/"];

type Change = { path: string; change: "created" | "updated" | "skipped"; detail?: string };

/** A target init may write: absent, a file it reads or skips, or a symlink it never follows. */
type Target = "missing" | "file" | "symlink";

function targetOf(dir: string, path: string): Target {
  const stat = lstatSync(join(dir, path), { throwIfNoEntry: false });
  if (stat === undefined) return "missing";
  if (stat.isSymbolicLink()) return "symlink";
  if (!stat.isFile()) throw new Error(`${path} exists and is not a file`);
  return "file";
}

/**
 * Writes what `awf init` writes into `dir`, and says what it did to each file. Everything that
 * would stop it, such as a package.json that isn't a JSON object, is found before it writes.
 */
export function initFolder(dir: string): Change[] {
  for (const parent of new Set(COPIED.map(dirname))) {
    const stat = lstatSync(join(dir, parent), { throwIfNoEntry: false });
    if (stat !== undefined && !stat.isDirectory()) {
      throw new Error(`${parent} exists and is not a directory`);
    }
  }
  const targets = new Map(
    ["package.json", ".gitignore", ...COPIED].map((path) => [path, targetOf(dir, path)]),
  );
  const pkg = targets.get("package.json") === "file" ? readPackageJson(dir) : undefined;

  const changes: Change[] = [packageJson(dir, targets.get("package.json")!, pkg)];
  for (const path of COPIED) {
    const target = targets.get(path)!;
    if (target !== "missing") {
      changes.push({ path, change: "skipped", detail: skippedBecause(target) });
      continue;
    }
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    const template = readFileSync(join(TEMPLATES, `${path}.template`));
    writeFileSync(join(dir, path), template, { flag: "wx" });
    changes.push({ path, change: "created" });
  }
  changes.push(gitignore(dir, targets.get(".gitignore")!));
  return changes;
}

const skippedBecause = (target: Target) => (target === "symlink" ? "a symlink" : "exists");

function readPackageJson(dir: string): { text: string; value: Record<string, unknown> } {
  const text = readFileSync(join(dir, "package.json"), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`package.json is not JSON: ${(error as Error).message}`);
  }
  if (!isRecord(value)) throw new Error("package.json is not a JSON object");
  return { text, value };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function packageJson(
  dir: string,
  target: Target,
  pkg: { text: string; value: Record<string, unknown> } | undefined,
): Change {
  const path = join(dir, "package.json");
  if (target === "symlink") return { path: "package.json", change: "skipped", detail: "a symlink" };
  if (pkg === undefined) {
    const created = {
      name: packageName(dir),
      private: true,
      type: "module",
      scripts: SCRIPTS,
      devDependencies: DEV_DEPENDENCIES,
    };
    writeFileSync(path, `${JSON.stringify(created, null, 2)}\n`, { flag: "wx" });
    return { path: "package.json", change: "created" };
  }
  const { text, value: existing } = pkg;
  const record = (key: string): Record<string, unknown> => {
    const value = existing[key];
    return isRecord(value) ? value : {};
  };
  const scripts = record("scripts");
  const declared = {
    ...record("dependencies"),
    ...record("devDependencies"),
    ...record("peerDependencies"),
    ...record("optionalDependencies"),
  };
  const addedScripts = Object.entries(SCRIPTS).filter(([name]) => !(name in scripts));
  const addedDependencies = Object.entries(DEV_DEPENDENCIES).filter(
    ([name]) => !(name in declared),
  );
  if (addedScripts.length === 0 && addedDependencies.length === 0) {
    return { path: "package.json", change: "skipped", detail: "has what init adds" };
  }
  const updated = {
    ...existing,
    scripts: { ...scripts, ...Object.fromEntries(addedScripts) },
    devDependencies: { ...record("devDependencies"), ...Object.fromEntries(addedDependencies) },
  };
  const json = `${JSON.stringify(updated, null, indentOf(text))}\n`;
  writeFileSync(path, text.includes("\r\n") ? json.replaceAll("\n", "\r\n") : json);
  const added = [
    ...addedDependencies.map(([name]) => name),
    ...addedScripts.map(([name]) => `the ${name} script`),
  ];
  return { path: "package.json", change: "updated", detail: `added ${added.join(", ")}` };
}

function gitignore(dir: string, target: Target): Change {
  const path = join(dir, ".gitignore");
  if (target === "symlink") return { path: ".gitignore", change: "skipped", detail: "a symlink" };
  if (target === "missing") {
    writeFileSync(path, `${IGNORED.join("\n")}\n`, { flag: "wx" });
    return { path: ".gitignore", change: "created" };
  }
  const text = readFileSync(path, "utf8");
  const lines = new Set(text.split("\n").map((line) => line.trim().replace(/^\/|\/$/g, "")));
  const missing = IGNORED.filter((line) => !lines.has(line.replace(/\/$/, "")));
  if (missing.length === 0) return { path: ".gitignore", change: "skipped", detail: "has both" };
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const separator = text === "" || text.endsWith("\n") ? "" : newline;
  writeFileSync(path, `${text}${separator}${missing.join(newline)}${newline}`);
  return { path: ".gitignore", change: "updated", detail: `added ${missing.join(", ")}` };
}

/** A valid npm name from the folder's, which is all a private package's name has to be. */
function packageName(dir: string): string {
  const name = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 214)
    .replace(/^[._-]+|-+$/g, "");
  return name || "workflows";
}

function indentOf(text: string): string | number {
  return /^\{\s*\r?\n([ \t]+)"/.exec(text)?.[1] ?? 2;
}

/** As a shell reads it: bare when that's safe, otherwise single-quoted. */
function shellWord(word: string): string {
  return /^[\w./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** `awf init`: writes the folder, installs unless told not to, and says what to run next. */
export async function runInit(
  command: InitCommand,
  cwd: string,
  output: { stdout(text: string): void; stderr(text: string): void },
  install: (dir: string) => Promise<number> = bunInstall,
): Promise<number> {
  mkdirSync(command.dir, { recursive: true });
  const changes = initFolder(command.dir);
  const installed = command.install ? (await install(command.dir)) === 0 : undefined;
  const width = Math.max(...changes.map(({ change }) => change.length));
  const lines = changes.map(
    ({ path, change, detail }) =>
      `${change.padEnd(width)}  ${path}${detail === undefined ? "" : ` (${detail})`}`,
  );
  const into = relative(cwd, command.dir);
  const next = [
    ...(into === "" ? [] : [`cd ${shellWord(into)}`]),
    ...(installed ? [] : ["bun install"]),
    "awf test                     # scripted agents: free, no agent starts",
    "awf run hello/workflow.ts    # one real codex agent",
  ];
  output.stdout([...lines, "", "next:", ...next.map((line) => `  ${line}`)].join("\n"));
  if (installed === false) {
    output.stderr("awf: bun install failed; the files are written, run it again there");
    return 1;
  }
  return 0;
}

async function bunInstall(dir: string): Promise<number> {
  const child = Bun.spawn([process.execPath, "install"], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}
