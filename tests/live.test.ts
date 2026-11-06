import { afterEach, expect, spyOn, test } from "bun:test";
import type { OutputRecord } from "../packages/contract/src/records";
import { recorded, report } from "./live";

const exitCode = process.exitCode;
afterEach(() => {
  process.exitCode = exitCode;
});

function printed(run: () => void): string {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    run();
    return log.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    log.mockRestore();
  }
}

test("a summary is one JSON object, ok and failed first, as bun run eval reads it", () => {
  const record = {
    artifacts: "/runs/1",
    accounting: { totals: { estimate: 0.12 } },
  } as unknown as OutputRecord;
  const text = printed(() => report([], { checks: [1], ...recorded(record) }));
  expect(text.startsWith("{\n")).toBe(true);
  expect(Object.entries(JSON.parse(text))).toEqual([
    ["ok", true],
    ["failed", []],
    ["checks", [1]],
    ["estimateUsd", 0.12],
    ["artifacts", "/runs/1"],
  ]);
  expect(process.exitCode).toBe(exitCode);
});

test("a problem fails the summary and the process", () => {
  const text = printed(() => report(["codex: 1 of 2 right"], recorded(undefined)));
  expect(JSON.parse(text)).toEqual({ ok: false, failed: ["codex: 1 of 2 right"] });
  expect(process.exitCode).toBe(1);
});
