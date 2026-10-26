import { describe, expect, test } from "bun:test";
import { ITEMS } from "../examples/tools/workflow";
import type { OutputRecord, RunLogLine } from "../packages/contract/src/records";
import { firstTry, problems, slowProblems } from "./tools.eval";

/** A record with only the fields the checks read. */
const line = (fields: object) => fields as RunLogLine;

const triage = (runtime: string, backup: Record<string, unknown> = {}) => ({
  runtime,
  outcome: "answered",
  summary: "Closed 2.",
  items: [
    { id: "a1", title: ITEMS[0]!.title, status: "done", why: "Fixed." },
    {
      id: "b2",
      title: ITEMS[1]!.title,
      status: "wontfix",
      why: ITEMS[1]!.title,
      labels: ["ops", "cron"],
      ...backup,
    },
  ],
});
const record = (...triages: object[]) =>
  ({ outcome: "completed", value: { triages } }) as unknown as OutputRecord;

describe("the tools eval's checks", () => {
  test("a right triage passes; a wrong reason, missing labels or a missing runtime don't", () => {
    expect(problems(0, record(triage("codex")), ["codex"])).toEqual([]);
    expect(
      problems(0, record(triage("codex", { why: "it's /Users/me/backup", labels: ["ops"] })), [
        "codex",
        "pi",
      ]),
    ).toEqual([
      'codex: backup reason "it\'s /Users/me/backup", not the title',
      'codex: backup labels ["ops"]',
      "pi: no triage",
    ]);
    expect(problems(1, undefined, ["codex"])).toEqual([
      "run did not succeed: exit 1, outcome missing",
    ]);
  });

  test("a slow call must run once, for its whole time, and never be refused", () => {
    const ended = (durationMs: number) =>
      line({ kind: "tool-ended", tool: "list_open", durationMs });
    expect(slowProblems([ended(15_000)], 15_000)).toEqual([]);
    expect(
      slowProblems(
        [
          line({ kind: "tool-refused", tool: "list_open", code: "tool-busy" }),
          ended(15_000),
          ended(15_000),
        ],
        15_000,
      ),
    ).toEqual(["list_open ran 2 times", "refused: list_open tool-busy"]);
    // Listing again once it has closed an item is fine.
    const closing = line({ kind: "tool-called", tool: "close_item" });
    expect(slowProblems([ended(15_000), closing, ended(15_000)], 15_000)).toEqual([]);
  });

  test("first try counts refused and failed calls, and rejected results, per agent", () => {
    const lines = [
      { kind: "operation-started", agent: "a", operationId: "op" },
      { kind: "tool-called", agent: "a", tool: "close_item" },
      { kind: "tool-refused", agent: "a", tool: "close_item", code: "invalid-input" },
      { kind: "tool-ended", agent: "a", tool: "close_item", outcome: "failed" },
    ].map(line);
    expect(firstTry(lines, new Map([["op", 2]]))).toEqual({
      a: {
        calls: 1,
        refused: ["close_item:invalid-input"],
        failed: ["close_item:failed"],
        results: 2,
      },
    });
  });
});
