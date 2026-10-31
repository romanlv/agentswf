import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import nudges, { Nudge } from "./workflow";

const asked = {
  name: "question.asked" as const,
  data: { question: "Is the index unique?", nudgeAfter: "4h", putOff: "1d", maxNudges: 3 },
};
const writer = answer(Nudge, { text: "Any thoughts on the index?" });
const reply = (during: string, text: string) => ({
  during,
  name: "participant:reply" as const,
  from: "engineer",
  data: { text },
});
const HOUR = 3_600_000;
/** When each nudge went out, in hours from the first, as the run's clock had it. */
const nudgedAt = (run: Awaited<ReturnType<typeof testWorkflow>>) => {
  const posts = run.mailbox.filter((r) => r.kind === "event" && r.name === "at:due");
  const first = Date.parse(posts[0]?.at ?? "");
  return posts.map((r) => Math.round((Date.parse(r.at) - first) / HOUR));
};

describe("nudges", () => {
  test("nudges every four hours, and gives up after the third", async () => {
    const run = await testWorkflow(nudges, { id: "q1", event: asked, agents: { writer } });
    expect(run.value).toEqual({ answer: null, nudges: 3 });
    expect(run.turnsOf("writer")).toHaveLength(3);
    expect(nudgedAt(run)).toEqual([0, 4, 8]);
  });

  test("a reply of later puts the next nudge off a day, and an answer ends it", async () => {
    const run = await testWorkflow(nudges, {
      id: "q1",
      event: asked,
      agents: { writer },
      events: [reply("writer#1", "later, in a meeting"), reply("writer#2", "Yes, it is unique.")],
    });
    expect(run.value).toEqual({ answer: "Yes, it is unique.", nudges: 2 });
    // The second nudge came a day after the "later", not four hours after the first.
    expect(nudgedAt(run)).toEqual([0, 24]);
  });

  test("it parks until the next nudge the ledger holds", async () => {
    const run = await testWorkflow(nudges, {
      id: "q1",
      event: asked,
      agents: { writer },
      maxTimers: 0,
    });
    expect(run.parked?.label).toBe("awaiting an answer, 0 nudged");
    expect(run.parked?.until).toBeDefined();
  });
});
