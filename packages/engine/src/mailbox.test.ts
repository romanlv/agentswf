import { afterAll, expect, test } from "bun:test";
import { MAILBOX_RECORD_VERSION, type MailboxRecord } from "@agentswf/contract/records";
import { appendMailbox, foldMailbox, RunMailbox, RunParked, readMailbox } from "./mailbox";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const at = "2026-10-25T12:00:00.000Z";
const event = (id: string, name = "dd.changes"): MailboxRecord => ({
  version: MAILBOX_RECORD_VERSION,
  at,
  kind: "event",
  id,
  name,
  data: { id },
  from: "operator",
});

function mailbox(runDir: string, attempt = 1, now?: () => number): RunMailbox {
  return new RunMailbox({
    runDir,
    attempt,
    locked: (work) => work(),
    ...(now ? { now } : {}),
  });
}

async function withEvents(...ids: string[]): Promise<string> {
  const runDir = runDirs.tempRunDir();
  for (const id of ids) await appendMailbox(runDir, event(id));
  return runDir;
}

const ids = (events: { id: string }[]) => events.map((e) => e.id);
/** A run whose agents hold no window. */
const NO_WINDOW = { timeout: async () => false, liveUntil: () => undefined };

test("a wait takes every waiting event in arrival order, and the next acknowledges them", async () => {
  const runDir = await withEvents("a", "b");
  const box = mailbox(runDir);
  expect(ids(await box.receive(undefined))).toEqual(["a", "b"]);
  await appendMailbox(runDir, event("c"));
  expect(ids(await box.receive(undefined))).toEqual(["c"]);
  expect(foldMailbox(await readMailbox(runDir)).unacknowledged).toEqual([]);
});

test("take: oldest takes one at a time", async () => {
  const box = mailbox(await withEvents("a", "b"));
  expect(ids(await box.receive({ take: "oldest" }))).toEqual(["a"]);
  expect(ids(await box.receive({ take: "oldest" }))).toEqual(["b"]);
});

test("an id appended twice is one event, the first kept", async () => {
  const runDir = await withEvents("a");
  await appendMailbox(runDir, { ...event("a"), data: { second: true } } as MailboxRecord);
  const taken = await mailbox(runDir).receive(undefined);
  expect(taken).toEqual([{ id: "a", name: "dd.changes", data: { id: "a" }, from: "operator", at }]);
});

test("after a crash, the first wait returns the batch taken and not acknowledged, alone", async () => {
  const runDir = await withEvents("a", "b");
  expect(ids(await mailbox(runDir, 1).receive(undefined))).toEqual(["a", "b"]);
  // The attempt died handling them; meanwhile c arrived.
  await appendMailbox(runDir, event("c"));
  const next = mailbox(runDir, 2);
  expect(ids(await next.receive(undefined))).toEqual(["a", "b"]);
  expect(ids(await next.receive(undefined))).toEqual(["c"]);
});

test("a wait whose until passed returns none, recorded as an empty took", async () => {
  const runDir = runDirs.tempRunDir();
  const until = Date.parse(at) + 60_000;
  const box = mailbox(runDir, 1, () => until + 1);
  expect(await box.receive({ until, label: "retrying" })).toEqual([]);
  const records = await readMailbox(runDir);
  expect(records.map((r) => r.kind)).toEqual(["wait", "took"]);
  expect(records[0]).toMatchObject({ label: "retrying", until: new Date(until).toISOString() });
  expect(records[1]).toMatchObject({ ids: [] });
});

