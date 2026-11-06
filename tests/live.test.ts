import { expect, spyOn, test } from "bun:test";
import type { OutputRecord } from "../packages/contract/src/records";
import { recorded, report } from "./live";

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
  let failed = false;
  const text = printed(() =>
    report([], { checks: [1], ...recorded(record) }, () => {
      failed = true;
    }),
  );
  expect(text.startsWith("{\n")).toBe(true);
  expect(Object.entries(JSON.parse(text))).toEqual([
    ["ok", true],
    ["failed", []],
    ["checks", [1]],
    ["estimateUsd", 0.12],
    ["artifacts", "/runs/1"],
  ]);
  expect(failed).toBe(false);
});

test("a problem fails the summary and the process", () => {
  let failed = false;
  const text = printed(() =>
    report(["codex: 1 of 2 right"], recorded(undefined), () => {
      failed = true;
    }),
  );
  expect(JSON.parse(text)).toEqual({ ok: false, failed: ["codex: 1 of 2 right"] });
  expect(failed).toBe(true);
});
