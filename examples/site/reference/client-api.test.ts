import { expect, test } from "bun:test";
import { fakeClient } from "agentswf/testing";
import { closeIfThere, notes, pushed } from "./client-api.driver";

test("a push that starts the run is ok; one whose launch failed throws", async () => {
  const runs = fakeClient({
    emit: (call) =>
      call.eventId === "push-bad" ? { why: "launch-failed", error: "codex: not found" } : undefined,
  });
  expect(await pushed(runs, 7, "abc")).toBe("started");
  await expect(pushed(runs, 8, "bad")).rejects.toThrow("launch-failed");
});

test("notes returns the completed run's value", async () => {
  const runs = fakeClient({
    rests: {
      "release/v1.2": [
        {
          state: "completed",
          final: true,
          ending: { kind: "completed", value: "notes", stages: [] },
        },
      ],
    },
  });
  expect(await notes(runs, "1.2")).toBe("notes");
});

test("a reply to no run is undefined, not a throw", async () => {
  expect(await closeIfThere(fakeClient(), 9)).toBeUndefined();
});
