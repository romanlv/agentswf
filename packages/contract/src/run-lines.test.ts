import { describe, expect, test } from "bun:test";
import type { RunLine } from "./records";
import { readRun } from "./run-lines";

type StageLine = Extract<RunLine, { kind: "stage" }>;

const at = "2026-11-04T10:00:00.000Z";

function stage(
  attempt: number,
  name: string,
  outcome: "succeeded" | "failed" | "stopped" = "succeeded",
  extra: Partial<StageLine> = {},
): StageLine {
  return { kind: "stage", attempt, at, name, outcome, started: at, ...extra };
}

const claimed = (attempt: number): RunLine => ({ kind: "claimed", attempt, at });

describe("readRun", () => {
  test("an empty file reads as nothing settled", () => {
    const view = readRun([]);
    expect(Object.keys(view.stages)).toEqual([]);
    expect(view.redo).toBeUndefined();
    expect(view.wait).toBeUndefined();
    expect(view.sessions.all).toEqual([]);
    expect(view.fenced).toBe(0);
  });

  describe("a stage has two answers", () => {
    test("a failure after a success: last is the failure, settled the success", () => {
      const ok = stage(1, "build", "succeeded", { value: { sha: "a1" } });
      const failed = stage(2, "build", "failed", { reason: "tests broke" });
      const view = readRun([claimed(1), ok, claimed(2), failed]);
      expect(view.stages.build).toEqual({ last: failed, settled: ok, history: [ok, failed] });
    });

    test("a stage that only failed has a last and no settled", () => {
      const failed = stage(1, "qa", "stopped");
      const view = readRun([claimed(1), failed]);
      expect(view.stages.qa?.last).toBe(failed);
      expect(view.stages.qa?.settled).toBeUndefined();
    });

    test("a stage entered twice in one attempt keeps both lines in its history", () => {
      const first = stage(1, "handle", "failed");
      const second = stage(1, "handle", "succeeded");
      const view = readRun([claimed(1), first, second]);
      expect(view.stages.handle?.history).toEqual([first, second]);
      expect(view.stages.handle?.last).toBe(second);
    });
  });

  describe("redo", () => {
    test("the design's three attempts: the redo is build's line in attempt 2", () => {
      const lines = [
        claimed(1),
        stage(1, "plan"),
        stage(1, "build"),
        stage(1, "qa"),
        claimed(2),
        stage(2, "build", "succeeded", { redo: true }),
        stage(2, "qa"),
        claimed(3),
      ];
      const view = readRun(lines);
      expect(view.redo).toEqual({ attempt: 2, stage: "build" });
      expect(view.stages.plan?.settled?.attempt).toBe(1);
      expect(view.stages.build?.settled?.attempt).toBe(2);
      expect(view.stages.qa?.settled?.attempt).toBe(2);
      expect(view.stages.qa?.history.map((line) => line.attempt)).toEqual([1, 2]);
    });

    test("a redo stage that failed is still the redo, and the old value still settles", () => {
      const view = readRun([
        claimed(1),
        stage(1, "build"),
        claimed(2),
        stage(2, "build", "failed", { redo: true }),
      ]);
      expect(view.redo).toEqual({ attempt: 2, stage: "build" });
      expect(view.stages.build?.settled?.attempt).toBe(1);
    });

    test("the latest redo wins", () => {
      const view = readRun([
        claimed(1),
        stage(1, "build", "succeeded", { redo: true }),
        claimed(2),
        stage(2, "qa", "succeeded", { redo: true }),
      ]);
      expect(view.redo).toEqual({ attempt: 2, stage: "qa" });
    });

    test("a redo leaves races, timers and state as they are", () => {
      const view = readRun([
        claimed(1),
        { kind: "race", attempt: 1, at, name: "r", branch: "a", took: [] },
        { kind: "timer", attempt: 1, at, name: "t", due: at, when: "1h" },
        stage(1, "build", "succeeded", { state: [{ name: "n", value: 1 }] }),
        claimed(2),
        stage(2, "build", "succeeded", { redo: true }),
      ]);
      expect(view.races.r?.branch).toBe("a");
      expect(view.timers.t?.due).toBe(at);
      expect(view.state.n).toBe(1);
    });
  });

  describe("state", () => {
    test("each name takes its latest entry; a name not given keeps its value", () => {
      const lines: RunLine[] = [
        claimed(1),
        stage(1, "plan", "succeeded", {
          state: [
            { name: "seen", value: 1 },
            { name: "mode", value: "fast" },
          ],
        }),
        { kind: "wait", attempt: 1, at, state: [{ name: "seen", value: 2 }] },
        stage(1, "build"),
        { kind: "wait", attempt: 1, at },
      ];
      expect({ ...readRun(lines).state }).toEqual({ seen: 2, mode: "fast" });
    });

    test("state saved on a stage line survives a later attempt's stateless wait", () => {
      const view = readRun([
        claimed(1),
        stage(1, "plan", "succeeded", { state: [{ name: "cursor", value: 7 }] }),
        claimed(2),
        { kind: "wait", attempt: 2, at, label: "next" },
      ]);
      expect(view.state.cursor).toBe(7);
    });
  });

  describe("races and timers", () => {
    test("a race is its line", () => {
      const race: RunLine = {
        kind: "race",
        attempt: 1,
        at,
        name: "deadline",
        branch: "reply",
        took: [{ id: "e1" }, { id: "awf.at.1", branch: "reply", due: at }],
      };
      expect(readRun([claimed(1), race]).races.deadline).toBe(race);
    });

    test("a timer is due at its time, and taken once a took names it", () => {
      const view = readRun([
        claimed(1),
        {
          kind: "timer",
          attempt: 1,
          at,
          name: "nag",
          due: "2026-11-05T00:00:00.000Z",
          when: "1d",
        },
        {
          kind: "timer",
          attempt: 1,
          at,
          name: "later",
          due: "2026-11-06T00:00:00.000Z",
          when: "2d",
        },
        {
          kind: "took",
          attempt: 1,
          at,
          took: [{ id: "awf.timer.1", timer: "nag" }, { id: "e1" }],
        },
      ]);
      expect(view.timers.nag).toMatchObject({ due: "2026-11-05T00:00:00.000Z", taken: true });
      expect(view.timers.later).toMatchObject({ taken: false });
      expect(view.timers.later?.cancelled).toBeUndefined();
    });

    test("a race's winner takes its timer", () => {
      const view = readRun([
        claimed(1),
        { kind: "timer", attempt: 1, at, name: "r@sleep", due: at, when: "5m" },
        {
          kind: "race",
          attempt: 1,
          at,
          name: "r",
          branch: "sleep",
          took: [{ id: "awf.timer.2", timer: "r@sleep" }],
        },
      ]);
      expect(view.timers["r@sleep"]?.taken).toBe(true);
    });

    test("a cancelled timer is its line again with cancelled, the latest under its name", () => {
      const view = readRun([
        claimed(1),
        { kind: "timer", attempt: 1, at, name: "nag", due: at, when: "1h" },
        { kind: "timer", attempt: 1, at, name: "other", due: at, when: "1h" },
        claimed(2),
        { kind: "timer", attempt: 2, at, name: "nag", due: at, when: "1h", cancelled: true },
        { kind: "took", attempt: 2, at, took: [{ id: "awf.timer.3", timer: "other" }] },
      ]);
      expect(view.timers.nag).toMatchObject({ attempt: 2, cancelled: true, taken: false });
      expect(view.timers.other).toMatchObject({ attempt: 1, taken: true });
    });
  });

  test("the last wait is the latest wait line", () => {
    const last: RunLine = { kind: "wait", attempt: 2, at, label: "review", returns: true };
    const view = readRun([
      claimed(1),
      { kind: "wait", attempt: 1, at, label: "first" },
      claimed(2),
      last,
    ]);
    expect(view.wait).toBe(last);
  });

  test("sessions: the latest per agent, and every line", () => {
    const a1: RunLine = {
      kind: "session",
      attempt: 1,
      at,
      agent: "coder",
      harness: "claude",
      session: "s1",
    };
    const b1: RunLine = { ...a1, agent: "reviewer", session: "s2" };
    const a2: RunLine = { ...a1, session: "s3", operation: "coder.2" };
    const view = readRun([claimed(1), a1, b1, a2]);
    expect({ ...view.sessions.latest }).toEqual({ coder: a2, reviewer: b1 });
    expect(view.sessions.all).toEqual([a1, b1, a2]);
  });

  test("turn lines are read, and fenced as any line is", () => {
    const ended = (attempt: number): RunLine => ({
      kind: "turn-ended",
      attempt,
      at,
      id: "awf.end.x",
      agent: "coder",
      turn: "t1",
      began: 1,
      end: { turn: "t1", meta: null, outcome: { kind: "failed" } as never },
    });
    const view = readRun([
      claimed(1),
      {
        kind: "turn-started",
        attempt: 1,
        at,
        agent: "coder",
        turn: "t1",
        meta: null,
        execution: { harness: "claude" } as never,
      },
      claimed(2),
      ended(1),
      ended(2),
    ]);
    expect(view.fenced).toBe(1);
  });

  describe("the fence", () => {
    test("a line from an earlier attempt after a later claim is dropped and counted", () => {
      const session = (attempt: number, id: string): RunLine => ({
        kind: "session",
        attempt,
        at,
        agent: "coder",
        harness: "claude",
        session: id,
      });
      const view = readRun([
        claimed(1),
        stage(1, "plan"),
        session(1, "closing"),
        claimed(2),
        session(1, "late"),
        stage(1, "build"),
        { kind: "wait", attempt: 1, at, state: [{ name: "n", value: 1 }] },
        stage(2, "plan", "failed"),
      ]);
      expect(view.fenced).toBe(3);
      expect(view.sessions.latest.coder?.session).toBe("closing");
      expect(view.stages.build).toBeUndefined();
      expect(view.stages.plan?.history.map((line) => line.attempt)).toEqual([1, 2]);
      expect(view.wait).toBeUndefined();
      expect(view.state.n).toBeUndefined();
    });

    test("a claim lower than one already seen doesn't lower the fence", () => {
      const view = readRun([claimed(3), claimed(2), stage(2, "a"), stage(3, "b")]);
      expect(view.fenced).toBe(2);
      expect(Object.keys(view.stages)).toEqual(["b"]);
    });

    test("a fenced took, race or redo counts for nothing", () => {
      const view = readRun([
        claimed(1),
        { kind: "timer", attempt: 1, at, name: "nag", due: at, when: "1h" },
        stage(1, "build"),
        claimed(2),
        { kind: "took", attempt: 1, at, took: [{ id: "awf.timer.1", timer: "nag" }] },
        {
          kind: "race",
          attempt: 1,
          at,
          name: "r",
          branch: "b",
          took: [{ id: "awf.timer.1", timer: "nag" }],
        },
        stage(1, "build", "succeeded", { redo: true }),
      ]);
      expect(view.fenced).toBe(3);
      expect(view.timers.nag?.taken).toBe(false);
      expect(view.races.r).toBeUndefined();
      expect(view.redo).toBeUndefined();
    });

    test("a line from the claiming attempt or a later one is kept", () => {
      const view = readRun([claimed(1), claimed(2), stage(2, "a"), stage(3, "b")]);
      expect(view.fenced).toBe(0);
      expect(Object.keys(view.stages)).toEqual(["a", "b"]);
    });
  });

  describe("refusals name the line", () => {
    test.each([
      [
        "an unknown kind",
        { kind: "stage-replaced", attempt: 1, at },
        'line 2: unknown kind "stage-replaced"',
      ],
      ["no kind", { attempt: 1, at }, "line 2: no kind"],
      ["no attempt", { kind: "claimed", at }, "line 2: claimed without a positive attempt"],
      [
        "attempt zero",
        { kind: "claimed", attempt: 0, at },
        "line 2: claimed without a positive attempt",
      ],
      ["no at", { kind: "claimed", attempt: 1 }, "line 2: claimed without at"],
      ["not an object", "claimed", "line 2: not an object"],
      [
        "a stage without its name",
        { kind: "stage", attempt: 1, at, outcome: "failed", started: at },
        "line 2: stage without name",
      ],
      ["a took without took", { kind: "took", attempt: 1, at }, "line 2: took with malformed took"],
      [
        "malformed state",
        { kind: "wait", attempt: 1, at, state: { n: 1 } },
        "line 2: wait with malformed state",
      ],
      [
        "an unknown outcome",
        { kind: "stage", attempt: 1, at, name: "a", outcome: "skipped", started: at },
        'line 2: stage with unknown outcome "skipped"',
      ],
      [
        "a stage without started",
        { kind: "stage", attempt: 1, at, name: "a", outcome: "failed" },
        "line 2: stage without started",
      ],
      [
        "a flag not true",
        { kind: "stage", attempt: 1, at, name: "a", outcome: "failed", started: at, redo: false },
        "line 2: stage with redo not true",
      ],
      [
        "provided not true",
        {
          kind: "stage",
          attempt: 1,
          at,
          name: "a",
          outcome: "succeeded",
          started: at,
          provided: 1,
        },
        "line 2: stage with provided not true",
      ],
      [
        "cancelled not true",
        { kind: "timer", attempt: 1, at, name: "t", due: at, when: "1h", cancelled: "yes" },
        "line 2: timer with cancelled not true",
      ],
      [
        "returns not true",
        { kind: "wait", attempt: 1, at, returns: null },
        "line 2: wait with returns not true",
      ],
      [
        "a timer without when",
        { kind: "timer", attempt: 1, at, name: "t", due: at },
        "line 2: timer without when",
      ],
      [
        "a race without its branch",
        { kind: "race", attempt: 1, at, name: "r", took: [] },
        "line 2: race without branch",
      ],
      [
        "a session without its session",
        { kind: "session", attempt: 1, at, agent: "a", harness: "claude" },
        "line 2: session without session",
      ],
      [
        "a session without its harness",
        { kind: "session", attempt: 1, at, agent: "a", session: "s" },
        "line 2: session without harness",
      ],
      [
        "a took entry without an id",
        { kind: "took", attempt: 1, at, took: [{ timer: "t" }] },
        "line 2: took with malformed took",
      ],
      [
        "a took entry with a timer not a string",
        { kind: "took", attempt: 1, at, took: [{ id: "e", timer: 1 }] },
        "line 2: took with malformed took",
      ],
      [
        "a race's took not an array",
        { kind: "race", attempt: 1, at, name: "r", branch: "b", took: {} },
        "line 2: race with malformed took",
      ],
      [
        "a state entry without a value",
        { kind: "wait", attempt: 1, at, state: [{ name: "n" }] },
        "line 2: wait with malformed state",
      ],
      [
        "provided on a failed stage",
        {
          kind: "stage",
          attempt: 1,
          at,
          name: "a",
          outcome: "failed",
          started: at,
          provided: true,
        },
        "line 2: stage provided but not succeeded",
      ],
      [
        "a timer's entry without its name",
        { kind: "took", attempt: 1, at, took: [{ id: "awf.timer.1" }] },
        "line 2: took with malformed took",
      ],
      [
        "a time's entry without its branch",
        {
          kind: "race",
          attempt: 1,
          at,
          name: "r",
          branch: "b",
          took: [{ id: "awf.at.1", due: at }],
        },
        "line 2: race with malformed took",
      ],
      [
        "a stage reason not a string",
        { kind: "stage", attempt: 1, at, name: "a", outcome: "failed", started: at, reason: 1 },
        "line 2: stage with malformed reason",
      ],
      [
        "a wait label not a string",
        { kind: "wait", attempt: 1, at, label: 1 },
        "line 2: wait with malformed label",
      ],
      [
        "acks not strings",
        { kind: "wait", attempt: 1, at, acks: [1] },
        "line 2: wait with malformed acks",
      ],
      [
        "takes not an array",
        { kind: "wait", attempt: 1, at, takes: {} },
        "line 2: wait with malformed takes",
      ],
      [
        "a session home not a string",
        { kind: "session", attempt: 1, at, agent: "a", harness: "claude", session: "s", home: 1 },
        "line 2: session with malformed home",
      ],
      [
        "an inherited name",
        { kind: "toString", attempt: 1, at },
        'line 2: unknown kind "toString"',
      ],
    ])("%s", (_, line, message) => {
      expect(() => readRun([claimed(1), line])).toThrow(`run.jsonl ${message}`);
    });

    test("a fenced line of an unknown kind is refused too", () => {
      expect(() => readRun([claimed(1), claimed(2), { kind: "mystery", attempt: 1, at }])).toThrow(
        'run.jsonl line 3: unknown kind "mystery"',
      );
    });
  });
});
