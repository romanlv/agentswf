import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { checkSchema, describeProblems, explainProblems } from "../../shared/validate";
import { parseKey } from "../format/key";
import {
  DATASET_KIND,
  type Dataset,
  DatasetSchema,
  type Key,
  passProblem,
  SETTINGS_PATTERNS,
} from "../format/settings";
import { Refusal } from "./refusal";

/** The file a dataset's own code graders are named exports of. */
export const GRADERS_FILE = "graders.ts";

export const DATASET_FILE = "dataset.json";
export const ENV_FILE = "env.ts";
export const KEY_FILE = "key.md";
/** The line `case new` writes into a stub `env.ts`; `run` refuses the file while it is there. */
export const STUB_LINE = "// awf-lab: a stub.";

export type DatasetInfo = { name: string; dir: string; dataset: Dataset };

/** A file of a case's `key/`: what the marker search looks for, by digest and blob id. */
export type KeyFile = { path: string; size: number; digest: string; bytes: Uint8Array };

export type CaseInfo = {
  name: string;
  dir: string;
  key: Key;
  note: string;
  keyFiles: KeyFile[];
};

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

function folders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Refusal(`${file}: ${(error as Error).message}`);
  }
}

/** The folders of `evals/` holding a `dataset.json` of this kind. */
export function discoverDatasets(evals: string): { name: string; dir: string }[] {
  return folders(evals).flatMap((name) => {
    const file = join(evals, name, DATASET_FILE);
    if (!existsSync(file)) return [];
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { kind?: unknown };
      return raw?.kind === DATASET_KIND ? [{ name, dir: join(evals, name) }] : [];
    } catch {
      // A broken file is still the dataset it names; reading it says what is wrong.
      return [{ name, dir: join(evals, name) }];
    }
  });
}

export function readDataset(name: string, dir: string): DatasetInfo {
  const file = join(dir, DATASET_FILE);
  const raw = readJson(file);
  const checked = checkSchema(DatasetSchema, raw);
  if (!checked.ok) {
    const problems = explainProblems(checked.problems, {
      schema: DatasetSchema,
      value: raw,
      noun: DATASET_FILE,
      patterns: SETTINGS_PATTERNS,
    });
    throw new Refusal(describeProblems(file, problems));
  }
  const dataset = checked.value;
  const pass = passProblem(dataset.pass);
  if (pass) throw new Refusal(`${file}: ${pass}`);
  const specs = graderSpecs({ name, dir, dataset });
  const code = specs.filter((s) => s.kind === "code").map((s) => s.name);
  if (code.length > 0 && !existsSync(join(dir, GRADERS_FILE))) {
    throw new Refusal(
      `${file}: graders names ${code.join(", ")}, and ${dir} has no ${GRADERS_FILE}`,
    );
  }
  for (const spec of specs) {
    if (spec.kind === "workflow" && !existsSync(spec.file)) {
      throw new Refusal(`${file}: graders: ${spec.file} doesn't exist`);
    }
  }
  for (const pattern of dataset.keep ?? []) {
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
      throw new Refusal(`${file}: keep ${pattern} reaches outside the scratch folder`);
    }
  }
  refuseLinks(join(dir, "files"));
  return { name, dir, dataset };
}

/** A dataset grader as `dataset.json` names it: a `graders.ts` export, or a grader workflow. */
export type GraderSpec =
  | { kind: "code"; name: string; onDemand: boolean }
  | {
      kind: "workflow";
      name: string;
      /** The workflow's file, inside the dataset's `graders/`. */
      file: string;
      readsFacts: boolean;
      onDemand: boolean;
      timeout?: string;
    };

/**
 * The dataset's graders, checked: a workflow's name is its path under `graders/` without `.ts`;
 * every name is unique, and never `expect` or `criteria`, which are the lab's own.
 */
export function graderSpecs(info: DatasetInfo): GraderSpec[] {
  const file = join(info.dir, DATASET_FILE);
  const graders = join(info.dir, "graders");
  const seen = new Set<string>();
  return (info.dataset.graders ?? []).map((entry): GraderSpec => {
    let spec: GraderSpec;
    if (typeof entry === "string" || "grader" in entry) {
      const name = typeof entry === "string" ? entry : entry.grader;
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
        throw new Refusal(`${file}: graders: ${name} is no export name of ${GRADERS_FILE}`);
      }
      spec = { kind: "code", name, onDemand: typeof entry !== "string" && entry.onDemand === true };
    } else {
      const path = join(info.dir, entry.workflow);
      const inside = relative(graders, path);
      if (
        inside.startsWith("..") ||
        isAbsolute(inside) ||
        entry.workflow.split(/[\\/]/).includes("..")
      ) {
        throw new Refusal(`${file}: graders: ${entry.workflow} is outside the dataset's graders/`);
      }
      spec = {
        kind: "workflow",
        name: inside.replace(/\.ts$/, ""),
        file: path,
        readsFacts: entry.readsFacts === true,
        onDemand: entry.onDemand === true,
        ...(entry.timeout ? { timeout: entry.timeout } : {}),
      };
    }
    if (spec.name === "expect" || spec.name === "criteria") {
      throw new Refusal(
        `${file}: graders: ${spec.name} is the lab's own; name your grader otherwise`,
      );
    }
    if (seen.has(spec.name)) throw new Refusal(`${file}: graders: ${spec.name} is named twice`);
    seen.add(spec.name);
    return spec;
  });
}

