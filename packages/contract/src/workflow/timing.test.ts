import { describe, expect, test } from "bun:test";
import { DeadlineExceededError } from "./timing";

describe("DeadlineExceededError", () => {
  test("exposes one stable machine-readable code and the absolute deadline", () => {
    const deadline = { unixMilliseconds: 1_800_000_000_000 };
    const error = new DeadlineExceededError(deadline);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DeadlineExceededError");
    expect(error.code).toBe("deadline-exceeded");
    expect(error.deadline).toEqual(deadline);
  });
});
