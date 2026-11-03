import { expect, test } from "bun:test";
import { durationMilliseconds } from "./waits";

test("a duration reads its decimal and unit, and refuses one too long to end as a Date", () => {
  expect(durationMilliseconds("1.5h")).toBe(5_400_000);
  expect(durationMilliseconds("100000d")).toBe(100_000 * 86_400_000);
  for (const long of ["100001d", "100000000d", "9007199254740991h"])
    expect(() => durationMilliseconds(long)).toThrow("too long: at most 100000d");
});
