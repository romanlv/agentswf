import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git";
import { CHANGE_FILE, codeOf, incumbentOf, readLoop, readTries } from "./loop";
import { copyStart, rebuildTry } from "./loop-code";
import { Refusal } from "./refusal";
import type { CaseWorkspace } from "./workspace";

// A loop's own records in the records folder, `{records}/loops/{name}/`, beside its runs': what it
// was started with, each try's decision, proposal, ledger and change, and each final check. The
// code is not kept: a store that lacks it builds it again from the start commit and the changes
// of the tries it needs, so a loop goes on from a clone of the project that ran it.

/** The loop's own files, relative to its folder: never its code, bundles or proposer's runs. */
function ownFiles(dir: string): string[] {
  const files = ["loop.json", "program.md", "cap.jsonl"].filter((f) => existsSync(join(dir, f)));
  const tries = join(dir, "tries");
  if (existsSync(tries)) {
    for (const n of readdirSync(tries)) {
      for (const f of ["try.json", "proposal.json", "runs.json", "proposer.jsonl", CHANGE_FILE]) {
        if (existsSync(join(tries, n, f))) files.push(join("tries", n, f));
      }
    }
  }
  const finals = join(dir, "finals");
  if (existsSync(finals)) {
    for (const f of readdirSync(finals).filter((f) => f.endsWith(".json"))) {
      files.push(join("finals", f));
    }
  }
  return files;
}

/** Writes the loop's own files into the records, as the store has them now. */
export function writeLoopRecords(dir: string, records: string, name: string): void {
  const to = join(records, "loops", name);
  for (const file of ownFiles(dir)) {
    mkdirSync(dirname(join(to, file)), { recursive: true });
    copyFileSync(join(dir, file), join(to, file));
  }
}

const same = (a: string, b: string) => readFileSync(a, "utf8") === readFileSync(b, "utf8");

/**
 * Brings the records' copy of a loop into the store: the files it lacks, then the code of the start
 * and of each try it still needs, built again. A loop of the same name started elsewhere, or a try
 * decided otherwise, is refused: the two can't both be this loop.
 */
export function readLoopRecords(
  dir: string,
  records: string,
  name: string,
  top: string,
  workspace: CaseWorkspace,
): void {
  const from = join(records, "loops", name);
  if (!existsSync(join(from, "loop.json"))) return;
  if (
    existsSync(join(dir, "loop.json")) &&
    !same(join(dir, "loop.json"), join(from, "loop.json"))
  ) {
    throw new Refusal(
      `loop ${name} in the records was started elsewhere than this store's: name this one otherwise`,
    );
  }
  for (const file of ownFiles(from)) {
    const here = join(dir, file);
    if (!existsSync(here)) {
      mkdirSync(dirname(here), { recursive: true });
      copyFileSync(join(from, file), here);
    } else if (file.endsWith("try.json") && !same(here, join(from, file))) {
      throw new Refusal(`loop ${name}'s ${file} differs in the records: it was decided twice`);
    }
  }
  rebuildCode(dir, name, top, workspace);
}

/** The start's code, and each kept or undecided try's, where the store lacks them. */
function rebuildCode(dir: string, name: string, top: string, workspace: CaseWorkspace): void {
  const loop = readLoop(dir);
  if (!loop) return;
  const tries = readTries(dir);
  const decided = new Set(tries.map((t) => t.n));
  const kept = new Set(tries.filter((t) => t.decision === "kept").map((t) => t.n));
  // An undecided try resumes with its change: its proposal was made and paid for.
  const open = existsSync(join(dir, "tries"))
    ? readdirSync(join(dir, "tries"))
        .map(Number)
        .filter((n) => !decided.has(n) && existsSync(join(dir, "tries", String(n), CHANGE_FILE)))
    : [];
  const needed = [...kept, ...open].sort((a, b) => a - b);
  if (existsSync(codeOf(dir, 0)) && needed.every((n) => existsSync(codeOf(dir, n)))) return;
  if (!existsSync(codeOf(dir, 0))) {
    if (!loop.from.commit || loop.from.dirty) {
      throw new Refusal(
        `loop ${name} started from uncommitted changes, so its code can't be built again here: go on where it started`,
      );
    }
    const checkout = `${codeOf(dir, 0)}.checkout`;
    rmSync(checkout, { recursive: true, force: true });
    // A process cut here before left its checkout registered though gone, which `add` refuses.
    git(top, ["worktree", "prune"]);
    git(top, ["worktree", "add", "--detach", "-q", checkout, loop.from.commit]);
    try {
      copyStart(top, codeOf(dir, 0), workspace, checkout);
    } finally {
      git(top, ["worktree", "remove", "--force", checkout]);
    }
  }
  const parentOf = (n: number) =>
    tries.find((t) => t.n === n)?.parent ??
    // An undecided try's parent is the incumbent of the tries decided before it.
    incumbentOf(tries.filter((t) => t.n < n));
  for (const n of needed) {
    if (existsSync(codeOf(dir, n))) continue;
    const change = readFileSync(join(dir, "tries", String(n), CHANGE_FILE), "utf8");
    rebuildTry(codeOf(dir, parentOf(n)), codeOf(dir, n), change, top, n);
  }
}
