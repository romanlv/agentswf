import { describe, expect, test } from "bun:test";
import { FINDINGS_SCHEMA, VERDICT_SCHEMA } from "../examples/catalogue-review/schema";
import {
  ADDITIONAL_SCHEMA,
  REVIEW_VERDICT_SCHEMA,
  REVIEWED_SCHEMA,
  WORK_UPDATE_SCHEMA,
} from "../examples/feature-delivery/schema";
import { parseJsonSchema, validate } from "../packages/contract/src/schema";

describe("example workflow schemas", () => {
  test("every TypeBox schema stays inside the supported contract subset", () => {
    for (const schema of [
      FINDINGS_SCHEMA,
      VERDICT_SCHEMA,
      WORK_UPDATE_SCHEMA,
      REVIEW_VERDICT_SCHEMA,
      REVIEWED_SCHEMA,
      ADDITIONAL_SCHEMA,
    ]) {
      expect(() => parseJsonSchema(schema)).not.toThrow();
    }
  });

  test("review changes require at least one feedback item", () => {
    const schema = parseJsonSchema(REVIEW_VERDICT_SCHEMA);

    expect(validate(schema, { kind: "changes-requested", feedback: [] })).not.toEqual([]);
    expect(validate(schema, { kind: "changes-requested", feedback: ["Add a test"] })).toEqual([]);
  });
});
