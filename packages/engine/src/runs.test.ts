import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptRecord } from "@agentswf/contract/records";
import { writeJson } from "./files";
import {
  checkContinue,
  checkFree,
  claimAttempt,
  createRun,
  discardRun,
  endAttempt,
  generateId,
  isLive,
  openRun,
  type ProcessProbe,
  processStart,
  type Run,
  RunRefused,
  readAccepted,
  readAttempts,
  replaceStale,
  writeAcceptedExclusive,
} from "./runs";
import { createTempRunDirs, runAttempt, workflowOf } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());
const root = () => join(runDirs.tempRunDir(), ".awf", "runs");
const run = (id = "AIRS-1515", workflow = "implement-ticket") => ({
  id,
  workflow,
  argv: ["AIRS-1515"],
  cwd: "/work",
  sandbox: null,
});
const fields = { file: "/work/flow.ts", flags: { timeout: "30m" } };
/** Processes 1 and 2 alive since a fixed time; anything else gone. */
const START = "2026-10-04T10:00:00Z";
const alive =
  (...pids: number[]): ProcessProbe =>
  (pid) =>
    pids.includes(pid) ? START : undefined;

/** Claims the run's next attempt, which must not be refused. */
async function claim(
  created: Run,
  options: { pid: number; probe: ProcessProbe },
  claimed: Pick<AttemptRecord, "file" | "workflowVersion" | "flags"> = fields,
) {
  const result = await claimAttempt(created, claimed, options);
  if ("refused" in result) throw new Error(`refused: ${result.refused.kind}`);
  return result;
}

