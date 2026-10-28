import { expect, test } from "bun:test";
import { PLAIN, progressEvents, renderProgress, watchProgress } from "./progress-view";
import type { WorkflowRunSnapshot } from "./workflow-runner";

test("held for a prompt, the block draws nothing and lines go above the prompt", () => {
  const written: string[] = [];
  const logged: string[] = [];
  const progress = watchProgress("run/1", Date.now(), {
    stderr: (text) => logged.push(text),
    terminal: { write: (text) => written.push(text), color: false },
    now: Date.now,
  });
  const above: string[] = [];
  progress.hold((line) => above.push(line));
  progress.log("● investigator asks:");
  expect(above).toEqual(["● investigator asks:"]);
  expect(logged).toEqual([]);
  progress.hold(undefined);
  progress.log("after");
  expect(logged).toEqual(["after"]);
  progress.stop();
});

test("an idle agent in its window shows live until its end, on its row and once in the log", () => {
  const now = new Date(2026, 9, 28, 14, 0).getTime();
  const until = new Date(2026, 9, 28, 15, 5).getTime();
  const agent = (liveUntil?: number): WorkflowRunSnapshot["agents"][number] => ({
    key: "investigator",
    execution: { harness: "claude", model: "sonnet", placement: "pane" },
    state: "idle",
    observedAt: now,
    turns: 1,
    turn: { kind: "turn", startedAt: now - 60_000, settledAt: now - 1_000, outcome: "answered" },
    ...(liveUntil === undefined ? {} : { liveUntil }),
  });
  const snapshot = (liveUntil?: number): WorkflowRunSnapshot => ({
    state: "running",
    groups: [],
    stages: [],
    upcoming: [],
    messages: [],
    agents: [agent(liveUntil)],
  });
  const view = { name: "case", startedAt: now - 120_000, now, paint: PLAIN };
  expect(renderProgress(snapshot(until), view).at(-1)).toMatch(
    /✓ investigator .* live until 15:05$/,
  );
  // Without a window, an idle agent outside a stage isn't listed.
  expect(renderProgress(snapshot(), view)).toHaveLength(1);
  const log = { startedAt: view.startedAt, now };
  expect(progressEvents(snapshot(), snapshot(until), log)).toEqual([
    "[2:00] … investigator · live until 15:05",
  ]);
  expect(progressEvents(snapshot(until), snapshot(until), log)).toEqual([]);
});
