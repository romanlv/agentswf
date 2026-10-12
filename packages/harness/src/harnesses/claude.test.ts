import { expect, test } from "bun:test";
import { sandboxedArgs } from "../sandbox-needs";
import { HARNESSES } from "../spec";

test("every claude launch refuses messages from the user's other sessions", async () => {
  const claude = HARNESSES.claude;
  for (const launchArgs of [[], sandboxedArgs("claude")]) {
    const context = { model: "m", sessionHint: "s", launchArgs };
    const plans = [
      claude.interactive({ model: "m" }, launchArgs, "s"),
      claude.interactiveResume!("s", { model: "m" }, launchArgs),
      claude.headlessTurn("prompt", context),
      claude.resumeTurn!("prompt", "s", context),
      claude.compactHeadless!("focus", "s", context),
      await claude.forkSession!("s", "f", context),
    ];
    for (const { argv } of plans) {
      // One, so no later `--settings` from the launch arguments stands beside it.
      expect(argv.filter((arg) => arg === "--settings")).toHaveLength(1);
      const at = argv.indexOf("--settings");
      expect(JSON.parse(argv[at + 1]!)).toEqual({ crossSessionInbound: "refuse" });
    }
  }
});

test("no claude agent inherits the calling session's messaging route", () => {
  expect(HARNESSES.claude.callingSessionEnv).toEqual(
    expect.arrayContaining(["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"]),
  );
});