/**
 * A symlink among what a case is built from or its key is read from: a link copied as it is
 * would point the workflow outside the case, perhaps at the key, and one followed would bring in
 * whatever it names.
 */
export function refuseLinks(dir: string): void {
  const links = linksUnder(dir);
  if (links.length > 0) {
    throw new Refusal(
      `${links.join(", ")}: a symlink; a case's files and key are plain files, copied or read as they are`,
    );
  }
}

/** Every case of a dataset, its key read strictly. */
export function readCases(dataset: DatasetInfo): CaseInfo[] {
  const root = join(dataset.dir, "cases");
  return folders(root).map((name) => readCase(name, join(root, name)));
}

function readCase(name: string, dir: string): CaseInfo {
  const keyFile = join(dir, KEY_FILE);
  refuseLinks(join(dir, "files"));
  refuseLinks(join(dir, "key"));
  if (existsSync(keyFile) && lstatSync(keyFile).isSymbolicLink()) refuseLinks(dir);
  if (!existsSync(keyFile)) throw new Refusal(`case ${name} has no ${KEY_FILE}: ${dir}`);
  const read = parseKey(readFileSync(keyFile, "utf8"));
  if (!read.ok) throw new Refusal(describeProblems(keyFile, read.problems));
  const keyFiles: KeyFile[] = [];
  const keyDir = join(dir, "key");
  if (existsSync(keyDir)) {
    for (const path of filesUnder(keyDir)) {
      const bytes = new Uint8Array(readFileSync(path));
      if (bytes.byteLength === 0) {
        throw new Refusal(
          `${path} is empty: an empty key file matches every empty file, so the marker search can't use it`,
        );
      }
      keyFiles.push({ path, size: bytes.byteLength, digest: sha256(bytes), bytes });
    }
  }
  return { name, dir, key: read.value.key, note: read.value.note, keyFiles };
}

type Walk = {
  /** Names left out, with what is under them. */
  skip?: (name: string) => boolean;
  /** Follows symlinks: to a file, read as one; to a folder, walked once by its real path. */
  follow?: boolean;
};

/** Each entry under `dir`, as a file, a folder or a symlink not followed, depth first. */
function walk(
  dir: string,
  options: Walk,
  /** Returns false to leave a folder unwalked. */
  visit: (path: string, kind: "file" | "folder" | "link", name: string) => boolean | undefined,
): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  const seen = new Set<string>();
  const into = (at: string) => {
    const real = realpathSync(at);
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (options.skip?.(entry.name)) continue;
      const path = join(at, entry.name);
      let kind: "file" | "folder" | "link" | undefined;
      if (entry.isSymbolicLink()) {
        if (!options.follow) kind = "link";
        else {
          try {
            const target = statSync(path);
            kind = target.isDirectory() ? "folder" : target.isFile() ? "file" : undefined;
          } catch {
            kind = "link";
          }
        }
      } else if (entry.isDirectory()) kind = "folder";
      else if (entry.isFile()) kind = "file";
      if (!kind) continue;
      if (visit(path, kind, entry.name) !== false && kind === "folder") into(path);
    }
  };
  into(dir);
}

/** Every file under `dir`, in order; symlinks followed only when `follow` says. */
export function filesUnder(dir: string, options: Walk = {}): string[] {
  const found: string[] = [];
  walk(dir, options, (path, kind) => {
    if (kind === "file") found.push(path);
    return undefined;
  });
  return found.sort();
}

/** Every symlink under `dir`. */
function linksUnder(dir: string): string[] {
  const found: string[] = [];
  walk(dir, {}, (path, kind) => {
    if (kind === "link") found.push(path);
    return undefined;
  });
  return found.sort();
}

/** Every `.git` under `dir`, a folder or a worktree's file, symlinks followed. */
export function gitEntriesUnder(dir: string): string[] {
  const found: string[] = [];
  walk(dir, { follow: true }, (path, _kind, name) => {
    if (name !== ".git") return undefined;
    found.push(path);
    return false;
  });
  return found.sort();
}

/** A folder's digest: each file's path and bytes, in order. */
export function folderDigest(dir: string): string {
  const hash = createHash("sha256");
  for (const file of filesUnder(dir)) {
    hash.update(`${relative(dir, file)}\0`);
    hash.update(sha256(readFileSync(file)));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function fileDigest(file: string): string {
  return sha256(readFileSync(file));
}
