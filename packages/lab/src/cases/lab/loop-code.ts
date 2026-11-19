import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { CaseInfo } from "./dataset";
import { git } from "./git";
import type { CaseWorkspace } from "./workspace";

// A loop's code: the start copied from your checkout, each try a clone of its parent's committed
// with the proposer's change, and the scope check read from that commit.

/** A run of this many characters of a tuning key's text in changed code is copied, not written. */
export const PASTE = 40;

/**
 * The `node_modules` folders git ignores under `top`, linked into `code` at the same paths: a copy
 * runs on your install, as an `--against` worktree runs on its own.
 */
function linkInstalls(top: string, code: string): void {
  const listed = git(top, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  for (const path of listed.split("\0").filter(Boolean)) {
    const clean = path.replace(/\/$/, "");
    if (clean.split("/").at(-1) !== "node_modules") continue;
    const target = join(code, clean);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(join(top, clean)), target);
  }
  writeFileSync(join(code, ".git", "info", "exclude"), "node_modules\n");
}

/**
 * The start: what git would hold in your repository, less each dataset's cases, the records
 * folder and `hide`'s paths, copied into `code` and committed there, its installs linked.
 */
export function copyStart(
  top: string,
  code: string,
  workspace: CaseWorkspace,
  // A checkout of the same repository to copy from, such as a worktree at the loop's start commit.
  source = top,
): void {
  const listed = git(source, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const evals = relative(top, workspace.evals);
  const records = workspace.records ? relative(top, workspace.records) : undefined;
  // `hide`'s paths hold what the box hides as it does keys: a copy never has them.
  const hidden = (workspace.hide ?? []).map((h) => join(relative(top, workspace.root), h));
  const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
  const left = (path: string) =>
    hidden.some((dir) => under(path, dir)) ||
    (records !== undefined && (path === records || path.startsWith(`${records}/`))) ||
    (path.startsWith(`${evals}/`) && path.slice(evals.length + 1).split("/")[1] === "cases");
  mkdirSync(code, { recursive: true });
  for (const path of new Set(listed.split("\0").filter(Boolean))) {
    if (left(path)) continue;
    const from = join(source, path);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(from);
    } catch {
      continue; // deleted in the working tree
    }
    const to = join(code, path);
    mkdirSync(dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (stat.isFile()) copyFileSync(from, to);
  }
  git(code, ["init", "-q"]);
  linkInstalls(top, code);
  git(code, ["add", "-A"]);
  git(code, ["commit", "-q", "--allow-empty", "-m", "the start"]);
}

/** A try's code: a clone of its parent's, its installs linked as the start's. */
export function branchCode(parent: string, code: string, top: string): void {
  mkdirSync(dirname(code), { recursive: true });
  // Git's objects never change once written: the clone links them rather than copying.
  git(dirname(code), ["clone", "-q", parent, code]);
  git(code, ["remote", "remove", "origin"]);
  linkInstalls(top, code);
}

/**
 * What git doesn't see in a try's copy, which the scope check can't read: anything but the
 * installs linked as your checkout's. A try that writes code there, or replaces an install's link,
 * is refused.
 */
export function outsideGit(code: string, top: string): string[] {
  const listed = git(code, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  const problems: string[] = [];
  for (const path of listed.split("\0").filter(Boolean)) {
    const clean = path.replace(/\/$/, "");
    const at = join(code, clean);
    const linked =
      clean.split("/").at(-1) === "node_modules" &&
      lstatSync(at).isSymbolicLink() &&
      existsSync(join(top, clean)) &&
      realpathSync(at) === realpathSync(join(top, clean));
    if (!linked) problems.push(`${clean}: outside git, so the scope check can't read it`);
  }
  return problems;
}

/** The paths a try changed, added, edited or deleted: its commit against its parent's. */
export function changedFiles(code: string): string[] {
  const listed = git(code, ["diff", "--name-only", "--no-renames", "-z", "HEAD~1", "HEAD"]);
  return [...new Set(listed.split("\0").filter(Boolean))].sort();
}

/** What a try may not have done, from its changed files: nothing when it is in scope. */
export function outOfScope(
  code: string,
  changed: readonly string[],
  evals: string,
  tuning: readonly CaseInfo[],
): string[] {
  if (changed.length === 0) return ["it changed nothing"];
  const problems: string[] = [];
  for (const path of changed) {
    if (path === evals || path.startsWith(`${evals}/`)) problems.push(`${path}: under ${evals}/`);
    if (path.split("/").includes("node_modules")) problems.push(`${path}: an install`);
  }
  const texts = tuning.flatMap((c) => keyTexts(c));
  const markers = tuning.map((c) => c.key.marker);
  for (const path of changed) {
    const file = join(code, path);
    if (!existsSync(file) || !lstatSync(file).isFile()) continue;
    const content = readFileSync(file, "utf8");
    for (const marker of markers) {
      if (content.includes(marker)) problems.push(`${path}: holds a tuning key's marker`);
    }
    const flat = content.replace(/\s+/g, " ").toLowerCase();
    const copied = texts.find((text) => {
      for (let at = 0; at + PASTE <= text.length; at += PASTE / 4) {
        if (flat.includes(text.slice(at, at + PASTE))) return true;
      }
      return false;
    });
    if (copied) problems.push(`${path}: copies a tuning key's words`);
  }
  return problems;
}

/** A key's own words, flattened: its note, criteria, expected strings and its `key/` files. */
function keyTexts(info: CaseInfo): string[] {
  const { key } = info;
  const values = Object.values(key.expect ?? {}).filter((v): v is string => typeof v === "string");
  return [info.note, ...(key.must ?? []), ...(key["must-not"] ?? []), ...values]
    .concat(info.keyFiles.map((f) => Buffer.from(f.bytes).toString("utf8")))
    .map((text) => text.replace(/\s+/g, " ").toLowerCase())
    .filter((text) => text.length >= PASTE);
}

/** The proposer's change, committed as the try, whatever it is: the scope check reads it. */
export function commitTry(code: string, n: number): void {
  git(code, ["add", "-A"]);
  git(code, ["commit", "-q", "--allow-empty", "-m", `try ${n}`]);
}

/** A try's own change, against its parent's code: what the records keep to build it again. */
export function changeOf(code: string): string {
  return git(code, ["diff", "--no-color", "--binary", "HEAD~1", "HEAD"]);
}

/** Builds a try's code again from its parent's and its change, as the records keep it. */
export function rebuildTry(parent: string, code: string, change: string, top: string, n: number) {
  branchCode(parent, code, top);
  if (change.trim() !== "") {
    try {
      git(code, ["apply", "--binary", "-"], change);
    } catch (error) {
      throw new Error(`try ${n}'s change doesn't apply: ${(error as Error).message}`);
    }
  }
  commitTry(code, n);
}

/** The kept code against the start, as a patch. */
export function patchOf(code: string): string {
  const root = git(code, ["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n")[0]!;
  return git(code, ["diff", "--no-color", root, "HEAD"]);
}
