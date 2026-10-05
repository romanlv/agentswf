import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessInput, RunProcess } from "../command";
import { parseRow } from "../json";
import {
  claudeAccountFile,
  claudeAllowance,
  claudePlan,
  claudeReset,
  codexAllowance,
  cursorAllowance,
  readClaudeAllowance,
  readCodexAllowance,
} from "./allowance";

const FIXTURES = join(import.meta.dir, "fixtures/allowance");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
/** When the fixtures were recorded: 2026-10-05 12:50 in Toronto. */
const RECORDED = Date.parse("2026-10-05T16:50:00Z");

describe("claude's /usage", () => {
  test("reads each window, its reset in UTC, and the models a window limits", () => {
    expect(claudeAllowance(fixture("claude-usage.json"), RECORDED)).toEqual({
      read: "plan",
      source: "claude /usage",
      windows: [
        {
          id: "session",
          label: "session",
          usedPercent: 0,
          resetsAt: "2026-10-05T21:19:00.000Z",
        },
        {
          id: "week",
          label: "week (all models)",
          usedPercent: 0,
          resetsAt: "2026-10-06T06:59:00.000Z",
        },
        {
          id: "week-fable",
          label: "week (Fable)",
          usedPercent: 0,
          resetsAt: "2026-10-06T07:00:00.000Z",
          models: ["Fable"],
        },
      ],
    });
  });

  test("a percent with a fraction, and a model's window worded as its only", () => {
    const said = [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 37.5% used · resets Oct 5 at 1:20pm (America/Toronto)",
      "Current week (Sonnet only): 4% used · resets Oct 8 at 12pm (America/Toronto)",
    ].join("\n");
    const read = claudeAllowance(JSON.stringify({ result: said }), RECORDED);
    expect(read.read === "plan" && read.windows).toEqual([
      {
        id: "session",
        label: "session",
        usedPercent: 37.5,
        resetsAt: "2026-10-05T17:20:00.000Z",
      },
      {
        id: "week-sonnet",
        label: "week (Sonnet only)",
        usedPercent: 4,
        resetsAt: "2026-10-08T16:00:00.000Z",
        models: ["Sonnet"],
      },
    ]);
  });

  test("a reset is the nearest such date, across a new year; a time alone, the next one", () => {
    const december = Date.parse("2026-12-31T20:00:00Z");
    expect(claudeReset("Jan 2 at 3am (UTC)", december)).toBe("2027-01-02T03:00:00.000Z");
    expect(claudeReset("Dec 31 at 11pm (UTC)", december)).toBe("2026-12-31T23:00:00.000Z");
    // A stale screen's reset stays just behind the read, not a year ahead.
    expect(claudeReset("Dec 31 at 7pm (UTC)", december)).toBe("2026-12-31T19:00:00.000Z");
    expect(claudeReset("5pm (UTC)", december)).toBe("2027-01-01T17:00:00.000Z");
    expect(claudeReset("9pm (UTC)", december)).toBe("2026-12-31T21:00:00.000Z");
    expect(claudeReset("8pm (UTC)", december + 30_000)).toBe("2026-12-31T20:00:00.000Z");
    expect(claudeReset("soon", december)).toBeUndefined();
    expect(claudeReset("Oct 5 at 5pm (Nowhere/Else)", december)).toBeUndefined();
  });

  test("a login with no plan, an error and no output are none, with why", () => {
    const key = JSON.stringify({ result: "You are using an API key; usage is billed per token." });
    expect(claudeAllowance(key, RECORDED)).toEqual({
      read: "none",
      reason:
        "claude's /usage showed no plan: You are using an API key; usage is billed per token.",
    });
    expect(
      claudeAllowance(JSON.stringify({ is_error: true, result: "Not logged in" }), RECORDED),
    ).toEqual({ read: "none", reason: "claude: Not logged in" });
    expect(claudeAllowance("", RECORDED, "exited 1: boom")).toEqual({
      read: "none",
      reason: "`claude -p /usage` printed no result; exited 1: boom",
    });
  });

  test("is run with no session kept, and names the plan and its tier", async () => {
    const asked: ProcessInput[] = [];
    const run: RunProcess = async (input) => {
      const { argv } = input as ProcessInput;
      asked.push(input as ProcessInput);
      const stdout =
        argv[1] === "auth"
          ? JSON.stringify({ loggedIn: true, subscriptionType: "max" })
          : fixture("claude-usage.json");
      return { stdout, stderr: "", exitCode: 0, timedOut: false };
    };
    const account = join(import.meta.dir, "fixtures/allowance/claude-account.json");
    const read = await readClaudeAllowance(run, RECORDED, account);
    expect(read.read === "plan" && [read.plan, read.tier]).toEqual([
      "max",
      "default_claude_max_20x",
    ]);
    expect(asked.map((input) => input.argv)).toEqual([
      ["claude", "-p", "/usage", "--output-format", "json", "--no-session-persistence"],
      ["claude", "auth", "status", "--json"],
    ]);
    const missing = await readClaudeAllowance(run, RECORDED, join(FIXTURES, "none.json"));
    expect(missing.read === "plan" && [missing.plan, missing.tier]).toEqual(["max", undefined]);
  });

  test("a plan is what auth status names; a tier, the organization's, else the user's", () => {
    expect(claudePlan('{"subscriptionType":"pro"}', "")).toEqual({ plan: "pro" });
    expect(
      claudePlan(
        "",
        JSON.stringify({
          oauthAccount: {
            organizationRateLimitTier: null,
            userRateLimitTier: "default_claude_max_5x",
          },
        }),
      ),
    ).toEqual({ tier: "default_claude_max_5x" });
    expect(claudePlan("not json", "not json")).toEqual({});
  });

  test("its account is in the home directory, or beside its moved state", () => {
    expect(claudeAccountFile({ HOME: "/h" })).toBe("/h/.claude.json");
    expect(claudeAccountFile({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/.claude.json");
  });
});

describe("codex's rate limits", () => {
  const response = parseRow(fixture("codex-ratelimits.json"))!;

  test("reads every limit's windows, a model's own limit named and scoped", () => {
    expect(codexAllowance(response)).toEqual({
      read: "plan",
      source: "codex account/rateLimits/read",
      plan: "prolite",
      windows: [
        { id: "week", label: "week", usedPercent: 93, resetsAt: "2026-10-10T03:34:19.000Z" },
        {
          id: "gpt-reserve-week",
          label: "gpt-reserve week",
          usedPercent: 0,
          resetsAt: "2026-10-12T16:32:32.000Z",
          models: ["gpt-5.6-luna"],
        },
      ],
    });
  });

  test("a refusal, and a login with no limits, are none", () => {
    expect(codexAllowance({ id: 2, error: { message: "requires ChatGPT auth" } })).toEqual({
      read: "none",
      reason: "codex: requires ChatGPT auth",
    });
    expect(codexAllowance({ id: 2, result: { rateLimits: null } })).toEqual({
      read: "none",
      reason: "codex reported no plan limits",
    });
  });

  test("the snapshot alone, when the map by limit is empty, with both its windows", () => {
    const window = (usedPercent: number, windowDurationMins: number) => ({
      usedPercent,
      windowDurationMins,
      resetsAt: 1_791_603_259,
    });
    const read = codexAllowance({
      id: 2,
      result: {
        rateLimitsByLimitId: {},
        rateLimits: { limitId: "codex", primary: window(40, 300), secondary: window(7, 10_080) },
      },
    });
    expect(read.read === "plan" && read.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ["5h", 40],
      ["week", 7],
    ]);
  });

  test("asks the app-server and holds its stdin until the answer", async () => {
    let held: ((line: string) => boolean) | undefined;
    const run: RunProcess = async (input) => {
      held = (input as ProcessInput).holdStdinUntil;
      return {
        stdout: `{"id":1,"result":{}}\n${JSON.stringify(response)}\n`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    };
    expect((await readCodexAllowance(run)).read).toBe("plan");
    expect(held?.('{"id":1,"result":{}}')).toBe(false);
    expect(held?.('{"id":2,"result":{}}')).toBe(true);
  });

  test("no answer is none, with what the app-server said", async () => {
    const run: RunProcess = async () => ({
      stdout: "",
      stderr: "not logged in",
      exitCode: 1,
      timedOut: false,
    });
    expect(await readCodexAllowance(run)).toEqual({
      read: "none",
      reason: "codex's app-server did not answer: exited 1: not logged in",
    });
  });
});

describe("cursor's /usage", () => {
  test("reads the plan, each pool, and the day it resets", () => {
    const read = cursorAllowance(fixture("cursor-usage.screen"), RECORDED);
    expect(read.read === "plan" && { ...read, windows: read.windows.map((w) => w.id) }).toEqual({
      read: "plan",
      source: "cursor /usage",
      plan: "Team",
      windows: ["included", "auto", "api"],
    });
    const reset = read.read === "plan" ? read.windows[0]?.resetsAt : undefined;
    // The day only, at midnight where the operator is.
    expect(new Date(reset!).getDate()).toBe(21);
    expect(new Date(reset!).getHours()).toBe(0);
    expect(read.read === "plan" && read.windows[0]?.usedPercent).toBe(1);
  });

  test("a screen without the panel is none, with its last line", () => {
    expect(cursorAllowance("Cursor Agent\n → /usage\n", RECORDED)).toEqual({
      read: "none",
      reason: "cursor's /usage did not show: → /usage",
    });
  });
});
