import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessInput, ProcessResult, RunProcess } from "../command";
import { readPaneAllowance } from "./herdr-allowance";

const SCREEN = readFileSync(
  join(import.meta.dir, "../usage/fixtures/allowance/cursor-usage.screen"),
);
const CONFIG = { session: "s", workspaceLabel: "awf", commandTimeoutMs: 1_000 };

/** Herdr answering every command, with `answer` overriding by verb; each call kept. */
function herdr(answer: Record<string, Partial<ProcessResult>> = {}) {
  const calls: string[][] = [];
  const run: RunProcess = async (input) => {
    const argv = (input as ProcessInput).argv.slice(3);
    calls.push(argv);
    const verb = argv.slice(0, 2).join(" ");
    const created = {
      result: { root_pane: { pane_id: "w1:p1" }, workspace: { workspace_id: "w1" } },
    };
    return {
      stdout: verb === "workspace create" ? JSON.stringify(created) : "{}",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      ...(verb === "pane read" ? { stdout: SCREEN.toString() } : {}),
      ...answer[verb],
    };
  };
  return { run, calls };
}

describe("a usage screen read in a pane", () => {
  test("starts the harness, waits for it, types the steps in order, reads, and closes", async () => {
    const { run, calls } = herdr();
    const read = await readPaneAllowance("cursor", CONFIG, { run });
    expect(read.read === "plan" && read.plan).toBe("Team");
    expect(calls.map((call) => call.slice(0, 2).join(" "))).toEqual([
      "workspace create",
      "agent start",
      "pane wait-output",
      "pane send-text",
      "pane wait-output",
      "pane send-keys",
      "pane wait-output",
      "pane read",
      "workspace close",
    ]);
    const steps = calls.filter((call) => call[0] === "pane").map((call) => call[3]);
    expect(steps).toEqual(["--match", "/usage", "--match", "Enter", "--match", undefined]);
    expect(calls[0]).toContain("--no-focus");
    expect(calls.at(-1)).toEqual(["workspace", "close", "w1"]);
  });

  test("a screen that never shows is none, with what it showed, and the pane is closed", async () => {
    const { run, calls } = herdr({
      "pane wait-output": { exitCode: 1, stderr: "timed out" },
      "pane read": { stdout: "Sign in to Cursor\n" },
    });
    expect(await readPaneAllowance("cursor", CONFIG, { run })).toEqual({
      read: "none",
      reason:
        "cursor's usage screen: `Run Everything` never showed: timed out; it shows Sign in to Cursor",
    });
    expect(calls.at(-1)).toEqual(["workspace", "close", "w1"]);
  });

  test("a harness that fails to start still has its pane closed", async () => {
    const { run, calls } = herdr({ "agent start": { exitCode: 1, stderr: "not installed" } });
    expect(await readPaneAllowance("cursor", CONFIG, { run })).toEqual({
      read: "none",
      reason: "cursor's usage screen: starting it failed: not installed",
    });
    expect(calls.at(-1)).toEqual(["workspace", "close", "w1"]);
  });

  test("a harness with no usage screen opens nothing", async () => {
    const { run, calls } = herdr();
    expect((await readPaneAllowance("claude", CONFIG, { run })).read).toBe("none");
    expect(calls).toEqual([]);
  });
});
