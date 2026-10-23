import { expect, test } from "bun:test";
import { watchProgress } from "./progress-view";

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
