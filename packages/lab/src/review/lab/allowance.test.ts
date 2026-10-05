import { describe, expect, test } from "bun:test";
import type { AllowanceReport, HarnessAllowance } from "@agentswf/contract/records";
import { blocking, runtimesIn, waitingOnAllowance } from "./allowance";
import type { Runner, RunRequest } from "./runner";

const T0 = Date.parse("2026-10-05T16:00:00Z");
const RESET = "2026-10-05T20:00:00.000Z";

const codex = (usedPercent: number, resetsAt: string | null = RESET): HarnessAllowance => ({
  harness: "codex",
  read: "plan",
  source: "codex account/rateLimits/read",
  windows: [
    { id: "week", label: "week", usedPercent, ...(resetsAt ? { resetsAt } : {}) },
    {
      id: "gpt-reserve-week",
      label: "gpt-reserve week",
      usedPercent: 100,
      resetsAt: RESET,
      models: ["gpt-5.6-luna"],
    },
  ],
});
const claude: HarnessAllowance = {
  harness: "claude",
  read: "plan",
  source: "claude /usage",
  windows: [{ id: "session", label: "session", usedPercent: 99, resetsAt: RESET }],
};
const report = (...harnesses: HarnessAllowance[]): AllowanceReport => ({
  version: "awf.allowance/1",
  readAt: new Date(T0).toISOString(),
  harnesses,
});
const request = (...argv: string[]): RunRequest => ({
  workflow: "w.ts",
  cwd: "/",
  timeout: "1m",
  argv,
  runRoot: "/runs",
  id: "r",
});

describe("the runtimes a run draws on", () => {
  test("are the harness/model arguments of a known harness", () => {
    expect(
      runtimesIn(["--runtime", "codex/gpt-6.1-sol:high", "--range", "a...b", "variants/air"]),
    ).toEqual([{ harness: "codex", model: "gpt-6.1-sol:high" }]);
    expect(runtimesIn(["--runtime=claude/claude-opus-4-7"])).toEqual([
      { harness: "claude", model: "claude-opus-4-7" },
    ]);
  });

  test("hold back on their harnesses' windows, a model's own window only for that model", () => {
    const both = report(codex(95), claude);
    expect(blocking(both, runtimesIn(["codex/gpt-6.1-sol"]), 90).map((b) => b.window.id)).toEqual([
      "week",
    ]);
    expect(blocking(both, runtimesIn(["codex/gpt-5.6-luna"]), 90).map((b) => b.window.id)).toEqual([
      "week",
      "gpt-reserve-week",
    ]);
    expect(blocking(report(codex(50)), runtimesIn(["codex/gpt-6.1-sol"]), 90)).toEqual([]);
    expect(blocking(both, [], 90)).toEqual([]);
    const opus: HarnessAllowance = {
      harness: "claude",
      read: "plan",
      source: "claude /usage",
      windows: [
        { id: "week-opus-4.7", label: "week (Opus 4.7)", usedPercent: 95, models: ["Opus 4.7"] },
      ],
    };
    expect(blocking(report(opus), runtimesIn(["claude/claude-opus-4-7"]), 90)).toHaveLength(1);
    expect(blocking(report(opus), runtimesIn(["claude/claude-opus-4-70"]), 90)).toEqual([]);
    expect(blocking(report(opus), runtimesIn(["claude/sonnet"]), 90)).toEqual([]);
  });
});

describe("a runner that waits on the allowance", () => {
  function setup(reads: (AllowanceReport | undefined)[]) {
    let clock = T0;
    const slept: number[] = [];
    const logged: string[] = [];
    const asked: string[][] = [];
    const ran: RunRequest[] = [];
    const runner: Runner = async (run) => {
      ran.push(run);
      return { exitCode: 0, stderr: "", ms: 0 };
    };
    const gated = waitingOnAllowance(
      runner,
      async (harnesses) => {
        asked.push([...harnesses]);
        return reads.shift();
      },
      {
        limit: 90,
        log: (line) => logged.push(line),
        now: () => clock,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
      },
    );
    return { gated, slept, logged, asked, ran };
  }

  test("runs at once with room, asking only for the run's harnesses", async () => {
    const { gated, slept, asked, ran } = setup([report(codex(50))]);
    await gated(request("--runtime", "codex/gpt-6.1-sol"));
    expect(asked).toEqual([["codex"]]);
    expect(slept).toEqual([]);
    expect(ran).toHaveLength(1);
  });

  test("waits for the reset of a full window, reads again, then runs", async () => {
    const { gated, slept, logged, ran } = setup([report(codex(95)), report(codex(3))]);
    await gated(request("--runtime", "codex/gpt-6.1-sol"));
    // Four hours to the reset, read a minute after it, slept in ten-minute naps.
    expect(slept.reduce((a, b) => a + b, 0)).toBe(4 * 3_600_000 + 60_000);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toStartWith(
      "allowance: codex's week is 95% used, at or past 90%; waiting until",
    );
    expect(ran).toHaveLength(1);
  });

  test("a reset already behind the read waits a few minutes, never spins", async () => {
    const past = "2026-10-05T15:00:00.000Z";
    const { gated, slept, asked } = setup([report(codex(95, past)), report(codex(10))]);
    await gated(request("codex/gpt-6.1-sol"));
    expect(slept).toEqual([5 * 60_000]);
    expect(asked).toHaveLength(2);
  });

  test("runs at once share one read in flight", async () => {
    const { gated, asked, ran } = setup([report(codex(10))]);
    await Promise.all([gated(request("codex/gpt-6.1-sol")), gated(request("codex/gpt-6.1-sol"))]);
    expect(asked).toHaveLength(1);
    expect(ran).toHaveLength(2);
  });

  test("a full window that shows no reset is looked at every half hour", async () => {
    const { gated, slept } = setup([report(codex(95, null)), report(codex(10, null))]);
    await gated(request("codex/gpt-6.1-sol"));
    expect(slept).toEqual([600_000, 600_000, 600_000]);
  });

  test("a plan not read holds nothing, and says so once", async () => {
    const none: HarnessAllowance = { harness: "codex", read: "none", reason: "not logged in" };
    const { gated, logged, ran } = setup([report(none), undefined]);
    await gated(request("codex/gpt-6.1-sol"));
    await gated(request("codex/gpt-6.1-sol"));
    await gated(request("claude/sonnet"));
    expect(ran).toHaveLength(3);
    expect(logged).toEqual([
      "allowance: codex not read, so not waited on: not logged in",
      "allowance: `awf allowance` gave no record; runs go ahead without it",
    ]);
  });

  test("a run that names no harness/model is not waited on, and that is said once", async () => {
    const { gated, asked, logged, ran } = setup([]);
    await gated(request("--severity", "high"));
    await gated(request("--severity", "high"));
    expect(asked).toEqual([]);
    expect(ran).toHaveLength(2);
    expect(logged).toEqual(["allowance: a run that names no harness/model is not waited on"]);
  });

  test("a read stands a minute for the runs that follow", async () => {
    const { gated, asked } = setup([report(codex(10)), report(codex(10))]);
    await gated(request("codex/gpt-6.1-sol"));
    await gated(request("codex/gpt-6.1-sol"));
    expect(asked).toHaveLength(1);
  });
});
