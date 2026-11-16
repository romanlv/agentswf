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
import { clearStaleTrialFiles, takeLock } from "./store";

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
