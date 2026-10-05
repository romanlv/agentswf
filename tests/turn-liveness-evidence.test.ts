import { expect, test } from "bun:test";
import type { OperationLivenessRecord, OutputRecord } from "../packages/contract/src/records";
import { type Evidence, problems } from "./turn-liveness-evidence";

function event(kind: string, sequence = 0, at = 1, reason?: string): OperationLivenessRecord {
  return { version: 1, operationId: "op", kind, sequence, at, ...(reason ? { reason } : {}) };
}
const output = (value: unknown, outcome = "completed") => ({ outcome, value }) as OutputRecord;
const silent: Evidence = [
  {
    incomplete: false,
    events: [
      event("dispatched"),
      event("received", 1),
      event("terminal", 1, 3, "check-in received no waiting declaration or result"),
    ],
  },
];
test("silent success requires unanswered, not an arbitrary completed workflow", () => {
  expect(problems("silent", 0, output({ first: "unanswered" }), silent)).toEqual([]);
  expect(problems("silent", 0, output({ first: "timed-out" }), silent)).not.toEqual([]);
  expect(problems("silent", 0, output({ first: "answered" }), silent)).not.toEqual([]);
});
test("cancel requires cancelled record and dispatch evidence", () => {
  expect(problems("cancel", 1, output(undefined, "failed"), silent)).not.toEqual([]);
  expect(problems("cancel", 1, output(undefined, "cancelled"), silent)).toEqual([]);
  expect(problems("cancel", 1, output(undefined, "cancelled"), [])).not.toEqual([]);
});
test("waiting proof requires all three deliveries and release before follow-up", () => {
  const first: OperationLivenessRecord[] = [];
  for (const sequence of [0, 1, 2]) {
    if (sequence) first.push(event("check-in-due", sequence, sequence * 10));
    for (const kind of ["dispatched", "queue-accepted", "received"])
      first.push(event(kind, sequence, sequence * 10 + 1));
    if (sequence < 2) first.push(event("waiting", sequence, sequence * 10 + 2));
  }
  first.push(
    event("admitted", 2, 30),
    event("releasing", 2, 31),
    event("terminal", 2, 32, "answer saved"),
  );
  const evidence: Evidence = [
    { incomplete: false, events: first },
    {
      incomplete: false,
      events: [
        event("dispatched", 0, 33),
        event("admitted", 0, 34),
        event("releasing", 0, 35),
        event("terminal", 0, 36, "answer saved"),
      ],
    },
  ];
  expect(problems("srt", 0, output({ first: "done", next: "follow-up" }), evidence)).toEqual([]);
  evidence[0]!.events = first.filter((row) => row.kind !== "received" || row.sequence !== 2);
  expect(problems("srt", 0, output({ first: "done", next: "follow-up" }), evidence)).not.toEqual(
    [],
  );
  evidence[0]!.events = first;
  evidence[1]!.events[0]!.at = 31;
  expect(problems("srt", 0, output({ first: "done", next: "follow-up" }), evidence)).not.toEqual(
    [],
  );
});
test("lost route requires actual failed command and no renewed waiting", () => {
  const evidence: Evidence = [
    {
      incomplete: false,
      events: [event("dispatched"), event("waiting"), event("received", 1), event("terminal", 1)],
    },
  ];
  expect(
    problems("lost-route", 0, output({ first: "unanswered" }), evidence, {
      removed: true,
      status: "1",
      error: "connect ENOENT",
    }),
  ).toEqual([]);
  expect(
    problems("lost-route", 0, output({ first: "unanswered" }), evidence, {
      removed: true,
      status: "0",
      error: "",
    }),
  ).not.toEqual([]);
});
