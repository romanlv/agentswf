import { afterAll, expect, test } from "bun:test";
import type { EventLine, RunLine } from "@agentswf/contract/records";
import { timerEventId } from "./event-ids";
import { appendIn } from "./in-lines";
import { claimRunLines, readRunLines } from "./run-lines";
import { createTempRunDirs } from "./testing";
import { RunParked, RunWaits, readWaits } from "./waits";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const at = "2026-10-25T12:00:00.000Z";
const event = (id: string, name = "dd.changes"): EventLine => ({
  at,
  id,
  name,
  data: { id },
  from: "operator",
});

/** Attempt `attempt`'s waits, its claim made. */
async function waitsOf(runDir: string, attempt = 1, now?: () => number): Promise<RunWaits> {
  return new RunWaits({
    runDir,
    lines: await claimRunLines(runDir, attempt, new Date().toISOString()),
    locked: (work) => work(),
    ...(now ? { now } : {}),
  });
}

async function withEvents(...ids: string[]): Promise<string> {
  const runDir = runDirs.tempRunDir();
  for (const id of ids) await appendIn(runDir, event(id));
  return runDir;
}

const stateOf = (runDir: string) => readWaits(runDir, Date.now());
const kinds = async (runDir: string) => (await readRunLines(runDir)).lines.map((line) => line.kind);
const ids = (events: { id: string }[]) => events.map((e) => e.id);
/** A run whose agents hold no window. */
const NO_WINDOW = { timeout: async () => false, liveUntil: () => undefined };

test("a wait takes every waiting event in arrival order, and the next acknowledges them", async () => {
  const runDir = await withEvents("a", "b");
  const box = await waitsOf(runDir);
  expect(ids(await box.receive(undefined))).toEqual(["a", "b"]);
  await appendIn(runDir, event("c"));
  expect(ids(await box.receive(undefined))).toEqual(["c"]);
  expect((await stateOf(runDir)).unacknowledged).toEqual([]);
});

test("an id appended twice is one event, the first kept", async () => {
  const runDir = await withEvents("a");
  await appendIn(runDir, { ...event("a"), data: { second: true } });
  const taken = await (await waitsOf(runDir)).receive(undefined);
  expect(taken).toEqual([{ id: "a", name: "dd.changes", data: { id: "a" }, from: "operator", at }]);
});

test("after a crash, the first wait returns the batch taken and not acknowledged, alone", async () => {
  const runDir = await withEvents("a", "b");
  expect(ids(await (await waitsOf(runDir, 1)).receive(undefined))).toEqual(["a", "b"]);
  // The attempt died handling them; meanwhile c arrived.
  await appendIn(runDir, event("c"));
  const next = await waitsOf(runDir, 2);
  expect(ids(await next.receive(undefined))).toEqual(["a", "b"]);
  expect(ids(await next.receive(undefined))).toEqual(["c"]);
});

test("a timer due is taken as timer:due, at its due time, from its name, never written as an event", async () => {
  const runDir = runDirs.tempRunDir();
  const due = Date.parse(at) + 60_000;
  const box = await waitsOf(runDir, 1, () => due + 5_000);
  box.setTimer("retry", due, "1m");
  expect(await box.receive("retrying")).toEqual([
    {
      id: timerEventId("retry"),
      name: "timer:due",
      data: { name: "retry" },
      from: "retry",
      at: new Date(due).toISOString(),
    },
  ]);
  expect(await kinds(runDir)).toEqual(["claimed", "timer", "wait", "took"]);
  const { lines } = await readRunLines(runDir);
  expect(lines.at(-1)).toMatchObject({ took: [{ id: timerEventId("retry"), timer: "retry" }] });
});

