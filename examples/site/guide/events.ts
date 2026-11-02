import { defineWorkflow, type OutputSchema } from "@agentswf/contract/workflow";
import Type from "typebox";

// #region schemas
const Failed = Type.Object(
  { pr: Type.Number(), job: Type.String(), url: Type.String() },
  { additionalProperties: false },
);
// Typed, so an event's data is typed where the workflow takes it and where a sender sends it.
export const FAILED: OutputSchema<Type.Static<typeof Failed>> = Failed;
// #endregion schemas
const Closed = Type.Object(
  { pr: Type.Number(), merged: Type.Boolean() },
  { additionalProperties: false },
);
export const CLOSED: OutputSchema<Type.Static<typeof Closed>> = Closed;
export const FIX = Type.Object(
  { commit: Type.String() },
  { additionalProperties: false },
);

// #region workflow
export default defineWorkflow({
  meta: {
    name: "ci-fix",
    description: "Fix a pull request's failing CI until it closes.",
  },
  file: import.meta.path, // where senders find the workflow, and its runs live
  events: { "ci.failed": FAILED, "pr.closed": CLOSED }, // a schema per event
  starts: ["ci.failed"], // the events that may start a run
  async run(wf) {
    const fixer = await wf.agents.open({ key: "fixer", runtime: "claude" });
    for (;;) {
      const events = await wf.receive({
        label: `waiting on CI for #${wf.runId}`,
      });
      let latest: { id: string; job: string; url: string } | undefined;
      for (const e of events) {
        if (e.name === "pr.closed")
          return { pr: e.data.pr, merged: e.data.merged };
        // Several failures in one batch: only the latest needs a fix.
        if (e.name === "ci.failed")
          latest = { id: e.id, job: e.data.job, url: e.data.url };
      }
      if (!latest) continue;
      const { id, job, url } = latest;
      await wf.stage(`fix-${id}`, async () => {
        const { outcome } = await fixer.run<Type.Static<typeof FIX>>({
          prompt:
            `CI job ${job} failed on this pull request: ${url}. ` +
            "Fix it, commit and push.",
          schema: FIX,
        });
        if (outcome.answered)
          wf.log("pushed a fix", { commit: outcome.value.commit });
        else wf.log("no fix", { reason: outcome.reason });
      });
    }
  },
});
// #endregion workflow

export const ciFixBySelect = defineWorkflow({
  meta: {
    name: "ci-fix-select",
    description: "The same loop, one event at a time.",
  },
  file: import.meta.path,
  events: { "ci.failed": FAILED, "pr.closed": CLOSED },
  starts: ["ci.failed"],
  async run(wf) {
    const fixer = await wf.agents.open({ key: "fixer", runtime: "claude" });
    // #region select
    for await (const next of wf.select(
      { failed: wf.signal("ci.failed"), closed: wf.signal("pr.closed") },
      { label: `waiting on CI for #${wf.runId}` },
    )) {
      if (next.closed)
        return { pr: next.closed.data.pr, merged: next.closed.data.merged };
      if (next.failed) {
        const { job, url } = next.failed.data;
        await wf.stage(`fix-${next.failed.id}`, async () => {
          await fixer.run({
            prompt: `CI job ${job} failed: ${url}. Fix it, commit and push.`,
          });
        });
      }
    }
    // #endregion select
    return null;
  },
});

export const ciFixByRace = defineWorkflow({
  meta: {
    name: "ci-fix-race",
    description: "One fix, cut short if the pull request closes first.",
  },
  file: import.meta.path,
  events: { "ci.failed": FAILED, "pr.closed": CLOSED },
  starts: ["ci.failed"],
  async run(wf) {
    const failed = wf.started;
    if (failed?.name !== "ci.failed")
      return wf.stop("send ci.failed to start it");
    const fixer = await wf.agents.open({ key: "fixer", runtime: "claude" });
    // #region race
    const fix = await fixer.start({
      prompt: `CI job ${failed.data.job} failed: ${failed.data.url}. Fix it, commit and push.`,
    });
    const first = await wf.race(
      "fix-or-close",
      { fixed: fix, closed: wf.signal("pr.closed") },
      { label: `fixing #${failed.data.pr}` },
    );
    if (first.closed) {
      await fix.cancel("the pull request closed");
      return { pr: first.closed.data.pr, fix: "cancelled" };
    }
    return { pr: failed.data.pr, fix: first.fixed.outcome.kind };
    // #endregion race
  },
});
