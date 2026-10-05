import { expect, test } from "bun:test";
import { schemaLines } from "./schema-text";

test("a schema reads as a type: fields, optional ones, lists, bounds and constants", () => {
  expect(
    schemaLines({
      type: "object",
      properties: {
        rounds: { type: "integer", minimum: 1 },
        ledger: { type: "string" },
        cases: { type: "array", items: { type: "string" }, minItems: 1 },
        main: { enum: ["recorded", "not-reproduced"] },
        note: { type: "string" },
      },
      required: ["rounds", "ledger", "cases", "main"],
    }),
  ).toEqual([
    '{rounds: integer ≥ 1, ledger: string, cases: string[] (1+), main: "recorded" | "not-reproduced", note?: string}',
  ]);
});

test("a top-level anyOf is a line per branch", () => {
  expect(
    schemaLines({
      anyOf: [
        {
          type: "object",
          properties: { kind: { type: "string", const: "ready" } },
          required: ["kind"],
        },
        { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } },
      ],
    }),
  ).toEqual(['{kind: "ready"}', "(string | null)[]"]);
});
