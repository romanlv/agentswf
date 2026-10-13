import { expect, test } from "bun:test";
import { AWAIT_REPLY, canAwaitReply } from "./limits";

test("--await-reply is on only where the list says, and a confirmed pane only where it confirms", () => {
  const claudePane = { harness: "claude", model: "m" };
  expect(canAwaitReply(claudePane, true)).toBe(true);
  expect(canAwaitReply(claudePane, false)).toBe(false);
  // A codex, pi or cursor pane cannot confirm what it was sent, and is never listed.
  expect(canAwaitReply({ harness: "codex", model: "m" }, true)).toBe(false);
  // On where M2 passed, headless; cursor's was not measured. The fake always may.
  for (const harness of ["claude", "codex", "pi"]) {
    expect(canAwaitReply({ harness, model: "m", placement: "headless" }, false)).toBe(true);
  }
  expect(canAwaitReply({ harness: "cursor", model: "m", placement: "headless" }, true)).toBe(false);
  expect(canAwaitReply({ harness: "fake", model: "m" }, false)).toBe(true);
});

test("no real harness's pane is listed without needing to confirm what it was sent", () => {
  for (const [harness, placements] of Object.entries(AWAIT_REPLY)) {
    if (harness !== "fake") expect(placements.pane).not.toBe(true);
  }
});
