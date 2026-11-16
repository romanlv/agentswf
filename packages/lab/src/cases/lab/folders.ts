import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type CaseInfo,
  filesUnder,
  gitEntriesUnder,
  type KeyFile,
  refuseLinks,
  sha256,
} from "./dataset";
import { blobIdOf, blobIds, historyHolds } from "./git";
import { alive } from "./store";

const PREFIX = "awf-lab-case-";
const OWNER = "owner.json";

export type TrialFolders = { parent: string; dir: string; scratch: string };

/**
 * A trial's folders, outside every repository: a parent per trial holding its owner (the run's id
 * and this process), the built case folder and the empty scratch folder.
 */
export function makeTrialFolders(tmp: string, run: number): TrialFolders {
  const parent = realpathSync(mkdtempSync(join(tmp, PREFIX)));
  writeFileSync(join(parent, OWNER), JSON.stringify({ run, pid: process.pid }));
  const dir = join(parent, "case");
  const scratch = join(parent, "scratch");
  mkdirSync(dir);
  mkdirSync(scratch);
  return { parent, dir, scratch };
}

/** Removes trial folders whose process is gone; never one without an owner, or still owned. */
export function clearStale(tmp: string): number {
  if (!existsSync(tmp)) return 0;
  let removed = 0;
  for (const name of readdirSync(tmp)) {
    if (!name.startsWith(PREFIX)) continue;
    const owner = join(tmp, name, OWNER);
    try {
      const { pid } = JSON.parse(readFileSync(owner, "utf8")) as { pid?: unknown };
      if (typeof pid === "number" && !alive(pid)) {
        rmSync(join(tmp, name), { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}

/**
 * The built case folder: the dataset's shared `files/` and the case's own merged at its root, the
 * case's winning, plus `input.json`. Never `key.md` or `key/`.
 */
export function buildCase(datasetDir: string, info: CaseInfo, target: string): void {
  for (const from of [join(datasetDir, "files"), join(info.dir, "files")]) {
    refuseLinks(from);
    if (existsSync(from)) cpSync(from, target, { recursive: true, force: true });
  }
  const input = join(info.dir, "input.json");
  if (existsSync(input)) cpSync(input, join(target, "input.json"));
}

export type Needle = { marker: string; keyFiles: readonly KeyFile[] };

/**
 * Where the key turned up in a folder: a file holding the marker or a copy of a `key/` file, and
 * in each git repository inside it, any commit holding the marker or a `key/` file's blob. A
 * symlink is followed, as the workflow would read through it; a folder is walked once.
 */
export function searchFolder(dir: string, needle: Needle, label: string): string[] {
  const found: string[] = [];
  if (!existsSync(dir)) return found;
  const marker = Buffer.from(needle.marker);
  const sizes = new Set(needle.keyFiles.map((k) => k.size));
  const digests = new Map(needle.keyFiles.map((k) => [k.digest, k]));
  for (const file of filesUnder(dir, { skip: (name) => name === ".git", follow: true })) {
    const size = statSync(file).size;
    const bytes = readFileSync(file);
    const where = `${label}/${relative(dir, file)}`;
    if (bytes.includes(marker)) found.push(`the marker in ${where}`);
    if (sizes.has(size)) {
      const copy = digests.get(sha256(bytes));
      if (copy) found.push(`a copy of key file ${basename(copy.path)} at ${where}`);
    }
  }
  for (const repository of gitEntriesUnder(dir).map((git) => dirname(git))) {
    const where = `${label}/${relative(dir, repository) || "."}`;
    if (historyHolds(repository, needle.marker)) found.push(`the marker in a commit of ${where}`);
    if (needle.keyFiles.length > 0) {
      const blobs = blobIds(repository);
      for (const key of needle.keyFiles) {
        if (blobs.has(blobIdOf(key.bytes))) found.push(`a key/ file in a commit of ${where}`);
      }
    }
  }
  return found;
}

/** Whether `text` holds the marker or a `key/` file's whole text. */
export function searchText(text: string, needle: Needle, label: string): string[] {
  const found: string[] = [];
  if (text.includes(needle.marker)) found.push(`the marker in ${label}`);
  for (const key of needle.keyFiles) {
    const content = Buffer.from(key.bytes).toString("utf8");
    if (content.trim().length >= 16 && text.includes(content.trim())) {
      found.push(`a key/ file's text in ${label}`);
    }
  }
  return found;
}

/**
 * Copies the scratch folder's files `keep` names into `target`, a symlink as the file it names;
 * returns their paths. A path outside the scratch folder is never kept.
 */
export function keepFiles(scratch: string, patterns: readonly string[], target: string): string[] {
  const kept = new Set<string>();
  for (const pattern of patterns) {
    for (const path of new Bun.Glob(pattern).scanSync({
      cwd: scratch,
      dot: true,
      onlyFiles: true,
      followSymlinks: true,
    })) {
      const from = resolve(scratch, path);
      const within = relative(scratch, from);
      if (within === "" || within.startsWith("..") || isAbsolute(within)) continue;
      try {
        if (!statSync(from).isFile()) continue;
      } catch {
        continue;
      }
      kept.add(within);
    }
  }
  for (const path of kept) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    cpSync(join(scratch, path), join(target, path), { dereference: true });
  }
  return [...kept].sort();
}
