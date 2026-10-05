import { expect, test } from "bun:test";
import { type JsonSchema, validate } from "@agentswf/contract/schema";
import { placeholderOf, schemaLines } from "./stage-schema";

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

test("a stand-in fits its own schema, across the subset", () => {
  const schemas: JsonSchema[] = [
    { type: "string" },
    { type: "string", minLength: 3 },
    { type: "string", enum: ["a", "abcd"], minLength: 2 },
    { type: "string", const: "ready" },
    { type: "integer", minimum: 0.5 },
    { type: "integer", maximum: 7.5 },
    { type: "number", minimum: -2 },
    { type: "boolean" },
    { type: "null" },
    { enum: ["x", 1, null] },
    { type: "array", items: { type: "integer", minimum: 2 }, minItems: 2 },
    {
      type: "object",
      properties: { kind: { type: "string", const: "ready" }, note: { type: "string" } },
      required: ["kind"],
      additionalProperties: false,
    },
    { type: "object", properties: {}, required: ["x"] },
    {
      anyOf: [
        {
          type: "object",
          properties: { kind: { type: "string", const: "a" } },
          required: ["kind"],
        },
        { type: "null" },
      ],
    },
  ];
  for (const schema of schemas) expect(validate(schema, placeholderOf(schema))).toEqual([]);
});
