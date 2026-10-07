import { describe, expect, test } from "bun:test";
import { withoutCallingSession } from "./runner";

describe("withoutCallingSession", () => {
  test("a case's run never finds the session awf-lab was started from", () => {
    expect(
      withoutCallingSession({
        CLAUDE_CODE_SESSION_ID: "s1",
        CODEX_SESSION_ID: "t1",
        PI_SESSION_ID: "p1",
        CURSOR_CONVERSATION_ID: "c1",
        PATH: "/bin",
      }),
    ).toEqual({ PATH: "/bin" });
  });
});
