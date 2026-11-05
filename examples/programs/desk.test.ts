import { expect, test } from "bun:test";
import { fakeClient } from "agentswf/testing";
import { closeGlossary, defineTerms, eventIdOf, summarize } from "./desk.driver";

const post = (n: number, text: string) => ({
  v: 1 as const,
  ref: "glossary/g1",
  at: "2026-11-05T10:00:00.000Z",
  cursor: `c${n}`,
  kind: "post" as const,
  participant: "thread",
  id: `1.p${n}`,
  from: "writer",
  text,
});

test("each term is sent, its run waited on until it parks, and what it posted relayed once", async () => {
  const posts = [post(1, "idempotent: …"), post(2, "backpressure: …")];
  const runs = fakeClient({
    rests: {
      "glossary/g1": [
        { state: "parked", final: false },
        { state: "parked", final: false },
      ],
    },
    // Each read returns what comes after its cursor, as the real inbox does.
    inbox: ({ after }) => posts.filter((each) => after === undefined || each.cursor > after),
  });
  const relayed: string[] = [];
  const definitions = await defineTerms(runs, "g1", ["idempotent", "backpressure"], (text) =>
    relayed.push(text),
  );
  expect(definitions).toEqual(["idempotent: …", "backpressure: …"]);
  expect(relayed).toEqual(definitions);
  expect(
    runs.calls.filter((call) => call.kind === "emit").map((call) => [call.data, call.eventId]),
  ).toEqual([
    [{ term: "idempotent" }, "term-idempotent"],
    [{ term: "backpressure" }, "term-backpressure"],
  ]);
});

test("a run that didn't launch is an error, not a wait", async () => {
  const runs = fakeClient({
    emit: () => ({ why: "launch-failed", error: "codex: not found" }),
  });
  await expect(defineTerms(runs, "g1", ["idempotent"], () => {})).rejects.toThrow(
    "codex: not found",
  );
});

test("closing waits until the run has returned", async () => {
  const runs = fakeClient({
    rests: {
      "glossary/g1": [
        { state: "parked", final: false },
        {
          state: "completed",
          final: true,
          ending: { kind: "completed", value: "closed", stages: [] },
        },
      ],
    },
  });
  await defineTerms(runs, "g1", ["idempotent"], () => {});
  expect(await closeGlossary(runs, "g1")).toMatchObject({ state: "completed", final: true });
});

test("the summary is started with the definitions as its args, and waited on until final", async () => {
  const runs = fakeClient({
    rests: {
      "glossary-summary/g1": [
        {
          state: "completed",
          final: true,
          ending: { kind: "completed", value: "A paragraph.", stages: [] },
        },
      ],
    },
  });
  const done = await summarize(runs, "g1", ["idempotent: …"]);
  expect(done.ending).toMatchObject({ kind: "completed", value: "A paragraph." });
  expect(runs.calls).toContainEqual({
    kind: "start",
    workflow: "glossary-summary",
    args: { definitions: ["idempotent: …"] },
    ref: "glossary-summary/g1",
  });
});

test("a term that isn't an id's grammar is hashed, the same each time", () => {
  expect(eventIdOf("Back Pressure")).toBe("term-back-pressure");
  expect(eventIdOf("日本語")).toBe(eventIdOf("日本語"));
  expect(eventIdOf("日本語")).toMatch(/^term-[0-9a-f]{32}$/);
});
