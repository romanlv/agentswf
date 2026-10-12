import { expect, test } from "bun:test";
import { AWAIT_REPLY, canAwaitReply } from "./limits";

test("--await-reply is on only where the list says, and a confirmed pane only where it confirms", () => {
  const list = { ...AWAIT_REPLY, claude: { headless: true as const, pane: "confirmed" as const } };
  const claudePane = { harness: "claude", model: "m" };
  expect(canAwaitReply(claudePane, true, list)).toBe(true);
  expect(canAwaitReply(claudePane, false, list)).toBe(false);
  expect(canAwaitReply({ ...claudePane, placement: "headless" }, false, list)).toBe(true);
  // A codex, pi or cursor pane cannot confirm what it was sent, and is never listed.
  expect(canAwaitReply({ harness: "codex", model: "m" }, true, list)).toBe(false);
  // Off for every real harness until M2 passes on it; the fake always may.
  for (const harness of ["claude", "codex", "pi", "cursor"]) {
    expect(canAwaitReply({ harness, model: "m", placement: "headless" }, true)).toBe(false);
  }
  expect(canAwaitReply({ harness: "fake", model: "m" }, false)).toBe(true);
  expect(canAwaitReply({ harness: "claude", model: "m" }, true)).toBe(false);
});

test("no real harness's pane is listed without needing to confirm what it was sent", () => {
  for (const [harness, placements] of Object.entries(AWAIT_REPLY)) {
    if (harness !== "fake") expect(placements.pane).not.toBe(true);
  }
});
