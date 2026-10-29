import { afterAll, expect, test } from "bun:test";
import { MAILBOX_RECORD_VERSION, type MailboxRecord } from "@agentswf/contract/records";
import {
  appendMailbox,
  foldMailbox,
  RunMailbox,
  RunParked,
  readMailbox,
  timerEventId,
} from "./mailbox";
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

test("a timer due fires into the mailbox as timer:due, at its due time, from its name", async () => {
  const runDir = runDirs.tempRunDir();
  const due = Date.parse(at) + 60_000;
  const box = mailbox(runDir, 1, () => due + 5_000);
  box.setTimer("retry", due, "1m");
  expect(await box.receive({ label: "retrying" })).toEqual([
    {
      id: timerEventId("retry"),
      name: "timer:due",
      data: { name: "retry" },
      from: "retry",
      at: new Date(due).toISOString(),
    },
  ]);
  const kinds = (await readMailbox(runDir)).map((r) => r.kind);
  expect(kinds).toEqual(["timer", "wait", "event", "took"]);
});

test("a timer still to come is waited for, and a rerun keeps the time first set", async () => {
  const runDir = runDirs.tempRunDir();
  const box = mailbox(runDir);
  const started = Date.now();
  box.setTimer("retry", started + 80, "80ms");
  expect(ids(await box.receive(undefined))).toEqual([timerEventId("retry")]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  const again = mailbox(runDir, 2);
  await again.open();
  const { timer, asked } = again.setTimer("retry", Date.now() + 10_000, "10s");
  expect(timer.due).toBe(new Date(started + 80).toISOString());
  expect(asked).toBe("10s");
});

test("a cancelled timer doesn't fire, and its timer:due not taken is withdrawn", async () => {
  const runDir = runDirs.tempRunDir();
  const due = Date.parse(at);
  const box = mailbox(runDir, 1, () => due + 1);
  box.setTimer("quiet", due + 10_000, "10s");
  box.setTimer("late", due, "0m");
  await appendMailbox(runDir, { ...event("a"), at: new Date(due + 1).toISOString() });
  expect(ids(await box.receive({ take: "oldest" }))).toEqual([timerEventId("late")]);
  await box.cancelTimer("quiet");
  const state = foldMailbox(await readMailbox(runDir));
  expect(state.timers.get("quiet")?.cancelled).toBe(true);
  expect(ids(await box.receive(undefined))).toEqual(["a"]);
});

test("a race takes only what it names, recorded, and a rerun gets the same answer", async () => {
  const runDir = await withEvents("a");
  await appendMailbox(runDir, event("b", "dd.closed"));
  const box = mailbox(runDir);
  const branches = [
    ["closed", { name: "dd.closed" }],
    ["nudge", { name: "timer:due", from: "ask@nudge" }],
  ] as const;
  box.setTimer("ask@nudge", Date.now() + 60_000, "1m");
  const owned = new Map([["nudge", "ask@nudge"]]);
  const won = await box.race("ask", branches, owned, undefined);
  expect(won.branch).toBe("closed");
  expect(won.event.id).toBe("b");
  // The loser, the race's own timer, is cancelled; what it didn't name stays.
  const state = foldMailbox(await readMailbox(runDir));
  expect(state.timers.get("ask@nudge")?.cancelled).toBe(true);
  expect(state.unacknowledged).toEqual(["a"]);
  const again = await mailbox(runDir, 2).race("ask", branches, owned, undefined);
  expect(again).toEqual(won);
});

test("a race leaves a loop's batch held: after a crash, the next receive returns it", async () => {
  const runDir = await withEvents("a");
  const box = mailbox(runDir);
  expect(ids(await box.receive(undefined))).toEqual(["a"]);
  await appendMailbox(runDir, event("b", "dd.closed"));
  await box.race("closed", [["closed", { name: "dd.closed" }]], new Map(), undefined);
  // The attempt died handling a: the race acknowledged nothing of the loop's.
  expect(ids(await mailbox(runDir, 2).receive(undefined))).toEqual(["a"]);
});

test("select takes one event it names at a time; after a crash, the one held comes back once", async () => {
  const runDir = await withEvents("a", "b");
  await appendMailbox(runDir, event("c", "dd.closed"));
  const takes = [{ name: "dd.changes" }];
  const box = mailbox(runDir);
  expect((await box.select(takes, undefined)).id).toBe("a");
  const again = mailbox(runDir, 2);
  expect((await again.select(takes, undefined)).id).toBe("a");
  expect((await again.select(takes, undefined)).id).toBe("b");
  expect(foldMailbox(await readMailbox(runDir)).unacknowledged).toEqual(["c"]);
});

test("ready events are taken in order of their at: a timer fired late takes its place", async () => {
  const runDir = runDirs.tempRunDir();
  const due = Date.parse(at);
  await appendMailbox(runDir, { ...event("later"), at: new Date(due + 1_000).toISOString() });
  const box = mailbox(runDir, 1, () => due + 5_000);
  box.setTimer("early", due, "0m");
  expect(ids(await box.receive(undefined))).toEqual([timerEventId("early"), "later"]);
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
  await expect(box.receive({ until: 1 } as never)).rejects.toThrow("a timer");
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
