import { describe, expect, test } from "bun:test";
import type { HarnessAllowance } from "@agentswf/contract/records";
import { describeReport, parseAllowanceCommand, readReport } from "./allowance-command";
import { runOperatorCli } from "./operator-cli";

const NOW = Date.parse("2026-10-05T16:50:00Z");

const READS: Record<string, HarnessAllowance> = {
  claude: {
    harness: "claude",
    read: "plan",
    source: "claude /usage",
    windows: [
      { id: "session", label: "session", usedPercent: 37, resetsAt: "2026-10-05T21:19:00.000Z" },
      {
        id: "week-fable",
        label: "week (Fable)",
        usedPercent: 12.5,
        resetsAt: "2026-10-08T16:00:00.000Z",
        models: ["Fable"],
      },
    ],
  },
  cursor: {
    harness: "cursor",
    read: "plan",
    source: "cursor /usage",
    plan: "Team",
    windows: [
      { id: "included", label: "Included", usedPercent: 1, resetsAt: "2026-10-21T04:00:00.000Z" },
      { id: "auto", label: "Auto", usedPercent: 1, resetsAt: "2026-10-21T04:00:00.000Z" },
    ],
  },
  pi: { harness: "pi", read: "none", reason: "pi has no plan usage command" },
};

describe("awf allowance", () => {
  test("names harnesses once each, every harness when none is named", () => {
    expect(parseAllowanceCommand(["codex", "--json", "codex"])).toEqual({
      harnesses: ["codex"],
      json: true,
    });
    expect(parseAllowanceCommand([])).toEqual({
      harnesses: ["claude", "codex", "pi", "cursor"],
      json: false,
    });
    expect(() => parseAllowanceCommand(["gemini"])).toThrow("unknown harness or option: gemini");
  });

  test("a line per harness, a reset said once for the windows that share it", async () => {
    const report = await readReport(
      ["claude", "cursor", "pi"],
      async (harness) => READS[harness]!,
      NOW,
    );
    expect(describeReport(report, "America/Toronto")).toBe(
      [
        "claude  session 37%, resets 17:19 · week (Fable) 12.5%, resets Oct 8 12:00",
        "cursor  Team · Included 1%, Auto 1%, resets Oct 21",
        "pi      no allowance: pi has no plan usage command",
      ].join("\n"),
    );
  });

  test("--json prints the record, the named harnesses only", async () => {
    const printed: string[] = [];
    const asked: string[] = [];
    const exit = await runOperatorCli(["allowance", "cursor", "--json"], {
      stdout: (text) => printed.push(text),
      stderr: (text) => printed.push(text),
      now: () => NOW,
      readAllowance: async (harness) => {
        asked.push(harness);
        return READS[harness]!;
      },
    });
    expect(exit).toBe(0);
    expect(asked).toEqual(["cursor"]);
    expect(JSON.parse(printed.join(""))).toEqual({
      version: "awf.allowance/1",
      readAt: "2026-10-05T16:50:00.000Z",
      harnesses: [READS.cursor],
    });
  });

  test("an unknown harness is a usage error", async () => {
    const printed: string[] = [];
    const exit = await runOperatorCli(["allowance", "gemini"], {
      stdout: (text) => printed.push(text),
      stderr: (text) => printed.push(text),
      readAllowance: async () => {
        throw new Error("nothing is read");
      },
    });
    expect(exit).toBe(2);
    expect(printed.join("")).toContain("awf: unknown harness or option: gemini");
  });
});
