import { describe, expect, test } from "bun:test";
import type { HarnessTurn } from "@agentswf/harness/adapter";
import { superviseMessageOperation } from "./message-operation";
import type { OperationMessages } from "./operation-liveness";

const turn = () =>
  ({
    settled: Promise.resolve({ state: "completed", chargesUsd: [] }),
    release: async () => ({ kind: "released" }),
  }) as unknown as HarnessTurn;

/** A message operation whose turn asked a coordinator, answered after `answerMs` if given. */
function asking(answerMs?: number) {
  let answered = false;
  let wake = () => {};
  if (answerMs !== undefined)
    setTimeout(() => {
      answered = true;
      wake();
    }, answerMs);
  let turns = 0;
  const messages: OperationMessages = {
    pending: () => (answered && turns === 1 ? "continues" : "none"),
    awaiting: () => (answered ? undefined : { peer: "coordinator", outside: true }),
    turnEnded: () =>
      turns === 1 && !answered
        ? { kind: "wait", peer: "coordinator" }
        : turns === 1
          ? { kind: "continue" }
          : { kind: "settle" },
    continueWith: async () => {
      turns += 1;
      return turn();
    },
    reminderExpired: () => {},
    onChange: (changed) => {
      wake = changed;
      return () => {};
    },
  };
  return {
    messages,
    start: async () => {
      turns = 1;
      return turn();
    },
  };
}

describe("a message operation awaiting an outside participant", () => {
  test("its deadline does not cut the wait, and moves out by it", async () => {
    const started = Date.now();
    let deadline = started + 50;
    const moved: number[] = [];
    const { messages, start } = asking(150);
    const outcome = await superviseMessageOperation({
      deadline: () => deadline,
      extended: (later) => {
        moved.push(later);
        deadline = later;
      },
      start,
      messages,
      onStop: () => () => {},
    });
    expect(outcome.kind).toBe("answered");
    expect(moved).toHaveLength(1);
    expect(moved[0]! - (started + 50)).toBeGreaterThanOrEqual(140);
  });

  test("a deadline around it still ends the wait", async () => {
    const started = Date.now();
    const { messages, start } = asking();
    const outcome = await superviseMessageOperation({
      deadline: () => started + 20,
      ceiling: started + 120,
      start,
      messages,
      onStop: () => () => {},
    });
    expect(outcome).toMatchObject({
      kind: "timed-out",
      reason: "a deadline around it passed while it waited",
    });
    expect(outcome.settledAt).toBeGreaterThanOrEqual(started + 120);
  });
});
