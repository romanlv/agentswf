import { describe, expect, test } from "bun:test";
import { FINDINGS_SCHEMA, VERDICT_SCHEMA } from "../examples/catalogue-review/schema";
import { ADDITIONAL, REVIEWED, VERDICT, WORK } from "../examples/feature-delivery/schema";
import { parseJsonSchema, validate } from "../packages/contract/src/schema";

describe("example workflow schemas", () => {
  test("every TypeBox schema stays inside the supported contract subset", () => {
    for (const schema of [FINDINGS_SCHEMA, VERDICT_SCHEMA, WORK, VERDICT, REVIEWED, ADDITIONAL]) {
      expect(() => parseJsonSchema(schema)).not.toThrow();
    }
  });

  test("review changes require at least one feedback item", () => {
    const schema = parseJsonSchema(VERDICT);

    expect(validate(schema, { kind: "changes-requested", feedback: [] })).not.toEqual([]);
    expect(validate(schema, { kind: "changes-requested", feedback: ["Add a test"] })).toEqual([]);
  });
});