test("an until still to come waits for it, recorded as the same time on every rerun", async () => {
  const runDir = runDirs.tempRunDir();
  const until = new Date(Date.now() + 80);
  const box = mailbox(runDir);
  const started = Date.now();
  expect(await box.receive({ until })).toEqual([]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  // A rerun computes the same until from the files: the record says the same time.
  await mailbox(runDir, 2, () => until.getTime() + 1).receive({ until });
  const waits = (await readMailbox(runDir)).filter((r) => r.kind === "wait");
  expect(waits.map((w) => (w.kind === "wait" ? w.until : undefined))).toEqual([
    until.toISOString(),
    until.toISOString(),
  ]);
});

test("a waiting receive takes an event appended later, nudged or not", async () => {
  const runDir = runDirs.tempRunDir();
  const box = mailbox(runDir);
  const waiting = box.receive(undefined);
  await appendMailbox(runDir, event("a"));
  box.nudge();
  expect(ids(await waiting)).toEqual(["a"]);
  // A nudge lost: the poll still finds it.
  const unnudged = box.receive(undefined);
  await appendMailbox(runDir, event("b"));
  expect(ids(await unnudged)).toEqual(["b"]);
});

test("a wait in a stage holds its batch: acknowledged at once, and read back by the stage", async () => {
  const runDir = await withEvents("a");
  const box = mailbox(runDir);
  expect(ids(await box.receive(undefined, "approval-1"))).toEqual(["a"]);
  await appendMailbox(runDir, event("b"));
  // A later attempt, rerun from the top, gets the stage's batch, not b.
  const next = mailbox(runDir, 2);
  expect(ids((await next.batchOf("approval-1")) ?? [])).toEqual(["a"]);
  expect(ids(await next.receive(undefined))).toEqual(["b"]);
});

test("a stage that took its batch and failed, or died before its record, gets it again", async () => {
  const runDir = await withEvents("a");
  expect(ids(await mailbox(runDir, 1).receive(undefined, "approval-1"))).toEqual(["a"]);
  await appendMailbox(runDir, event("b"));
  const rerun = mailbox(runDir, 2);
  expect(ids(await rerun.receive(undefined, "approval-1"))).toEqual(["a"]);
  // Nothing was written for it, and b still waits for the loop.
  expect(ids(await rerun.receive(undefined))).toEqual(["b"]);
});

test("a first wait in a stage leaves a crash's held batch to the first wait outside one", async () => {
  const runDir = await withEvents("a");
  expect(ids(await mailbox(runDir, 1).receive(undefined))).toEqual(["a"]);
  await appendMailbox(runDir, event("b"));
  const next = mailbox(runDir, 2);
  expect(ids(await next.receive(undefined, "approval-1"))).toEqual(["b"]);
  expect(ids(await next.receive(undefined))).toEqual(["a"]);
});

test("a wait's options are checked", async () => {
  const box = mailbox(runDirs.tempRunDir());
  await expect(box.receive({ take: "latest" as "all" })).rejects.toThrow('"all" or "oldest"');
  await expect(box.receive({ until: Number.NaN })).rejects.toThrow("epoch milliseconds or a Date");
});

test("an event sent as the run parks is taken: parking checks again under the run's lock", async () => {
  const runDir = runDirs.tempRunDir();
  let parked = false;
  let first = true;
  const box = new RunMailbox({
    runDir,
    attempt: 1,
    // A sender that got the lock just before the park did: its event is in when the park looks.
    locked: async (work) => {
      if (first) {
        first = false;
        await appendMailbox(runDir, event("late"));
      }
      return work();
    },
    parking: {
      ...NO_WINDOW,
      idle: () => true,
      park: async () => {
        parked = true;
      },
    },
  });
  expect(ids(await box.receive(undefined))).toEqual(["late"]);
  expect(parked).toBe(false);
});

test("with nothing to take and nothing running, the wait parks: its ending written under the lock", async () => {
  const runDir = runDirs.tempRunDir();
  const order: string[] = [];
  const box = new RunMailbox({
    runDir,
    attempt: 1,
    locked: async (work) => {
      order.push("lock");
      const result = await work();
      order.push("unlock");
      return result;
    },
    parking: {
      ...NO_WINDOW,
      idle: () => true,
      park: async (wait) => {
        order.push(`park ${wait.label}`);
      },
    },
  });
  await expect(box.receive({ label: "idle" })).rejects.toBeInstanceOf(RunParked);
  // The wait's own record, then the check and the ending, each under the lock.
  expect(order).toEqual(["lock", "unlock", "lock", "park idle", "unlock"]);
});

test("while a turn runs, the wait doesn't park, and parks once it has ended", async () => {
  const runDir = runDirs.tempRunDir();
  let busy = true;
  setTimeout(() => {
    busy = false;
  }, 50);
  const box = new RunMailbox({
    runDir,
    attempt: 1,
    locked: (work) => work(),
    parking: { ...NO_WINDOW, idle: () => !busy, park: async () => undefined },
  });
  const started = Date.now();
  await expect(box.receive(undefined)).rejects.toBeInstanceOf(RunParked);
  expect(Date.now() - started).toBeGreaterThanOrEqual(40);
});

test("in an agent's window the wait sleeps to its end, looking once, then parks", async () => {
  const runDir = runDirs.tempRunDir();
  const end = Date.now() + 1_200;
  let looks = 0;
  const live: number[] = [];
  const box = new RunMailbox({
    runDir,
    attempt: 1,
    locked: (work) => work(),
    parking: {
      idle: () => {
        looks += 1;
        return true;
      },
      timeout: async () => false,
      liveUntil: () => (Date.now() < end ? end : undefined),
      park: async () => undefined,
      live: async (until) => {
        live.push(until);
      },
    },
  });
  await expect(box.receive(undefined)).rejects.toBeInstanceOf(RunParked);
  expect(Date.now()).toBeGreaterThanOrEqual(end);
  expect(live).toEqual([end]);
  // Once in the window and once past it: no look each second.
  expect(looks).toBe(2);
});

test("a due onTimeout runs before the wait parks, after an event already there is taken", async () => {
  const runDir = runDirs.tempRunDir();
  await appendMailbox(runDir, event("first"));
  const calls: string[] = [];
  let due = true;
  const box = new RunMailbox({
    runDir,
    attempt: 1,
    locked: (work) => work(),
    parking: {
      idle: () => true,
      timeout: async () => {
        if (!due) return false;
        due = false;
        calls.push("handler");
        await appendMailbox(runDir, event("during"));
        return true;
      },
      liveUntil: () => undefined,
      park: async () => {
        calls.push("park");
      },
    },
  });
  expect(ids(await box.receive(undefined))).toEqual(["first"]);
  expect(calls).toEqual([]);
  // The handler runs at the next wait, and what it let in is taken before the run parks.
  expect(ids(await box.receive(undefined))).toEqual(["during"]);
  expect(calls).toEqual(["handler"]);
  await expect(box.receive(undefined)).rejects.toBeInstanceOf(RunParked);
  expect(calls).toEqual(["handler", "park"]);
});

test("a window that passes between the wait's two looks is handled, not parked past", async () => {
  const runDir = runDirs.tempRunDir();
  // Each look at the clock comes later than the one before: the window ends between two.
  let now = 0;
  const END = 1;
  const calls: string[] = [];
  let owed = true;
  const box = new RunMailbox({
    runDir,
    attempt: 1,
    locked: (work) => work(),
    parking: {
      idle: () => true,
      liveUntil: () => (now++ < END ? END : undefined),
      timeout: async () => {
        if (!owed || now++ < END) return false;
        owed = false;
        calls.push("handler");
        return true;
      },
      park: async () => {
        calls.push("park");
      },
    },
  });
  await expect(box.receive(undefined)).rejects.toBeInstanceOf(RunParked);
  expect(calls).toEqual(["handler", "park"]);
});
