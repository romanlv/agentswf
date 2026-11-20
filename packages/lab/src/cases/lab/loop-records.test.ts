import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP_KIND, type Loop, TRY_KIND, type Try } from "../format/loop";
import { git } from "./git";
import { CHANGE_FILE, codeOf } from "./loop";
import { readLoopRecords } from "./loop-records";
import { Refusal } from "./refusal";
import type { CaseWorkspace } from "./workspace";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "awf-lab-loop-records-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;

/** A repository with one committed file, its records folder, and a store that has no loop yet. */
function project() {
  const top = join(scratch, String(++count));
  mkdirSync(join(top, "evals"), { recursive: true });
  writeFileSync(join(top, "workflow.ts"), "export const quality = 1;\n");
  git(top, ["init", "-q"]);
  git(top, ["add", "-A"]);
  git(top, ["commit", "-q", "-m", "start"]);
  const commit = git(top, ["rev-parse", "HEAD"]).trim();
  const records = join(top, "evals", "records");
  const store = join(scratch, `store-${count}`);
  const workspace: CaseWorkspace = {
    config: join(top, "evals", "awf-lab.json"),
    evals: join(top, "evals"),
    root: top,
    repository: top,
    store,
    records,
    labHome: join(scratch, `home-${count}`),
  };
  const loop: Loop = {
    kind: LOOP_KIND,
    name: "l",
    dataset: "ds",
    started: "2026-11-19T00:00:00.000Z",
    from: { path: top, commit, dirty: false },
    program: "sha256:0",
    proposer: "claude/claude-sonnet-5-5",
    trials: 1,
    params: [],
    cap: { usd: 5 },
    tuning: ["a"],
    holdout: [],
    comparison: "graders.ts sha256:0",
  };
  const recorded = join(records, "loops", "l");
  const dir = join(store, "loops", "l");
  const write = (file: string, value: unknown) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const read = () => readLoopRecords(dir, records, "l", top, workspace);
  return { top, workspace, loop, recorded, dir, write, read };
}

const decided = (n: number, decision: Try["decision"]): Try => ({
  kind: TRY_KIND,
  n,
  at: "2026-11-19T00:00:00.000Z",
  parent: 0,
  decision,
  why: "because",
  changed: ["workflow.ts"],
  spend: { proposer: 0, trials: 0 },
});

/** A change to the committed file, as a try's `change.patch` keeps it. */
function changeOf(top: string, text: string): string {
  writeFileSync(join(top, "workflow.ts"), text);
  const patch = git(top, ["diff", "--no-color", "--binary"]);
  git(top, ["checkout", "--", "workflow.ts"]);
  return patch;
}

describe("a loop's records brought into a store", () => {
  test("a loop started from uncommitted changes is refused: its start can't be built again", () => {
    const p = project();
    p.write(join(p.recorded, "loop.json"), { ...p.loop, from: { ...p.loop.from, dirty: true } });
    expect(p.read).toThrow(Refusal);
    expect(p.read).toThrow("started from uncommitted changes");
  });

  test("a try decided otherwise in the store than in the records is refused", () => {
    const p = project();
    p.write(join(p.recorded, "loop.json"), p.loop);
    p.write(join(p.recorded, "tries", "1", "try.json"), decided(1, "discarded"));
    p.write(join(p.dir, "loop.json"), p.loop);
    p.write(join(p.dir, "tries", "1", "try.json"), decided(1, "kept"));
    expect(p.read).toThrow(
      "loop l's tries/1/try.json differs in the records: it was decided twice",
    );
  });

  test("an undecided try's code is built again from its change, on the start's", () => {
    const p = project();
    p.write(join(p.recorded, "loop.json"), p.loop);
    p.write(
      join(p.recorded, "tries", "1", CHANGE_FILE),
      changeOf(p.top, "export const quality = 2;\n"),
    );
    p.read();
    expect(readFileSync(join(codeOf(p.dir, 0), "workflow.ts"), "utf8")).toContain("quality = 1");
    expect(readFileSync(join(codeOf(p.dir, 1), "workflow.ts"), "utf8")).toContain("quality = 2");
  });

  test("a checkout a cut process left registered but gone doesn't stop the start's build", () => {
    const p = project();
    p.write(join(p.recorded, "loop.json"), p.loop);
    const checkout = `${codeOf(p.dir, 0)}.checkout`;
    mkdirSync(join(checkout, ".."), { recursive: true });
    git(p.top, ["worktree", "add", "--detach", "-q", checkout, p.loop.from.commit!]);
    rmSync(checkout, { recursive: true, force: true });
    // Someone else's worktree, gone from disk for now: the lab leaves its registration alone.
    const theirs = `${p.dir}-theirs`;
    git(p.top, ["worktree", "add", "--detach", "-q", theirs, p.loop.from.commit!]);
    rmSync(theirs, { recursive: true, force: true });
    p.read();
    expect(readFileSync(join(codeOf(p.dir, 0), "workflow.ts"), "utf8")).toContain("quality = 1");
    expect(git(p.top, ["worktree", "list"])).toContain("-theirs");
  });
});
