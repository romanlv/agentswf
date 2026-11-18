import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { Agent } from "../../shared/config";
import { WORKSPACE_KIND } from "../../shared/config";
import { readConfigFile } from "../../shared/config-file";
import { discoverDatasets } from "./dataset";
import { gitTop, projectOf } from "./git";
import { Refusal } from "./refusal";

export type CaseWorkspace = {
  config: string;
  /** The folder holding `awf-lab.json`, whose folders are the datasets. */
  evals: string;
  /**
   * Your checkout: the code folder, the first column. The nearest folder at or above `evals/`'s
   * parent holding `node_modules/agentswf`, so a package of a monorepo is its own.
   */
  root: string;
  /** The repository the code folder is in, for its git state; undefined outside one. */
  repository?: string;
  /**
   * Where runs are kept: one store per project, `~/.awf/lab/{project}-{first commit}`, shared by
   * every checkout of it.
   */
  store: string;
  /** A folder inside `evals/` every run's records are also written to, to be committed. */
  records?: string;
  /** Paths relative to a code folder the lab's box hides, as it hides keys. */
  hide?: string[];
  /** Where the lock and the trial files live, whatever `store` says: `~/.awf/lab`. */
  labHome: string;
  judgeAgent?: Agent;
};

export function labHomeOf(home: string): string {
  return join(home, ".awf", "lab");
}

export function inside(dir: string, target: string): boolean {
  const path = relative(dir, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function openCaseWorkspace(config: string, home: string): CaseWorkspace {
  let common: ReturnType<typeof readConfigFile>["common"];
  try {
    common = readConfigFile(config).common;
  } catch (error) {
    throw new Refusal((error as Error).message);
  }
  if (common.kind !== WORKSPACE_KIND) {
    throw new Refusal(`${config} needs "kind": "${WORKSPACE_KIND}" for datasets of cases`);
  }
  const evals = realpathSync(dirname(config));
  const repository = gitTop(evals);
  const root = codeFolderOf(dirname(evals));
  const labHome = labHomeOf(home);
  let store: string;
  if (common.store) {
    store = resolve(evals, common.store);
    if (inside(repository ?? root, store)) {
      throw new Refusal(`${config}: store ${store} is inside the repository; keep runs outside it`);
    }
  } else {
    const project = projectOf(root);
    if (project) store = join(labHome, `${project.name}-${project.first}`);
    else {
      const hash = createHash("sha256").update(root).digest("hex").slice(0, 10);
      store = join(labHome, `${basename(root)}-${hash}`);
    }
  }
  let records: string | undefined;
  if (common.records) {
    records = resolve(evals, common.records);
    if (!inside(evals, records) || records === evals) {
      throw new Refusal(`${config}: records ${records} must be a folder inside ${evals}`);
    }
  }
  const hide = (common.hide ?? []).map((path) => {
    const relativePath = normalize(path).replace(/\/+$/, "");
    if (
      isAbsolute(relativePath) ||
      !inside(root, join(root, relativePath)) ||
      relativePath === "."
    ) {
      throw new Refusal(
        `${config}: hide ${path} must be a path inside the code folder, relative to it`,
      );
    }
    return relativePath;
  });
  return {
    config,
    evals,
    root,
    ...(repository ? { repository } : {}),
    store,
    ...(records ? { records } : {}),
    ...(hide.length > 0 ? { hide } : {}),
    labHome,
    ...(common.judgeAgent ? { judgeAgent: common.judgeAgent } : {}),
  };
}

/** The nearest folder at or above `from` holding `node_modules/agentswf`; `from` when none does. */
export function codeFolderOf(from: string): string {
  for (let at = from; ; at = dirname(at)) {
    if (existsSync(join(at, "node_modules", "agentswf"))) return at;
    if (dirname(at) === at) return from;
  }
}

/** The dataset a command is for: `--dataset`, or the only one. */
export function chooseDataset(
  workspace: CaseWorkspace,
  name?: string,
): { name: string; dir: string } {
  const found = discoverDatasets(workspace.evals);
  if (name !== undefined) {
    const named = found.find((d) => d.name === name);
    if (!named) {
      throw new Refusal(
        `no dataset ${name} in ${workspace.evals}; known: ${found.map((d) => d.name).join(", ") || "none"}`,
      );
    }
    return named;
  }
  if (found.length === 1) return found[0]!;
  if (found.length === 0) {
    throw new Refusal(
      `no dataset in ${workspace.evals}; awf-lab case new {dataset}/{case} makes one`,
    );
  }
  throw new Refusal(
    `more than one dataset: name one with --dataset (${found.map((d) => d.name).join(", ")})`,
  );
}
