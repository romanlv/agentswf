import { describe, expect, test } from "bun:test";
import type { EventLine, RunLine } from "@agentswf/contract/records";
import {
  type DerivedIds,
  firstReceive,
  firstSelect,
  foldWaits,
  hasWork,
  restoredTurns,
  unendedTurns,
  unfenced,
  type WaitState,
  wakeCause,
} from "./waits";

const ids: DerivedIds = {
  timer: (name) => `awf.timer.${name}`,
  at: (branch, due) => `awf.at.${branch}.${due}`,
};
const T = Date.parse("2026-11-05T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const at = iso(T);
const event = (id: string, when = at, name = "dd.changes"): EventLine => ({
  at: when,
  id,
  name,
  data: {},
  from: "operator",
});
const fold = (lines: RunLine[], events: EventLine[] = [], now = T): WaitState =>
  foldWaits({ lines, events, now, ids });
const claimed = (attempt: number): RunLine => ({ kind: "claimed", attempt, at });
const started = (agent: string, turn: string, attempt = 1): RunLine => ({
  kind: "turn-started",
  attempt,
  at,
  agent,
  turn,
  meta: null,
  execution: { harness: "codex", model: "m" },
});
const ended = (agent: string, turn: string, began: number, attempt = began): RunLine => ({
  kind: "turn-ended",
  attempt,
  at,
  id: `awf.end.${agent}.${turn}.${began}`,
  agent,
  turn,
  began,
  end: {
    turn,
    meta: null,
    outcome: {
      answered: false,
      kind: "cancelled",
      usage: {
        callPath: [],
        agent,
        operationId: turn,
        execution: { harness: "codex", model: "m" },
        sessions: [],
      },
    },
  } as never,
});

describe("what a wait can take", () => {
  test("in.jsonl's events, the turns' ends and the timers due, by time, then timer, end, event", () => {
    const state = fold(
      [
        claimed(1),
        { kind: "timer", attempt: 1, at, name: "nudge", due: at, when: "0m" },
        started("a", "t1"),
        ended("a", "t1", 1),
      ],
      [event("later", iso(T + 1)), event("x"), event("y")],
    );
    expect(state.unacknowledged).toEqual(["awf.timer.nudge", "awf.end.a.t1.1", "x", "y", "later"]);
  });

  test("a timer is an event only once due, by the clock it is folded at, and once taken never again", () => {
    const timer: RunLine = {
      kind: "timer",
      attempt: 1,
      at,
      name: "nudge",
      due: iso(T + 60_000),
      when: "1m",
    };
    expect(fold([timer], [], T).unacknowledged).toEqual([]);
    expect(fold([timer], [], T).timers.get("nudge")?.fired).toBe(false);
    expect(fold([timer], [], T + 60_000).unacknowledged).toEqual(["awf.timer.nudge"]);
    const taken: RunLine[] = [
      timer,
      { kind: "wait", attempt: 1, at },
      { kind: "took", attempt: 1, at, took: [{ id: "awf.timer.nudge", timer: "nudge" }] },
      { kind: "wait", attempt: 1, at, acks: ["awf.timer.nudge"] },
    ];
    const later = fold(taken, [], T + 3_600_000);
    expect(later.unacknowledged).toEqual([]);
    expect(later.timers.get("nudge")).toMatchObject({ taken: true, fired: true });
  });

  test("a cancelled timer is withdrawn, due or not", () => {
    const lines: RunLine[] = [
      { kind: "timer", attempt: 1, at, name: "nudge", due: at, when: "0m" },
      { kind: "timer", attempt: 1, at, name: "nudge", due: at, when: "0m", cancelled: true },
    ];
    const state = fold(lines, [], T + 1);
    expect(state.unacknowledged).toEqual([]);
    expect(state.timers.get("nudge")?.cancelled).toBe(true);
  });

  test("an id given twice is one event, the first kept", () => {
    const state = fold([], [event("a"), { ...event("a"), name: "dd.closed" }]);
    expect(state.unacknowledged).toEqual(["a"]);
    expect(state.events.get("a")?.name).toBe("dd.changes");
  });
});

describe("taking and acknowledging", () => {
  test("a took outside a stage is held until a wait acknowledges it by its acks", () => {
    const took: RunLine[] = [
      claimed(1),
      { kind: "wait", attempt: 1, at },
      { kind: "took", attempt: 1, at, took: [{ id: "a" }, { id: "b" }] },
    ];
    const held = fold(took, [event("a"), event("b"), event("c")]);
    expect(held.held).toEqual(["a", "b"]);
    expect(held.unacknowledged).toEqual(["c"]);
    expect(firstReceive(held)).toEqual(["a", "b"]);
    const acked = fold(
      [...took, { kind: "wait", attempt: 1, at, acks: ["a", "b"] }],
      [event("a"), event("b"), event("c")],
    );
    expect(acked.held).toBeUndefined();
    expect(acked.unacknowledged).toEqual(["c"]);
    expect(acked.lastWait?.waiting).toBe(true);
  });

  test("a first wait that returns the held batch hands it back to waiting", () => {
    const lines: RunLine[] = [
      { kind: "wait", attempt: 1, at, takes: [{ name: "dd.changes" }] },
      { kind: "took", attempt: 1, at, took: [{ id: "a" }] },
      claimed(2),
      { kind: "wait", attempt: 2, at, takes: [{ name: "dd.closed" }], returns: true },
    ];
    const state = fold(lines, [event("a")]);
    expect(state.held).toBeUndefined();
    expect(state.unacknowledged).toEqual(["a"]);
  });

  test("a stage's took, from before beta.6, and a race acknowledge their own at once", () => {
    const lines: RunLine[] = [
      { kind: "wait", attempt: 1, at, stage: "approve" },
      { kind: "took", attempt: 1, at, took: [{ id: "a" }], stage: "approve" },
      { kind: "wait", attempt: 1, at, race: "r" },
      { kind: "race", attempt: 1, at, name: "r", branch: "closed", took: [{ id: "b" }] },
      { kind: "race", attempt: 2, at, name: "r", branch: "other", took: [{ id: "c" }] },
    ];
    const state = fold(lines, [event("a"), event("b"), event("c")]);
    expect(state.unacknowledged).toEqual([]);
    expect(state.races.get("r")).toEqual({ branch: "closed", ids: ["b"] });
  });

  test("a held time read from state is the select's: a receive leaves it, a select returns it while state says it", () => {
    const due = iso(T - 1);
    const id = ids.at("nudge", due);
    const lines: RunLine[] = [
      { kind: "wait", attempt: 1, at, takes: [{ name: "at:due", from: "nudge", due }] },
      { kind: "took", attempt: 1, at, took: [{ id, branch: "nudge", due }] },
    ];
    const state = fold(lines);
    expect(firstReceive(state)).toBeUndefined();
    expect(firstSelect(state, [{ name: "at:due", from: "nudge", due }])).toMatchObject({
      event: { id, name: "at:due", from: "nudge", at: due },
    });
    expect(firstSelect(state, [{ name: "at:due", from: "nudge", due: iso(T + 1) }])).toEqual({
      returns: false,
    });
  });
});

describe("waking", () => {
  const parked = (takes: RunLine & { kind: "wait" }): RunLine[] => [
    { kind: "timer", attempt: 1, at, name: "retry", due: iso(T + 60_000), when: "1m" },
    takes,
  ];

  test("a parked run is woken by an event its wait takes, or its timer due, and nothing else", () => {
    const lines = parked({
      kind: "wait",
      attempt: 1,
      at,
      takes: [{ name: "timer:due", from: "retry" }, { name: "dd.closed" }],
    });
    const quiet = fold(lines, [event("x")], T);
    expect(wakeCause(quiet, quiet.lastWait?.takes)).toBeUndefined();
    const timer = fold(lines, [event("x")], T + 60_000);
    expect(wakeCause(timer, timer.lastWait?.takes)).toBe("timer");
    const closed = fold(lines, [event("x"), event("c", at, "dd.closed")], T + 60_000);
    expect(wakeCause(closed, closed.lastWait?.takes)).toBe("event");
    expect(hasWork(quiet, quiet.lastWait?.takes)).toBe(false);
  });
});

describe("the fence and turns", () => {
  test("a line of an attempt before the latest claim is ignored", () => {
    const lines: RunLine[] = [
      claimed(1),
      claimed(2),
      { kind: "took", attempt: 1, at, took: [{ id: "a" }] },
    ];
    expect(unfenced(lines).map((line) => line.kind)).toEqual(["claimed", "claimed"]);
    expect(fold(lines, [event("a")]).held).toBeUndefined();
  });

  test("a turn is its agent, its id and the attempt that began it: each needs its own end", () => {
    const lines: RunLine[] = [
      claimed(1),
      started("a", "t1"),
      started("b", "t2"),
      ended("a", "t1", 1),
      claimed(2),
      // Code rerun from the top begins t1 again: a turn of its own, with no end yet.
      started("a", "t1", 2),
      // A stale end attempt 1 wrote after attempt 2's claim is fenced.
      ended("b", "t2", 1),
    ];
    expect(unendedTurns(lines).map((turn) => [turn.agent, turn.turn, turn.attempt])).toEqual([
      ["b", "t2", 1],
      ["a", "t1", 2],
    ]);
  });

  test("an agent's turn whose end no wait took is restored, one taken is not", () => {
    const lines: RunLine[] = [
      started("a", "t1"),
      started("b", "t2"),
      ended("a", "t1", 1),
      ended("b", "t2", 1),
      { kind: "wait", attempt: 1, at },
      { kind: "took", attempt: 1, at, took: [{ id: "awf.end.b.t2.1" }] },
      { kind: "wait", attempt: 1, at, acks: ["awf.end.b.t2.1"] },
    ];
    expect([...restoredTurns(fold(lines))]).toEqual([["a", { turn: "t1", meta: null }]]);
  });
});
