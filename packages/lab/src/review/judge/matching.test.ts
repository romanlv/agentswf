import { expect, test } from "bun:test";
import type { AnswerKey } from "../format/format";
import { type Matched, settleMatches } from "./matching";

const key = {
  issues: [{ id: "K1" }, { id: "K2" }],
  refuted: [{ id: "R1" }],
  excluded: [{ reason: "unconfirmed" }],
} as unknown as AnswerKey;
const m = (
  known: Record<string, number>,
  earlier: Record<string, number> = { none: 1 },
): Matched => ({
  known,
  earlier,
});

test("a sure hit goes to the earliest finding that gives the issue, a later one is its duplicate", () => {
  const { settled, left, hitBy } = settleMatches(
    [m({ none: 1 }), m({ K1: 0.95 }), m({ K1: 0.97 })],
    key,
    0.9,
  );
  expect(left.map((l) => l.finding)).toEqual([0]);
  expect(settled.get(1)).toMatchObject({ label: "hit", issue: "K1" });
  expect(settled.get(2)).toMatchObject({ label: "duplicate", of: 1 });
  expect(hitBy.get("K1")).toBe(1);
});

test("a sure noise and an unsettled claim settle; a refuted claim is left for a voter who reads the code", () => {
  const { settled, left } = settleMatches(
    [m({ X0: 0.93 }), m({ R1: 0.99 }), m({ noise: 0.99 }), m({ noise: 0.85, none: 0.15 })],
    key,
    0.9,
  );
  expect(settled.get(0)).toMatchObject({ label: "unsettled", excluded: 0 });
  expect(settled.get(2)).toMatchObject({ label: "noise", read: [] });
  expect(left.map((l) => l.finding)).toEqual([1, 3]);
  // Noise that surely repeats an earlier finding is its duplicate, counted once.
  const again = settleMatches(
    [m({ noise: 0.95 }), m({ noise: 0.95 }, { F0: 0.96, none: 0.04 })],
    key,
    0.9,
  );
  expect(again.settled.get(1)).toMatchObject({ label: "duplicate", of: 0 });
});

test("the earlier-finding question settles only a finding that surely matches nothing known", () => {
  const { settled, left } = settleMatches(
    [
      m({ none: 1 }),
      m({ none: 0.95 }, { F0: 0.97, none: 0.03 }),
      m({ X0: 0.85, none: 0.15 }, { F0: 0.97, none: 0.03 }),
    ],
    key,
    0.9,
  );
  expect(settled.get(1)).toMatchObject({ label: "duplicate", of: 0 });
  expect(left.map((l) => l.finding)).toEqual([0, 2]);
});

test("an issue an earlier finding points at unsurely is contested: all its findings are left, unclaimed", () => {
  const { settled, left, hitBy } = settleMatches(
    [m({ K1: 0.8, none: 0.2 }), m({ K1: 0.97 }), m({ K2: 0.99 })],
    key,
    0.9,
  );
  expect(left.map((l) => l.finding)).toEqual([0, 1]);
  expect(hitBy.has("K1")).toBe(false);
  expect(settled.get(2)).toMatchObject({ label: "hit", issue: "K2" });
});
