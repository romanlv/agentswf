import { describe as group, expect, test } from "bun:test";
import { describe, formatErrors, validate, type JsonSchema } from "./schema";
import { COUNT_SCHEMA } from "./testing/fixtures";

group("validate", () => {
  test("a matching value produces no errors", () => {
    expect(validate(COUNT_SCHEMA, { count: 3, even: false })).toEqual([]);
  });

  test("a missing required property names the field and the shape wanted there", () => {
    const errors = validate(COUNT_SCHEMA, { count: 3 });

    expect(errors).toEqual([
      { path: "value.even", message: "required property is missing (boolean)" },
    ]);
  });

  test("a wrong type names what was expected and what arrived", () => {
    const errors = validate(COUNT_SCHEMA, { count: "3", even: true });

    expect(errors).toEqual([
      { path: "value.count", message: 'expected an integer; got a string "3"' },
    ]);
  });

  test("a non-integer number is refused rather than rounded", () => {
    const errors = validate(COUNT_SCHEMA, { count: 3.5, even: true });

    expect(errors).toEqual([{ path: "value.count", message: "expected an integer; got 3.5" }]);
  });

  test("an unknown property lists the properties the call does accept", () => {
    const errors = validate(COUNT_SCHEMA, { count: 3, even: true, notes: "hi" });

    expect(errors).toEqual([
      {
        path: "value.notes",
        message: 'unexpected property; this call accepts only "count", "even"',
      },
    ]);
  });

  test("an enum mismatch prints every accepted value", () => {
    const schema: JsonSchema = { type: "string", enum: ["pass", "fail"] };

    expect(validate(schema, "PASS")).toEqual([
      { path: "value", message: 'expected one of "pass", "fail"; got "PASS"' },
    ]);
  });

  test("an array error carries the index of the item that failed", () => {
    const schema: JsonSchema = {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      minItems: 1,
    };

    expect(validate(schema, [{ name: "a" }, { name: 7 }])).toEqual([
      { path: "value[1].name", message: "expected a string; got a number 7" },
    ]);
  });

  test("bounds are reported with the limit that was crossed", () => {
    const schema: JsonSchema = { type: "number", minimum: 0, maximum: 10 };

    expect(validate(schema, 11)).toEqual([
      { path: "value", message: "expected at most 10; got 11" },
    ]);
  });

  test("every failure is reported, so one round trip fixes them all", () => {
    const errors = validate(COUNT_SCHEMA, { count: -1, even: "yes" });

    expect(errors.map((error) => error.path)).toEqual(["value.count", "value.even"]);
  });
});

group("formatErrors", () => {
  test("renders one line per location", () => {
    const text = formatErrors(validate(COUNT_SCHEMA, { count: "3" }));

    expect(text).toBe(
      [
        "the value does not match the schema for this call:",
        "  value.even: required property is missing (boolean)",
        '  value.count: expected an integer; got a string "3"',
      ].join("\n"),
    );
  });

  test("no errors renders nothing", () => {
    expect(formatErrors([])).toBe("");
  });
});

group("describe", () => {
  test("renders an object as a one-line shape with optional fields marked", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { count: { type: "integer" }, note: { type: "string" } },
      required: ["count"],
    };

    expect(describe(schema)).toBe("{ count: integer, note?: string }");
  });
});

group("properties inherited from Object.prototype", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "number" } },
    additionalProperties: false,
  } as const;

  // `schema.properties[key]` used to resolve to Object.prototype.toString and be switched on
  // as if it were a schema, which threw out of the CLI's error handling.
  test("a value carrying a prototype key is reported, not thrown on", () => {
    const errors = validate(schema, JSON.parse('{"a":1,"toString":1}'));

    expect(errors).toEqual([
      { path: "value.toString", message: 'unexpected property; this call accepts only "a"' },
    ]);
  });

  test("a required property named after a prototype member is missing when absent", () => {
    const required: JsonSchema = {
      type: "object",
      // TS resolves this key's contextual type from Object.prototype.constructor, not the
      // index signature, so the inner literal needs its own annotation.
      properties: { constructor: { type: "string" } as JsonSchema },
      required: ["constructor"],
    };

    expect(validate(required, JSON.parse("{}"))).toHaveLength(1);
  });
});