describe("runs", () => {
  test("a new run is claimed under its workflow with its run.json, and the root ignored by git", async () => {
    const at = root();
    const created = await createRun(at, run());
    expect(created.dir).toBe(join(at, "implement-ticket", "AIRS-1515"));
    expect(JSON.parse(await readFile(join(created.dir, "run.json"), "utf8"))).toMatchObject({
      version: 1,
      id: "AIRS-1515",
      workflow: "implement-ticket",
      argv: ["AIRS-1515"],
    });
    expect(await readFile(join(at, ".gitignore"), "utf8")).toBe("*\n");
    expect(await readdir(join(at, "implement-ticket"))).toEqual(["AIRS-1515"]);
  });

  test("a generated id is local time and four hex digits", () => {
    expect(generateId(new Date(2026, 9, 4, 15, 32), "a7f3")).toBe("20261004-1532-a7f3");
    expect(generateId()).toMatch(/^\d{8}-\d{4}-[0-9a-f]{4}$/);
  });

  test("a taken id is refused, in any case, and an invalid one never makes a folder", async () => {
    const at = root();
    await createRun(at, run());
    await expect(createRun(at, run())).rejects.toThrow(
      "AIRS-1515 exists; --continue it, or --id another to start over",
    );
    await expect(createRun(at, run("airs-1515"))).rejects.toBeInstanceOf(RunRefused);
    await expect(createRun(at, run(".hidden"))).rejects.toThrow("not a valid id");
    await expect(createRun(at, run("a/b"))).rejects.toThrow("not a valid id");
    expect(await readdir(join(at, "implement-ticket"))).toEqual(["AIRS-1515"]);
  });

  test("a generated id that is taken is generated again; a given one is refused", async () => {
    const at = root();
    const at1532 = new Date(2026, 9, 4, 15, 32);
    const { id: _id, ...unnamed } = run();
    const first = await createRun(at, unnamed, at1532);
    expect(first.record.id).toMatch(/^20261004-1532-[0-9a-f]{4}$/);
    const ids = new Set([first.record.id]);
    for (let index = 0; index < 30; index += 1) {
      ids.add((await createRun(at, unnamed, at1532)).record.id);
    }
    expect(ids.size).toBe(31);
  });

  test("a deleted run's id is free again", async () => {
    const at = root();
    const first = await createRun(at, run());
    await rm(first.dir, { recursive: true });
    await expect(createRun(at, run())).resolves.toMatchObject({ dir: first.dir });
  });

  test("attempts are numbered, ended whole, and read in order", async () => {
    const at = root();
    const created = await createRun(at, run());
    const probe = alive(1);
    const one = await claim(created, { pid: 1, probe });
    expect(one.attempt.record).toMatchObject({ attempt: 1, pid: 1, processStart: START });
    expect(isLive((await readAttempts(created))[0]!, probe)).toBe(true);
    await endAttempt(one.attempt, { outcome: "failed", reason: "qa settled without an answer" });
    expect((await readAttempts(created))[0]?.outcome).toBe("failed");

    const opened = await openRun(at, "implement-ticket", "AIRS-1515");
    const two = await claim(opened, { pid: 1, probe });
    expect(two.attempt.record.attempt).toBe(2);
    expect(two.interrupted).toEqual([]);
    await endAttempt(two.attempt, { outcome: "completed" });
    const attempts = await readAttempts(opened);
    expect(attempts.map((attempt) => [attempt.attempt, attempt.outcome])).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
  });

  test("a live attempt refuses another, and the refused one leaves no file", async () => {
    const created = await createRun(root(), run());
    const probe = alive(1, 2);
    await claim(created, { pid: 1, probe });
    expect(await claimAttempt(created, fields, { pid: 2, probe })).toMatchObject({
      refused: { kind: "running", attempt: { attempt: 1, pid: 1 } },
    });
    expect(await readdir(join(created.dir, "attempts"))).toEqual(["1.json"]);
  });

  test("a claim that fails after its link leaves no file", async () => {
    const created = await createRun(root(), run());
    await mkdir(join(created.dir, "stages"));
    await writeFile(join(created.dir, "stages", "plan.json"), JSON.stringify({ version: 99 }));
    await expect(claimAttempt(created, fields, { pid: 1, probe: alive(1) })).rejects.toThrow(
      "newer than this awf reads",
    );
    expect(await readdir(join(created.dir, "attempts"))).toEqual([]);
  });

  test("an attempt with no ending whose process is gone, or is another, reads interrupted", async () => {
    const created = await createRun(root(), run());
    await claim(created, { pid: 1, probe: alive(1) });
    const [first] = await readAttempts(created);
    expect(isLive(first!, alive())).toBe(false);
    // The same pid, started at another time: another process after a reboot.
    expect(isLive(first!, () => "2026-10-05T08:00:00Z")).toBe(false);
    const next = await claim(created, { pid: 2, probe: alive(2) });
    expect(next.attempt.record.attempt).toBe(2);
    expect(next.interrupted.map((attempt) => attempt.attempt)).toEqual([1]);
  });

  test("a start time a second off is the same process; two seconds off is another", async () => {
    const created = await createRun(root(), run());
    await claim(created, { pid: 1, probe: alive(1) });
    const [attempt] = await readAttempts(created);
    expect(isLive(attempt!, () => "2026-10-04T10:00:01Z")).toBe(true);
    expect(isLive(attempt!, () => "2026-10-04T09:59:59Z")).toBe(true);
    expect(isLive(attempt!, () => "2026-10-04T10:00:02Z")).toBe(false);
  });

  test("an attempt after one that completed the run is refused at its claim, leaving no file", async () => {
    const created = await createRun(root(), run());
    const { attempt } = await claim(created, { pid: 1, probe: alive(1) });
    await endAttempt(attempt, { outcome: "completed" });
    expect(await claimAttempt(created, fields, { pid: 1, probe: alive(1) })).toEqual({
      refused: { kind: "completed", stages: [] },
    });
    expect(await readdir(join(created.dir, "attempts"))).toEqual(["1.json"]);
  });

  test("a new run whose first attempt never claimed is discarded, and its id is free", async () => {
    const at = root();
    const created = await createRun(at, run());
    await expect(checkFree(at, "implement-ticket", "AIRS-1515")).rejects.toThrow("exists");
    await expect(checkFree(at, "implement-ticket", "airs-1515")).rejects.toThrow("exists");
    expect(await discardRun(created)).toBe(true);
    await checkFree(at, "implement-ticket", "AIRS-1515");
    // One with an attempt is kept.
    const again = await createRun(at, run());
    await claim(again, { pid: 1, probe: alive(1) });
    expect(await discardRun(again)).toBe(false);
    expect(await readdir(join(at, "implement-ticket"))).toEqual(["AIRS-1515"]);
  });

  test("a run being claimed, its folder not yet renamed, is invisible", async () => {
    const at = root();
    await createRun(at, run("AIRS-1"));
    const pending = join(at, "implement-ticket", ".new-abc");
    await mkdir(pending);
    await writeFile(join(pending, "run.json"), JSON.stringify({ ...run(".new-abc"), version: 1 }));
    await expect(openRun(at, "implement-ticket", ".new-abc")).rejects.toThrow("not a valid id");
    await checkFree(at, "implement-ticket", "AIRS-2");
    expect((await createRun(at, run("AIRS-2"))).record.id).toBe("AIRS-2");
  });

  test("of two attempts claimed at once, exactly one runs", async () => {
    for (let round = 0; round < 20; round += 1) {
      const created = await createRun(root(), run());
      const probe = alive(1, 2);
      const claims = await Promise.all([
        claimAttempt(created, fields, { pid: 1, probe }),
        claimAttempt(created, fields, { pid: 2, probe }),
      ]);
      expect(claims.filter((claimed) => "attempt" in claimed)).toHaveLength(1);
      expect(claims.find((claimed) => "refused" in claimed)).toMatchObject({
        refused: { kind: "running" },
      });
      expect(await readdir(join(created.dir, "attempts"))).toHaveLength(1);
    }
  });

  test("of two runs created at once with one id, exactly one is claimed", async () => {
    const at = root();
    const claims = await Promise.allSettled([createRun(at, run()), createRun(at, run())]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(await readdir(join(at, "implement-ticket"))).toEqual(["AIRS-1515"]);
  });

  test("temp files a crash left are ignored, and swept once a day old", async () => {
    const at = root();
    const created = await createRun(at, run());
    const attempts = join(created.dir, "attempts");
    await mkdir(attempts);
    await writeFile(join(attempts, ".tmp-fresh"), "{");
    await writeFile(join(attempts, ".tmp-old"), "{");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await utimes(join(attempts, ".tmp-old"), old, old);
    await mkdir(join(at, "implement-ticket", ".new-old"));
    await utimes(join(at, "implement-ticket", ".new-old"), old, old);

    await claim(created, { pid: 1, probe: alive(1) });
    expect((await readdir(attempts)).sort()).toEqual([".tmp-fresh", "1.json"]);
    expect(await readAttempts(created)).toHaveLength(1);
    await createRun(at, run("AIRS-1516"));
    expect((await readdir(join(at, "implement-ticket"))).sort()).toEqual([
      "AIRS-1515",
      "AIRS-1516",
    ]);
  });

  test("a continue keeps the run's argv, working directory and sandbox", async () => {
    const created = await createRun(root(), run());
    expect(() => checkContinue(created, { argv: [] })).not.toThrow();
    expect(() => checkContinue(created, { argv: [], cwd: "/work", sandbox: null })).not.toThrow();
    expect(() => checkContinue(created, { argv: ["AIRS-1516"] })).toThrow(
      "AIRS-1515 keeps the arguments it was started with",
    );
    expect(() => checkContinue(created, { argv: [], cwd: "/elsewhere" })).toThrow(
      "AIRS-1515 works in /work, not /elsewhere",
    );
    expect(() => checkContinue(created, { argv: [], sandbox: { srt: {} } })).toThrow(
      "runs in the sandbox it was started with",
    );
  });

  test("a continue of a run under another workflow says where it is", async () => {
    const at = root();
    await createRun(at, run("AIRS-1515", "implement-ticket-old"));
    await expect(openRun(at, "implement-ticket", "AIRS-1515")).rejects.toThrow(
      `AIRS-1515 is a run of implement-ticket-old; move ${join(at, "implement-ticket-old", "AIRS-1515")} to ${join(at, "implement-ticket", "AIRS-1515")}`,
    );
    await expect(openRun(at, "implement-ticket", "AIRS-9")).rejects.toThrow(
      `no run AIRS-9 of implement-ticket in ${at}`,
    );
  });

  test("a record newer than this awf, or one that doesn't parse, refuses", async () => {
    const at = root();
    const created = await createRun(at, run());
    const attempts = join(created.dir, "attempts");
    await mkdir(attempts);
    await writeFile(join(attempts, "1.json"), JSON.stringify({ version: 2, attempt: 1 }));
    await expect(readAttempts(created)).rejects.toThrow("is version 2, newer than this awf reads");
    await writeFile(join(attempts, "1.json"), "{");
    await expect(readAttempts(created)).rejects.toThrow("could not be read");
    await writeFile(
      join(created.dir, "run.json"),
      JSON.stringify({ ...created.record, version: 9 }),
    );
    await expect(openRun(at, "implement-ticket", "AIRS-1515")).rejects.toBeInstanceOf(RunRefused);
  });

  test("a write that fails leaves the old file whole and no temp file beside it", async () => {
    const dir = runDirs.tempRunDir();
    const file = join(dir, "1.json");
    await writeJson(file, { n: 1 });
    await expect(writeJson(file, { n: 2n } as unknown as object)).rejects.toThrow();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ n: 1 });
    expect(await readdir(dir)).toEqual(["1.json"]);
  });

  test("this process's start time reads to the second, and a gone process has none", () => {
    expect(processStart(process.pid)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(processStart(process.pid)).toBe(processStart(process.pid));
    expect(processStart(2 ** 22 + 12345)).toBeUndefined();
  });

  test("an attempt's file names its version and flags", async () => {
    const created = await createRun(root(), run());
    const { attempt } = await claim(
      created,
      { pid: 1, probe: alive(1) },
      { ...fields, workflowVersion: "1.2.1" },
    );
    const written = JSON.parse(await readFile(attempt.file, "utf8")) as AttemptRecord;
    // Records are the operator's alone.
    expect((await stat(attempt.file)).mode & 0o777).toBe(0o600);
    expect(written).toMatchObject({
      version: 1,
      attempt: 1,
      workflowVersion: "1.2.1",
      flags: fields.flags,
    });
    expect(written.ended).toBeUndefined();
  });
});

