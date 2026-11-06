import { describe, expect, test } from "bun:test";
import { DeadlineExceededError } from "./timing";

describe("DeadlineExceededError", () => {
  test("exposes one stable machine-readable code and the deadline, a Date", () => {
    const deadline = { unixMilliseconds: 1_800_000_000_000 };
    const error = new DeadlineExceededError(deadline);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DeadlineExceededError");
    expect(error.code).toBe("deadline-exceeded");
    expect(error.deadline).toEqual(new Date(1_800_000_000_000));
    expect(error.message).toBe("Deadline exceeded at 2027-01-15T08:00:00.000Z");
  });
});