test("a timer still to come is waited for, and a rerun keeps the time first set", async () => {
  const runDir = runDirs.tempRunDir();
  const box = await waitsOf(runDir);
  const started = Date.now();
  box.setTimer("retry", started + 80, "80ms");
  expect(ids(await box.receive(undefined))).toEqual([timerEventId("retry")]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  const again = await waitsOf(runDir, 2);
  await again.open();
  const { timer, asked } = again.setTimer("retry", Date.now() + 10_000, "10s");
  expect(timer.due).toBe(new Date(started + 80).toISOString());
  expect(asked).toBe("10s");
});

test("a cancelled timer doesn't fire, and one due and not taken is withdrawn", async () => {
  const runDir = runDirs.tempRunDir();
  const due = Date.parse(at);
  let clock = due + 1;
  const box = await waitsOf(runDir, 1, () => clock);
  box.setTimer("quiet", due + 10_000, "10s");
  box.setTimer("late", due, "0m");
  box.setTimer("dropped", due, "0m");
  await appendIn(runDir, { ...event("a"), at: new Date(due + 1).toISOString() });
  // Due, and not taken by a wait that doesn't name it: cancelled, it is withdrawn.
  const select = [{ name: "dd.changes" }, { name: "timer:due", from: "late" }];
  expect((await box.select(select, undefined)).id).toBe(timerEventId("late"));
  await box.cancelTimer("dropped");
  await box.cancelTimer("quiet");
  clock = due + 60_000;
  const state = await readWaits(runDir, clock);
  expect(state.timers.get("quiet")?.cancelled).toBe(true);
  expect(state.unacknowledged).toEqual(["a"]);
  expect(ids(await box.receive(undefined))).toEqual(["a"]);
});

test("a race takes only what it names, recorded, and a rerun gets the same answer", async () => {
  const runDir = await withEvents("a");
  await appendIn(runDir, event("b", "dd.closed"));
  const box = await waitsOf(runDir);
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
  const state = await stateOf(runDir);
  expect(state.timers.get("ask@nudge")?.cancelled).toBe(true);
  expect(state.unacknowledged).toEqual(["a"]);
  const again = await (await waitsOf(runDir, 2)).race("ask", branches, owned, undefined);
  expect(again).toEqual(won);
});

test("a race leaves a loop's batch held: after a crash, the next receive returns it", async () => {
  const runDir = await withEvents("a");
  const box = await waitsOf(runDir);
  expect(ids(await box.receive(undefined))).toEqual(["a"]);
  await appendIn(runDir, event("b", "dd.closed"));
  await box.race("closed", [["closed", { name: "dd.closed" }]], new Map(), undefined);
  // The attempt died handling a: the race acknowledged nothing of the loop's.
  expect(ids(await (await waitsOf(runDir, 2)).receive(undefined))).toEqual(["a"]);
});

test("select takes one event it names at a time; after a crash, the one held comes back once", async () => {
  const runDir = await withEvents("a", "b");
  await appendIn(runDir, event("c", "dd.closed"));
  const takes = [{ name: "dd.changes" }];
  const box = await waitsOf(runDir);
  expect((await box.select(takes, undefined)).id).toBe("a");
  const again = await waitsOf(runDir, 2);
  expect((await again.select(takes, undefined)).id).toBe("a");
  expect((await again.select(takes, undefined)).id).toBe("b");
  expect((await stateOf(runDir)).unacknowledged).toEqual(["c"]);
});

test("ready events are taken in order of their at: a timer fired late takes its place", async () => {
  const runDir = runDirs.tempRunDir();
  const due = Date.parse(at);
  await appendIn(runDir, { ...event("later"), at: new Date(due + 1_000).toISOString() });
  const box = await waitsOf(runDir, 1, () => due + 5_000);
  box.setTimer("early", due, "0m");
  expect(ids(await box.receive(undefined))).toEqual([timerEventId("early"), "later"]);
});

test("a waiting receive takes an event appended later, nudged or not", async () => {
  const runDir = runDirs.tempRunDir();
  const box = await waitsOf(runDir);
  const waiting = box.receive(undefined);
  await appendIn(runDir, event("a"));
  box.nudge();
  expect(ids(await waiting)).toEqual(["a"]);
  // A nudge lost: the poll still finds it.
  const unnudged = box.receive(undefined);
  await appendIn(runDir, event("b"));
  expect(ids(await unnudged)).toEqual(["b"]);
});

test("a wait in a stage holds its batch: acknowledged at once, and read back by the stage", async () => {
  const runDir = await withEvents("a");
  const box = await waitsOf(runDir);
  expect(ids(await box.receive(undefined, "approval-1"))).toEqual(["a"]);
  await appendIn(runDir, event("b"));
  // A later attempt, rerun from the top, gets the stage's batch, not b.
  const next = await waitsOf(runDir, 2);
  expect(ids((await next.batchOf("approval-1")) ?? [])).toEqual(["a"]);
  expect(ids(await next.receive(undefined))).toEqual(["b"]);
});

test("a stage that took its batch and failed, or died before its record, gets it again", async () => {
  const runDir = await withEvents("a");
  expect(ids(await (await waitsOf(runDir, 1)).receive(undefined, "approval-1"))).toEqual(["a"]);
  await appendIn(runDir, event("b"));
  const rerun = await waitsOf(runDir, 2);
  expect(ids(await rerun.receive(undefined, "approval-1"))).toEqual(["a"]);
  // Nothing was written for it, and b still waits for the loop.
  expect(ids(await rerun.receive(undefined))).toEqual(["b"]);
});

test("a first wait in a stage leaves a crash's held batch to the first wait outside one", async () => {
  const runDir = await withEvents("a");
  expect(ids(await (await waitsOf(runDir, 1)).receive(undefined))).toEqual(["a"]);
  await appendIn(runDir, event("b"));
  const next = await waitsOf(runDir, 2);
  expect(ids(await next.receive(undefined, "approval-1"))).toEqual(["b"]);
  expect(ids(await next.receive(undefined))).toEqual(["a"]);
});

test("an event sent as the run parks is taken: parking checks again under the run's lock", async () => {
  const runDir = runDirs.tempRunDir();
  let parked = false;
  let first = true;
  const box = new RunWaits({
    runDir,
    lines: await claimRunLines(runDir, 1, at),
    // A sender that got the lock just before the park did: its event is in when the park looks.
    locked: async (work) => {
      if (first) {
        first = false;
        await appendIn(runDir, event("late"));
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
  const box = new RunWaits({
    runDir,
    lines: await claimRunLines(runDir, 1, at),
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
  await expect(box.receive("idle")).rejects.toBeInstanceOf(RunParked);
  // The wait's own line is the attempt's, written without the lock; the last check and the ending
  // are made under it.
  expect(order).toEqual(["lock", "park idle", "unlock"]);
});

test("while a turn runs, the wait doesn't park, and parks once it has ended", async () => {
  const runDir = runDirs.tempRunDir();
  let busy = true;
  setTimeout(() => {
    busy = false;
  }, 50);
  const box = new RunWaits({
    runDir,
    lines: await claimRunLines(runDir, 1, at),
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
  const box = new RunWaits({
    runDir,
    lines: await claimRunLines(runDir, 1, at),
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
  await appendIn(runDir, event("first"));
  const calls: string[] = [];
  let due = true;
  const box = new RunWaits({
    runDir,
    lines: await claimRunLines(runDir, 1, at),
    locked: (work) => work(),
    parking: {
      idle: () => true,
      timeout: async () => {
        if (!due) return false;
        due = false;
        calls.push("handler");
        await appendIn(runDir, event("during"));
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
  const box = new RunWaits({
    runDir,
    lines: await claimRunLines(runDir, 1, at),
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

test("a race recorded before its loser's cancel was written cancels it on the rerun", async () => {
  const runDir = await withEvents("a");
  await appendIn(runDir, event("b", "dd.closed"));
  const branches = [
    ["closed", { name: "dd.closed" }],
    ["nudge", { name: "timer:due", from: "ask@nudge" }],
  ] as const;
  const owned = new Map([["nudge", "ask@nudge"]]);
  // The attempt died after its win and before its cancel.
  const due = new Date(Date.now() + 60_000).toISOString();
  const first = await claimRunLines(runDir, 1, at);
  const lines: RunLine[] = [
    { kind: "timer", attempt: 1, at, name: "ask@nudge", due, when: "1m" },
    { kind: "wait", attempt: 1, at, race: "ask" },
    { kind: "race", attempt: 1, at, name: "ask", branch: "closed", took: [{ id: "b" }] },
  ];
  for (const line of lines) await first.append(line);
  const again = await waitsOf(runDir, 2);
  await again.open();
  expect((await again.race("ask", branches, owned, undefined)).branch).toBe("closed");
  expect((await stateOf(runDir)).timers.get("ask@nudge")?.cancelled).toBe(true);
});

test("a rerun's first select leaves a held event it doesn't take waiting, not acknowledged", async () => {
  const runDir = await withEvents("x");
  await appendIn(runDir, event("y", "dd.closed"));
  const box = await waitsOf(runDir);
  expect((await box.select([{ name: "dd.changes" }], undefined)).id).toBe("x");
  expect((await box.select([{ name: "dd.closed" }], undefined)).id).toBe("y");
  // The attempt died handling y; the rerun's first select takes dd.changes only.
  await appendIn(runDir, event("z"));
  const again = await waitsOf(runDir, 2);
  expect((await again.select([{ name: "dd.changes" }], undefined)).id).toBe("z");
  expect((await again.select([{ name: "dd.closed" }], undefined)).id).toBe("y");
});

test("two waits at once, in parallel branches, never take one event both", async () => {
  const runDir = await withEvents("a");
  const box = await waitsOf(runDir);
  const first = box.receive(undefined, "left");
  const second = box.receive(undefined, "right");
  await Bun.sleep(50);
  await appendIn(runDir, event("b"));
  box.nudge();
  const taken = [...(await first), ...(await second)].map((e) => e.id).sort();
  expect(taken).toEqual(["a", "b"]);
});

test("a turn's end wakes every wait idle at once, not only the last to start", async () => {
  const runDir = runDirs.tempRunDir();
  const box = await waitsOf(runDir);
  const end = (agent: string) =>
    box.endTurn(agent, {
      turn: `${agent}-1`,
      meta: null,
      outcome: { answered: true, kind: "answered", value: "done" } as never,
    });
  // No parking: a run that waits in its process. The second wait to start is the one a single
  // waker would have kept.
  const first = box.select([{ name: "agent:ended", from: "a" }], undefined);
  await Bun.sleep(20);
  const second = box.select([{ name: "agent:ended", from: "b" }], undefined);
  await Bun.sleep(20);
  await end("b");
  expect((await second).from).toBe("b");
  const started = Date.now();
  await end("a");
  expect((await first).from).toBe("a");
  // Woken by the nudge, not found by the poll a second later.
  expect(Date.now() - started).toBeLessThan(500);
});
