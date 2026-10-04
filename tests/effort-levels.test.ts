import { expect, test } from "bun:test";
import { HARNESSES } from "../packages/harness/src/spec";
import { LEVELS } from "../packages/lab/src/review/format/runtime";

// The lab may not import the harness package, so it repeats the levels: a level it lacks would be
// read as part of the model, and pi takes a `:level` suffix itself.
test("the lab knows every harness's effort levels", () => {
  const levels = Object.values(HARNESSES).flatMap((spec) => spec.effort ?? []);
  expect([...LEVELS].sort()).toEqual([...new Set(levels)].sort());
});
