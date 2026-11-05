import { afterAll, expect, test } from "bun:test";
import type { EventLine } from "@agentswf/contract/records";
import { atEventId } from "./event-ids";
import { appendIn } from "./in-lines";
import { claimRunLines, readRunLines } from "./run-lines";
import { hasWork } from "./run-policy/waits";
import { caseRun, createTempRunDirs, startCase } from "./testing";
import { RunParked, RunWaits, readWaits } from "./waits";
import { testWorkflow } from "./workflow-testing";

const HOUR = 3_600_000;
const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

test("a time read from state comes due as the state says: moved later, it doesn't fire early", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const started = workflow.now().getTime();
      const hours = () => Math.round((workflow.now().getTime() - started) / HOUR);
      const state = { nudge: workflow.after("2h") as Date | null, nudges: 0 };
      const seen: string[] = [];
      for await (const next of workflow.select({
        changes: workflow.signal("dd.changes"),
        nudge: workflow.at(() => state.nudge),
      })) {
        seen.push(`${next.key}@${hours()}`);
        if (next.changes) state.nudge = workflow.after("3h");
        if (next.nudge) {
          state.nudges += 1;
          state.nudge = state.nudges === 1 ? workflow.after("5h") : null;
          if (state.nudges === 2) return seen;
        }
      }
      return seen;
    }),
    startCase,
  );
  // Moved from 2h to 3h by the starting event; then 5h after the first nudge.
  expect(run.value).toEqual(["changes@0", "nudge@3", "nudge@8"]);
});

test("null is no deadline, and a time returned and left in state neither spins nor parks on it", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const state = { nudge: workflow.after("1h"), retry: null as Date | null };
      let nudges = 0;
      for await (const next of workflow.select({
        changes: workflow.signal("dd.changes"),
        nudge: workflow.at(() => state.nudge),
        retry: workflow.at(() => state.retry),
      })) {
        if (next.nudge) nudges += 1;
        if (next.retry) return "retried";
        if (nudges > 1) return "nudged twice";
      }
      return "ended";
    }),
    startCase,
  );
  expect(run.ending).toMatchObject({ kind: "parked" });
  expect(() => run.value).toThrow("the run parked");
});

test("a ready event comes before a time due, and of two times due at once the first declared", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const long = new Date(0);
      const seen: string[] = [];
      for await (const next of workflow.select({
        second: workflow.at(() => long),
        changes: workflow.signal("dd.changes"),
        first: workflow.at(() => long),
      })) {
        seen.push(next.key === "second" ? `second@${next.second.at}` : next.key);
        if (seen.length === 3) return seen;
      }
      return seen;
    }),
    startCase,
  );
  // Both due in 1970, long before the event: the event first, then the branch declared first.
  expect(run.value).toEqual(["changes", `second@${new Date(0).toISOString()}`, "first"]);
});

test("a read is refused what would never come due, and a race refuses a time read from state", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const errors: string[] = [];
      const attempt = async (branch: () => Date | null) => {
        try {
          for await (const _ of workflow.select({ due: workflow.at(branch) })) break;
        } catch (error) {
          errors.push((error as Error).message);
        }
      };
      await attempt(() => workflow.now());
      await attempt(() => workflow.after("1h"));
      await attempt(() => new Date(Number.NaN));
      await attempt(() => "2026-10-31T09:00:00Z" as unknown as Date);
      await attempt(() => {
        throw new Error("the ledger is torn");
      });
      try {
        // @ts-expect-error a race takes a timer, not a time read from state
        await workflow.race("r", { due: workflow.at(() => null) });
      } catch (error) {
        errors.push((error as Error).message);
      }
      try {
        await workflow.sleep("s", workflow.at(() => null) as unknown as Date);
      } catch (error) {
        errors.push((error as Error).message);
      }
      try {
        workflow.after("3 hours" as "3h");
      } catch (error) {
        errors.push((error as Error).message);
      }
      try {
        workflow.at("1h" as unknown as () => Date);
      } catch (error) {
        errors.push((error as Error).message);
      }
      return errors;
    }),
    startCase,
  );
  const errors = run.value as string[];
  expect(errors[0]).toContain("wf.now() in wf.at's read");
  expect(errors[1]).toContain("wf.after() in wf.at's read");
  expect(errors[2]).toContain("not an invalid Date");
  expect(errors[3]).toContain('not "2026-10-31T09:00:00Z"');
  expect(errors[4]).toBe("the ledger is torn");
  expect(errors[5]).toContain("race r's due is wf.at(), a select's");
  expect(errors[6]).toContain("wf.at() is a select's branch");
  expect(errors[7]).toContain(
    "wf.after takes a duration: a duration is a decimal and s, m, h or d",
  );
  expect(errors[8]).toContain("wf.at takes a function");
});

const at = "2026-10-25T12:00:00.000Z";
const T = Date.parse(at);
const event = (id: string, name = "dd.changes"): EventLine => ({
  at,
  id,
  name,
  data: {},
  from: "operator",
});
const AT_DUE = "at:due";

/** Attempt `attempt`'s waits, its claim made. */
async function waitsOf(runDir: string, attempt: number, now: () => number): Promise<RunWaits> {
  const lines = await claimRunLines(runDir, attempt, new Date(now()).toISOString());
  return new RunWaits({ runDir, lines, locked: (work) => work(), now });
}

