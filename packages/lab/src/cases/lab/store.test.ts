import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_KIND, type RunRecord } from "../format/records";
import { clearStaleTrialFiles, readableRuns, runDirOf, runSpan, takeLock, writeRun } from "./store";

const top = mkdtempSync(join(tmpdir(), "awf-lab-store-"));
afterAll(() => rmSync(top, { recursive: true, force: true }));

let count = 0;
const home = () => {
  const dir = join(top, String(++count));
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A process id no process holds: one that has just exited. */
function deadPid(): number {
  const child = Bun.spawnSync(["true"]);
  return child.pid;
}

describe("the lock", () => {
  test("a lock another lab has just made, not yet written, is never taken", () => {
    const dir = home();
    // How the lock looked between its O_EXCL create and its pid's write.
    closeSync(openSync(join(dir, "lock"), "wx"));
    expect(takeLock(dir)).toEqual({ heldBy: undefined });
    expect(existsSync(join(dir, "lock"))).toBe(true);
  });

  test("a live process's lock is held; a dead one's is taken, and released", () => {
    const dir = home();
    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: process.ppid }));
    expect(takeLock(dir)).toEqual({ heldBy: process.ppid });

    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: deadPid() }));
    const taken = takeLock(dir);
    if (!("release" in taken)) throw new Error(`not taken: ${JSON.stringify(taken)}`);
    expect(takeLock(dir)).toEqual({ heldBy: process.pid });
    taken.release();
    expect(readdirSync(dir)).toEqual([]);
  });
});

test("trial files a dead lab left are swept; a live one's stay", () => {
  const dir = home();
  const trials = join(dir, "trials");
  mkdirSync(trials);
  const dead = `${deadPid()}-a.jsonl`;
  const live = `${process.pid}-b.jsonl`;
  for (const name of [dead, live, "unnamed.jsonl"]) writeFileSync(join(trials, name), "");
  expect(clearStaleTrialFiles(dir)).toBe(1);
  expect(readdirSync(trials).sort()).toEqual([live, "unnamed.jsonl"]);
});

describe("the runs a store holds", () => {
  const store = home();
  const runOf = (id: string, started: string, finished?: string): RunRecord => ({
    kind: RUN_KIND,
    id,
    dataset: id.endsWith("bbbb") ? "other" : "ds",
    folders: [{ path: "/p", branch: null, commit: null, dirty: false, env: "0".repeat(64) }],
    columns: [{ folder: 0, params: {} }],
    asked: [],
    started,
    ...(finished ? { finished } : {}),
  });
  const killed = runOf("20261119-100000-aaaa", "2026-11-19T10:00:00.000Z");
  const next = runOf(
    "20261119-110000-bbbb",
    "2026-11-19T11:00:00.000Z",
    "2026-11-19T11:30:00.000Z",
  );
  const last = runOf("20261119-120000-cccc", "2026-11-19T12:00:00.000Z");
  for (const run of [killed, next, last]) {
    mkdirSync(runDirOf(store, run.id), { recursive: true });
    writeRun(store, run);
  }

  test("a killed run ends where the next one started; the newest stays open", () => {
    expect(runSpan(store, killed)).toEqual({
      started: killed.started,
      finished: next.started,
    });
    expect(runSpan(store, next)).toEqual({ started: next.started, finished: next.finished! });
    expect(runSpan(store, last)).toEqual({ started: last.started });
  });

  test("history before a run reads only the runs made before it", () => {
    const ids = [...readableRuns(store, { before: last.id })].map((r) => r.run.id);
    expect(ids).toEqual([killed.id, next.id]);
    expect(
      [...readableRuns(store, { dataset: "ds", before: next.id })].map((r) => r.run.id),
    ).toEqual([killed.id]);
  });
});
