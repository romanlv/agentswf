import { expect, test } from "bun:test";
import { citedComments } from "./sanity";
import { EXAMPLE_KEY } from "./testing";

test("the cited comments come oldest first, each with every label a right judge could give", () => {
  const key = {
    ...EXAMPLE_KEY,
    issues: [
      {
        ...EXAMPLE_KEY.issues[0]!,
        sources: [
          { discussion: "d1", note: 2 },
          { discussion: "d2", note: 3 },
        ],
      },
      { ...EXAMPLE_KEY.issues[1]!, sources: [{ discussion: "d2", note: 3 }] },
    ],
    refuted: [{ ...EXAMPLE_KEY.refuted[0]!, sources: [{ discussion: "d1", note: 1 }] }],
    excluded: [
      { sources: [{ discussion: "d3", note: 4 }], reason: "unconfirmed" as const, claim: "maybe" },
      { sources: [{ discussion: "d3", note: 9 }], reason: "preference" as const, claim: "gone" },
    ],
  };
  const discussions = [
    {
      id: "d1",
      notes: [
        { id: 1, body: "a lock is dropped" },
        { id: 2, body: "K1 here", position: { new_path: "src/a.ts", new_line: 5 } },
      ],
    },
    { id: "d2", notes: [{ id: 3, body: "K1 and K2" }] },
    { id: "d3", notes: [{ id: 4, body: "maybe a race" }] },
  ];
  expect(citedComments(key, discussions)).toEqual([
    { finding: { text: "a lock is dropped" }, accepted: ["wrong"] },
    { finding: { path: "src/a.ts", line: 5, text: "K1 here" }, accepted: ["hit:K1"] },
    { finding: { text: "K1 and K2" }, accepted: ["hit:K1", "hit:K2", "duplicate"] },
    { finding: { text: "maybe a race" }, accepted: ["unsettled"] },
  ]);
});