/** Whether the run's last wait has something to take at `now`, as a wake asks. */
async function dueAt(runDir: string, now: number): Promise<boolean> {
  const state = await readWaits(runDir, now);
  return hasWork(state, state.lastWait?.takes);
}

const nudgeAt = (due: number | null) => () => [
  { name: "dd.changes" },
  { name: AT_DUE, from: "nudge", ...(due === null ? {} : { due: new Date(due).toISOString() }) },
];

test("after a crash, a time returned comes back once if the state still says it, and not if it moved", async () => {
  const runDir = runDirs.tempRunDir();
  const now = () => T + 2 * HOUR;
  const due = T + HOUR;
  const first = await (await waitsOf(runDir, 1, now)).select(nudgeAt(due), undefined);
  expect(first).toMatchObject({ name: AT_DUE, from: "nudge", at: new Date(due).toISOString() });
  // The attempt died handling it; the state still says that time.
  const again = await (await waitsOf(runDir, 2, now)).select(nudgeAt(due), undefined);
  expect(again.id).toBe(first.id);
  // It died again, and this time the handler had moved the time on: an event is taken instead.
  await appendIn(runDir, event("x"));
  const moved = await (await waitsOf(runDir, 3, now)).select(nudgeAt(T + 5 * HOUR), undefined);
  expect(moved.id).toBe("x");
  const state = await readWaits(runDir, now());
  expect(state.unacknowledged).toEqual([]);
  expect(state.held).toEqual(["x"]);
});

test("after a crash, a receive acknowledges a time a select returned rather than taking it", async () => {
  const runDir = runDirs.tempRunDir();
  const now = () => T + 2 * HOUR;
  await (await waitsOf(runDir, 1, now)).select(nudgeAt(T + HOUR), undefined);
  await appendIn(runDir, event("x"));
  const taken = await (await waitsOf(runDir, 2, now)).receive(undefined);
  expect(taken.map((e) => e.id)).toEqual(["x"]);
});

test("a parked run waits until the time it read, wakes then, and not again for a time returned", async () => {
  const runDir = runDirs.tempRunDir();
  let clock = T;
  const parked: { until?: string }[] = [];
  const box = new RunWaits({
    runDir,
    lines: await claimRunLines(runDir, 1, at),
    locked: (work) => work(),
    now: () => clock,
    parking: {
      idle: () => true,
      timeout: async () => false,
      liveUntil: () => undefined,
      park: async (wait) => {
        parked.push(wait);
      },
    },
  });
  const due = T + HOUR;
  await expect(box.select(nudgeAt(due), undefined)).rejects.toBeInstanceOf(RunParked);
  expect(parked).toEqual([{ until: new Date(due).toISOString() }]);
  expect(await dueAt(runDir, due - 1)).toBe(false);
  expect(await dueAt(runDir, due)).toBe(true);
  // Woken, the rerun takes it; left in state, it is no deadline and nothing to wake for.
  clock = due;
  expect((await (await waitsOf(runDir, 2, () => clock)).select(nudgeAt(due), undefined)).id).toBe(
    atEventId("nudge", new Date(due).toISOString()),
  );
  clock = due + 10 * HOUR;
  const after = new RunWaits({
    runDir,
    lines: await claimRunLines(runDir, 3, at),
    locked: (work) => work(),
    now: () => clock,
    parking: {
      idle: () => true,
      timeout: async () => false,
      liveUntil: () => undefined,
      park: async (wait) => {
        parked.push(wait);
      },
    },
  });
  // The attempt's first select gives back what it took once more, as a crash would: acknowledge it.
  await after.select(nudgeAt(due), undefined);
  await expect(after.select(nudgeAt(due), undefined)).rejects.toBeInstanceOf(RunParked);
  expect(parked.at(-1)).toEqual({});
  expect(await dueAt(runDir, clock)).toBe(false);
});

test("a time moved while the wait waits is seen, and recorded for a parked run's wake", async () => {
  const runDir = runDirs.tempRunDir();
  let clock = T;
  let due: number | null = null;
  const box = await waitsOf(runDir, 1, () => clock);
  const taken = box.select(() => nudgeAt(due)(), undefined);
  await Bun.sleep(20);
  due = T + HOUR;
  clock = T + 2 * HOUR;
  box.nudge();
  expect((await taken).from).toBe("nudge");
  const waits = (await readRunLines(runDir)).lines.filter((line) => line.kind === "wait");
  expect(waits.map((wait) => (wait.kind === "wait" ? wait.takes?.[1]?.due : undefined))).toEqual([
    undefined,
    new Date(T + HOUR).toISOString(),
  ]);
});

test("a time moved while the take read the lines isn't taken", async () => {
  const runDir = runDirs.tempRunDir();
  let due: number | null = T + HOUR;
  let reads = 0;
  const box = await waitsOf(runDir, 1, () => T + 2 * HOUR);
  const read = () => {
    reads += 1;
    // The take's own read: code beside the wait cleared the time first, and then an event came.
    if (reads === 3) {
      due = null;
      void appendIn(runDir, event("x")).then(() => box.nudge());
    }
    return nudgeAt(due)();
  };
  expect((await box.select(read, undefined)).id).toBe("x");
  const took = (await readRunLines(runDir)).lines.flatMap((line) =>
    line.kind === "took" ? line.took : [],
  );
  expect(took).toEqual([{ id: "x" }]);
});
