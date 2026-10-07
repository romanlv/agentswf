import { expect, test } from "bun:test";
import { HARNESSES } from "../packages/harness/src/spec";
import { withoutCallingSession } from "../packages/lab/src/review/lab/runner";

test("the lab withholds every harness's session variable, as each harness names it", () => {
  const named = Object.fromEntries(
    Object.values(HARNESSES).flatMap((spec) => (spec.sessionEnv ? [[spec.sessionEnv, "x"]] : [])),
  );
  expect(Object.keys(named).length).toBeGreaterThan(0);
  expect(withoutCallingSession(named)).toEqual({});
});