test("a continue moves its start stage's record first: a move that fails after it leaves the rest", async () => {
  const runRoot = runDirs.tempRunDir();
  const dir = join(runRoot, "staged", "r1");
  await runAttempt(
    workflowOf(async (workflow) => {
      for (const stage of ["doc-review", "implement", "qa"])
        await workflow.stage(stage, async () => {});
      return null;
    }),
    { runRoot },
  );
  // A record that can't be read fails the move after implement's.
  await writeFile(join(dir, "stages", "qa.json"), "{");
  await expect(replaceStale(dir, "implement", new Set(["doc-review"]))).rejects.toThrow(
    "could not be read",
  );
  expect(await readdir(join(dir, "replaced"))).toEqual(["implement.1.json"]);
  expect((await readdir(join(dir, "stages"))).sort()).toEqual(["doc-review.json", "qa.json"]);
});

describe("an operation's accepted result", () => {
  test("the first accepted value wins and a later one does not replace it", async () => {
    const runDir = runDirs.tempRunDir();
    expect(await writeAcceptedExclusive(runDir, "c1", { n: 1 })).toBe(true);
    expect(await writeAcceptedExclusive(runDir, "c1", { n: 2 })).toBe(false);
    expect(await readAccepted(runDir, "c1")).toEqual({ value: { n: 1 } });
  });

  test("concurrent writers expose exactly one complete result", async () => {
    const runDir = runDirs.tempRunDir();
    const claims = await Promise.all(
      Array.from({ length: 16 }, (_, n) => writeAcceptedExclusive(runDir, "c1", { n })),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const accepted = await readAccepted(runDir, "c1");
    expect(accepted).not.toBeNull();
    expect(claims[Number((accepted!.value as { n: number }).n)]).toBe(true);
  });
});
